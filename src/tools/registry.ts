/**
 * Registers tools and resources on an McpServer for one ServiceModel, in either generic or
 * per-entity mode, and can rebuild the entity tools after a metadata refresh.
 */

import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { EntitySet, ServiceModel } from "../metadata/model.js";
import { toStructuredError } from "../util/errors.js";
import { log } from "../util/log.js";
import type { ToolContext } from "./context.js";
import { toolName, visibleEntitySets } from "./context.js";
import { describeEntity, entitySetLine, navigationSummary, propertySummary } from "./describe.js";
import * as h from "./handlers.js";
import { KeySchema, querySchema, typedDataSchema, typedQuerySchema } from "./schemas.js";

export type ToolMode = "generic" | "per-entity";

export interface RegisteredBridge {
  mode: ToolMode;
  /** Names of every tool currently registered. */
  toolNames(): string[];
  /** Re-read the model and re-register entity tools if the set of entities changed. */
  rebuild(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Result formatting                                                    */
/* ------------------------------------------------------------------ */

export function okResult(result: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
}

export function errorResult(err: unknown): CallToolResult {
  const structured = toStructuredError(err);
  return { content: [{ type: "text", text: JSON.stringify({ error: structured }, null, 1) }], isError: true };
}

function wrap<A>(name: string, fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return okResult(await fn(args));
    } catch (err) {
      const structured = toStructuredError(err);
      log.warn(`${name} failed: ${structured.code}: ${structured.message}`);
      return errorResult(err);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Registration                                                         */
/* ------------------------------------------------------------------ */

export function decideMode(model: ServiceModel, tc: ToolContext): ToolMode {
  const { toolMode, perEntityThreshold } = tc.bridge.config;
  if (toolMode !== "auto") return toolMode;
  return visibleEntitySets(model, tc).length <= perEntityThreshold ? "per-entity" : "generic";
}

export async function registerBridge(server: McpServer, tc: ToolContext): Promise<RegisteredBridge> {
  let model = await tc.bridge.metadata.get();
  let mode = decideMode(model, tc);
  const write = tc.bridge.config.writeEnabled;
  const maxTop = tc.bridge.config.maxTop;

  const registered = new Map<string, RegisteredTool>();
  const add = (name: string, tool: RegisteredTool): void => {
    registered.set(name, tool);
  };

  /* ---- always-on tools ---- */

  add(
    "list_entity_sets",
    server.registerTool(
      "list_entity_sets",
      {
        title: "List entity sets",
        description:
          `List every entity set exposed by ${model.serviceUrl}: name, label, description, keys, record count, ` +
          `draft flag, write capabilities and navigations. Also lists unbound functions and actions. ` +
          `Call describe_entity for the full schema of one entity set.`,
        inputSchema: {
          includeCounts: z.boolean().optional().describe("Fetch record counts (default true; set false on slow services)"),
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      wrap("list_entity_sets", (args: { includeCounts?: boolean | undefined }) => h.listEntitySets(tc, args)),
    ),
  );

  add(
    "describe_entity",
    server.registerTool(
      "describe_entity",
      {
        title: "Describe entity",
        description:
          "Full schema for one entity set: properties with types, labels, keys, nullability, which are filterable/sortable, " +
          "navigations with targets, bound actions/functions, and hints such as draft handling and redacted fields. " +
          "The same information is available as the resource cap://entity/{name}.",
        inputSchema: { entitySet: z.string().describe(`One of: ${visibleEntitySets(model, tc).map((s) => s.name).join(", ")}`) },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      wrap("describe_entity", (args: { entitySet: string }) => h.describeEntitySet(tc, args.entitySet)),
    ),
  );

  add(
    "invoke_function",
    server.registerTool(
      "invoke_function",
      {
        title: "Invoke function",
        description:
          "Call a read-only OData function. Unbound functions are called by name; bound functions need boundTo { entitySet, key }. " +
          "Available: " +
          (await h.listOperations(tc, "function")).map(opLine).join("; "),
        inputSchema: {
          name: z.string().describe("Function name"),
          parameters: z.record(z.string(), z.unknown()).optional().describe("Parameter values by name"),
          boundTo: z.object({ entitySet: z.string(), key: KeySchema.optional() }).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      wrap("invoke_function", (args: h.InvokeInput) => h.invokeOperation(tc, "function", args)),
    ),
  );

  if (write) {
    add(
      "invoke_action",
      server.registerTool(
        "invoke_action",
        {
          title: "Invoke action",
          description:
            "Call an OData action (may change data). Unbound actions are called by name; bound actions need boundTo { entitySet, key }. " +
            "Available: " +
            (await h.listOperations(tc, "action")).map(opLine).join("; "),
          inputSchema: {
            name: z.string().describe("Action name"),
            parameters: z.record(z.string(), z.unknown()).optional().describe("Parameter values by name"),
            boundTo: z.object({ entitySet: z.string(), key: KeySchema.optional() }).optional(),
          },
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
        wrap("invoke_action", (args: h.InvokeInput) => h.invokeOperation(tc, "action", args)),
      ),
    );
  }

  /* ---- entity tools (generic or per-entity), rebuilt on refresh ---- */

  const entityTools = new Map<string, RegisteredTool>();
  const registerEntityTools = (): void => {
    if (mode === "generic") registerGeneric(server, tc, model, entityTools, write, maxTop);
    else registerPerEntity(server, tc, model, entityTools, write, maxTop);
    for (const [name, tool] of entityTools) registered.set(name, tool);
  };
  registerEntityTools();

  const rebuild = async (): Promise<void> => {
    const fresh = await tc.bridge.metadata.get();
    const before = visibleEntitySets(model, tc).map((s) => s.name).join(",");
    const after = visibleEntitySets(fresh, tc).map((s) => s.name).join(",");
    model = fresh;
    const newMode = decideMode(model, tc);
    if (before === after && newMode === mode) return;
    for (const [name, tool] of entityTools) {
      tool.remove();
      registered.delete(name);
    }
    entityTools.clear();
    mode = newMode;
    registerEntityTools();
    server.sendToolListChanged();
    log.info(`entity tools rebuilt after metadata refresh (${mode} mode, ${entityTools.size} tools)`);
  };

  add(
    "refresh_metadata",
    server.registerTool(
      "refresh_metadata",
      {
        title: "Refresh metadata",
        description: "Re-read $metadata from the service (after a redeploy). Reports added/removed entity sets and re-registers tools if needed.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      wrap("refresh_metadata", async () => {
        const result = await h.refreshMetadata(tc);
        await rebuild();
        return { ...result, toolMode: mode };
      }),
    ),
  );

  /* ---- resources ---- */

  registerResources(server, tc);

  return {
    get mode() {
      return mode;
    },
    toolNames: () => [...registered.keys()],
    rebuild,
  };
}

function opLine(op: { name: string; label?: string; description?: string; parameters: Array<{ name: string; type: string }> }): string {
  const params = op.parameters.map((p) => `${p.name}: ${p.type}`).join(", ");
  const doc = op.description ?? op.label;
  return `${op.name}(${params})${doc ? ` — ${doc}` : ""}`;
}

/* ------------------------------------------------------------------ */
/* Generic mode                                                         */
/* ------------------------------------------------------------------ */

function registerGeneric(server: McpServer, tc: ToolContext, model: ServiceModel, out: Map<string, RegisteredTool>, write: boolean, maxTop: number): void {
  const sets = visibleEntitySets(model, tc);
  const names = sets.map((s) => s.name).join(", ");
  const catalogue = sets.map(entitySetLine).join("\n");

  out.set(
    "query_entity",
    server.registerTool(
      "query_entity",
      {
        title: "Query entity set",
        description:
          `Query records from an entity set with filter, select, expand, orderBy and paging. Results are paged (default ${tc.bridge.config.defaultTop}, max ${maxTop}) ` +
          `and include a total count; follow nextSkip for more. Use expand to pull related records across navigations in one call. ` +
          `Call describe_entity first if unsure which fields exist.\n\nEntity sets:\n${catalogue}`,
        inputSchema: querySchema(maxTop),
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      wrap("query_entity", (args) => h.queryEntity(tc, args)),
    ),
  );

  out.set(
    "get_entity",
    server.registerTool(
      "get_entity",
      {
        title: "Get entity by key",
        description: `Fetch one record by key from an entity set (${names}). Composite keys are passed as an object.`,
        inputSchema: {
          entitySet: z.string(),
          key: KeySchema,
          select: z.array(z.string()).optional(),
          expand: z.array(z.string()).optional(),
          includeDrafts: z.boolean().optional().describe("Draft entities: address the draft row instead of the active one"),
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      wrap("get_entity", (args: h.GetInput) => h.getEntity(tc, args)),
    ),
  );

  if (!write) return;

  out.set(
    "create_entity",
    server.registerTool(
      "create_entity",
      {
        title: "Create entity",
        description: "Create a record. data is an object of property values; read-only (computed) fields are rejected, mandatory fields are required. Use describe_entity to see writable fields.",
        inputSchema: { entitySet: z.string(), data: z.record(z.string(), z.unknown()) },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      wrap("create_entity", (args: { entitySet: string; data: Record<string, unknown> }) => h.createEntity(tc, args)),
    ),
  );
  out.set(
    "update_entity",
    server.registerTool(
      "update_entity",
      {
        title: "Update entity",
        description: "Partially update a record by key (PATCH). Only the given properties change.",
        inputSchema: { entitySet: z.string(), key: KeySchema, data: z.record(z.string(), z.unknown()), includeDrafts: z.boolean().optional() },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      wrap("update_entity", (args: { entitySet: string; key: h.GetInput["key"]; data: Record<string, unknown>; includeDrafts?: boolean | undefined }) => h.updateEntity(tc, args)),
    ),
  );
  out.set(
    "delete_entity",
    server.registerTool(
      "delete_entity",
      {
        title: "Delete entity",
        description: "Delete a record by key. Irreversible.",
        inputSchema: { entitySet: z.string(), key: KeySchema, includeDrafts: z.boolean().optional() },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      wrap("delete_entity", (args: { entitySet: string; key: h.GetInput["key"]; includeDrafts?: boolean | undefined }) => h.deleteEntity(tc, args)),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Per-entity mode                                                      */
/* ------------------------------------------------------------------ */

function registerPerEntity(server: McpServer, tc: ToolContext, model: ServiceModel, out: Map<string, RegisteredTool>, write: boolean, maxTop: number): void {
  for (const set of visibleEntitySets(model, tc)) {
    const header = entitySetLine(set);
    const props = propertySummary(set);
    const navs = navigationSummary(set);

    const qName = toolName("query", set.name);
    out.set(
      qName,
      server.registerTool(
        qName,
        {
          title: `Query ${set.label ?? set.name}`,
          description:
            `${header}. Query with filter, select, expand, orderBy and paging (default ${tc.bridge.config.defaultTop}, max ${maxTop}); responses include a total count and nextSkip.\n` +
            `Properties: ${props}\n` +
            (navs ? `Navigations (expand): ${navs}\n` : "") +
            `Filterable: ${set.capabilities.filterable.join(", ")}\nSortable: ${set.capabilities.sortable.join(", ")}`,
          inputSchema: typedQuerySchema(set, maxTop),
          annotations: { readOnlyHint: true, idempotentHint: true },
        },
        wrap(qName, (args: Record<string, unknown>) => h.queryEntity(tc, { entitySet: set.name, ...(args as Omit<h.GetInput, "entitySet" | "key">) })),
      ),
    );

    const gName = toolName("get", set.name);
    out.set(
      gName,
      server.registerTool(
        gName,
        {
          title: `Get ${set.label ?? set.name}`,
          description: `Fetch one ${set.name} record by key (${set.keys.map((k) => `${k.name}: ${k.type}`).join(", ")}).${set.draftEnabled ? " Draft-enabled: IsActiveEntity defaults to true." : ""}`,
          inputSchema: keyedSchema(set, {}),
          annotations: { readOnlyHint: true, idempotentHint: true },
        },
        wrap(gName, (args: Record<string, unknown>) => h.getEntity(tc, { entitySet: set.name, ...(args as Omit<h.GetInput, "entitySet">) })),
      ),
    );

    if (!write) continue;

    if (set.capabilities.insertable) {
      const cName = toolName("create", set.name);
      out.set(
        cName,
        server.registerTool(
          cName,
          {
            title: `Create ${set.label ?? set.name}`,
            description: `Create a ${set.name} record. ${mandatoryNote(set)}`,
            inputSchema: { data: typedDataSchema(model, set, "create") },
            annotations: { readOnlyHint: false, destructiveHint: false },
          },
          wrap(cName, (args: { data: unknown }) => h.createEntity(tc, { entitySet: set.name, data: args.data as Record<string, unknown> })),
        ),
      );
    }
    if (set.capabilities.updatable) {
      const uName = toolName("update", set.name);
      out.set(
        uName,
        server.registerTool(
          uName,
          {
            title: `Update ${set.label ?? set.name}`,
            description: `Partially update a ${set.name} record by key (PATCH).`,
            inputSchema: keyedSchema(set, { data: typedDataSchema(model, set, "update") }),
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
          },
          wrap(uName, (args: Record<string, unknown>) => h.updateEntity(tc, { entitySet: set.name, ...(args as { key: h.GetInput["key"]; data: Record<string, unknown>; includeDrafts?: boolean }) })),
        ),
      );
    }
    if (set.capabilities.deletable) {
      const dName = toolName("delete", set.name);
      out.set(
        dName,
        server.registerTool(
          dName,
          {
            title: `Delete ${set.label ?? set.name}`,
            description: `Delete a ${set.name} record by key. Irreversible.`,
            inputSchema: keyedSchema(set, {}),
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
          },
          wrap(dName, (args: Record<string, unknown>) => h.deleteEntity(tc, { entitySet: set.name, ...(args as { key: h.GetInput["key"]; includeDrafts?: boolean }) })),
        ),
      );
    }
  }
}

function keyedSchema(set: EntitySet, extra: Record<string, z.ZodTypeAny>): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {
    key: KeySchema.describe(`Key: ${set.keys.map((k) => `${k.name} (${k.type})`).join(", ")}. A scalar is accepted when there is a single business key.`),
    ...extra,
  };
  if (set.navigations.length > 0) shape["expand"] = z.array(z.string()).optional().describe(`Navigations: ${set.navigations.map((n) => n.name).join(", ")}`);
  shape["select"] = z.array(z.string()).optional();
  if (set.draftEnabled) shape["includeDrafts"] = z.boolean().optional().describe("Address the draft row instead of the active one");
  return shape;
}

function mandatoryNote(set: EntitySet): string {
  const mandatory = set.properties.filter((p) => p.mandatory && !p.readOnly).map((p) => p.name);
  return mandatory.length ? `Mandatory: ${mandatory.join(", ")}.` : "";
}

/* ------------------------------------------------------------------ */
/* Resources                                                            */
/* ------------------------------------------------------------------ */

function registerResources(server: McpServer, tc: ToolContext): void {
  server.registerResource(
    "service-overview",
    "cap://service",
    {
      title: "Service overview",
      description: "Entity sets, functions and actions exposed by the bridged service",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await h.listEntitySets(tc, { includeCounts: false }), null, 1) }],
    }),
  );

  server.registerResource(
    "entity-schema",
    new ResourceTemplate("cap://entity/{name}", {
      list: async () => {
        const model = await tc.bridge.metadata.get();
        return {
          resources: visibleEntitySets(model, tc).map((s) => ({
            uri: `cap://entity/${s.name}`,
            name: s.name,
            title: s.label ?? s.name,
            description: s.description ?? `Schema of entity set ${s.name}`,
            mimeType: "application/json",
          })),
        };
      },
      complete: {
        name: async (value) => {
          const model = await tc.bridge.metadata.get();
          return visibleEntitySets(model, tc)
            .map((s) => s.name)
            .filter((n) => n.toLowerCase().startsWith(value.toLowerCase()));
        },
      },
    }),
    {
      title: "Entity schema",
      description: "Full schema of one entity set (properties, keys, navigations, capabilities)",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const model = await tc.bridge.metadata.get();
      const name = String(variables["name"] ?? "");
      const set = visibleEntitySets(model, tc).find((s) => s.name === name);
      if (!set) {
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: { code: "unknown_entity_set", message: `No entity set named ${name}` } }) }] };
      }
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(describeEntity(model, set), null, 1) }] };
    },
  );
}
