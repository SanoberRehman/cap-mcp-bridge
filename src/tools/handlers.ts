/**
 * Tool handlers: the logic behind every tool, independent of how (or under what name) it is
 * registered with MCP. Generic and per-entity tools both call into these.
 *
 * Handlers return plain JSON and throw BridgeError subclasses; the registration layer turns both
 * into MCP results.
 */

import type { EntitySet, Operation, Property, ServiceModel } from "../metadata/model.js";
import { findEntitySet, findEntitySetForType } from "../metadata/model.js";
import { literalKind, formatLiteral, checkLiteral, toJsonValue } from "../metadata/types.js";
import type { KeyInput } from "../odata/keys.js";
import { buildKeyPredicate } from "../odata/keys.js";
import type { QueryInput } from "../odata/query.js";
import { buildFilterString, buildQuery, requireEntitySet } from "../odata/query.js";
import { redactRows, shapeCollection } from "../odata/response.js";
import type { CollectionEnvelope } from "../odata/response.js";
import { validateExpand, validateSelect } from "../odata/validate.js";
import { ValidationError } from "../util/errors.js";
import { log } from "../util/log.js";
import type { ToolContext } from "./context.js";
import { visibleEntitySets } from "./context.js";
import { describeEntity, describeOperation, isDraftInternal } from "./describe.js";
import type { EntityDescription, OperationDescription } from "./describe.js";

/* ------------------------------------------------------------------ */
/* list / describe / refresh                                            */
/* ------------------------------------------------------------------ */

export interface EntitySetSummary {
  name: string;
  label?: string;
  description?: string;
  entityType: string;
  keys: string[];
  recordCount: number | null;
  draftEnabled: boolean;
  capabilities: { insertable: boolean; updatable: boolean; deletable: boolean };
  navigations: string[];
}

export async function listEntitySets(tc: ToolContext, opts: { includeCounts?: boolean | undefined } = {}): Promise<{
  service: string;
  entitySets: EntitySetSummary[];
  functions: string[];
  actions: string[];
  writeEnabled: boolean;
}> {
  const model = await tc.bridge.metadata.get();
  const sets = visibleEntitySets(model, tc);
  const includeCounts = opts.includeCounts ?? true;
  const counts = includeCounts ? await fetchCounts(tc, model, sets) : new Map<string, number | null>();

  return {
    service: model.serviceUrl,
    entitySets: sets.map((s) => {
      const summary: EntitySetSummary = {
        name: s.name,
        entityType: s.entityType,
        keys: s.keys.map((k) => k.name),
        recordCount: counts.get(s.name) ?? null,
        draftEnabled: s.draftEnabled,
        capabilities: {
          insertable: s.capabilities.insertable,
          updatable: s.capabilities.updatable,
          deletable: s.capabilities.deletable,
        },
        navigations: s.navigations.map((n) => n.name),
      };
      if (s.label) summary.label = s.label;
      if (s.description) summary.description = s.description;
      return summary;
    }),
    functions: model.functions.filter((f) => !f.isBound).map((f) => f.name),
    actions: model.actions.filter((a) => !a.isBound && !isDraftInternal(a)).map((a) => a.name),
    writeEnabled: tc.bridge.config.writeEnabled,
  };
}

/** `Set/$count` for each set, a few at a time, failing soft to null. */
async function fetchCounts(tc: ToolContext, model: ServiceModel, sets: EntitySet[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const queue = [...sets];
  const worker = async (): Promise<void> => {
    for (let set = queue.shift(); set; set = queue.shift()) {
      try {
        const { filter } = buildFilterString(model, set, undefined, { visibility: tc.visibility });
        const query: Record<string, string> = {};
        if (filter) query["$filter"] = filter;
        const res = await tc.bridge.http.request<unknown>({
          method: "GET",
          path: `${set.name}/$count`,
          query,
          headers: { Accept: "text/plain, application/json" },
        });
        const n = Number(typeof res.data === "string" ? res.data.trim() : res.data);
        out.set(set.name, Number.isFinite(n) ? n : null);
      } catch (e) {
        log.debug(`count failed for ${set.name}: ${(e as Error).message}`);
        out.set(set.name, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, sets.length) }, worker));
  return out;
}

export async function describeEntitySet(tc: ToolContext, entitySet: string): Promise<EntityDescription> {
  const model = await tc.bridge.metadata.get();
  const set = requireEntitySet(model, entitySet, tc.visibility);
  return describeEntity(model, set);
}

export async function refreshMetadata(tc: ToolContext): Promise<{
  service: string;
  fetchedAt: string;
  entitySets: number;
  functions: number;
  actions: number;
  added: string[];
  removed: string[];
}> {
  const before = tc.bridge.metadata.peek();
  const model = await tc.bridge.metadata.refresh();
  const beforeNames = new Set((before?.entitySets ?? []).map((s) => s.name));
  const afterNames = new Set(model.entitySets.map((s) => s.name));
  return {
    service: model.serviceUrl,
    fetchedAt: model.fetchedAt.toISOString(),
    entitySets: model.entitySets.length,
    functions: model.functions.length,
    actions: model.actions.length,
    added: [...afterNames].filter((n) => !beforeNames.has(n)),
    removed: [...beforeNames].filter((n) => !afterNames.has(n)),
  };
}

/* ------------------------------------------------------------------ */
/* query / get                                                          */
/* ------------------------------------------------------------------ */

export async function queryEntity(tc: ToolContext, input: QueryInput): Promise<CollectionEnvelope> {
  const model = await tc.bridge.metadata.get();
  const { defaultTop, maxTop, maxResponseBytes } = tc.bridge.config;
  const built = buildQuery(model, input, { defaultTop, maxTop }, tc.visibility);
  const res = await tc.bridge.http.request<unknown>({ method: "GET", path: built.path, query: built.query });
  return shapeCollection(model, res.data, {
    set: built.set,
    skip: built.skip,
    top: built.top,
    topClamped: built.topClamped,
    maxBytes: maxResponseBytes,
    draftFilterApplied: built.draftFilterApplied,
    policy: tc.policy,
  });
}

export interface GetInput {
  entitySet: string;
  key: KeyInput;
  select?: string[] | undefined;
  expand?: string[] | undefined;
  includeDrafts?: boolean | undefined;
}

export async function getEntity(tc: ToolContext, input: GetInput): Promise<{ entitySet: string; key: Record<string, unknown>; record: unknown }> {
  const model = await tc.bridge.metadata.get();
  const set = requireEntitySet(model, input.entitySet, tc.visibility);
  const key = buildKeyPredicate(set, input.key, { includeDrafts: input.includeDrafts ?? false });
  const query: Record<string, string> = {};
  if (input.select && input.select.length > 0) {
    validateSelect(model, set, input.select);
    const keys = set.keys.map((k) => k.name).filter((k) => !input.select?.includes(k));
    query["$select"] = [...input.select, ...keys].join(",");
  }
  if (input.expand && input.expand.length > 0) {
    const resolved = validateExpand(model, set, input.expand, tc.visibility);
    query["$expand"] = resolved.map((r) => r.segments.reduceRight((acc, seg) => (acc ? `${seg}($expand=${acc})` : seg), "")).join(",");
  }
  const res = await tc.bridge.http.request<unknown>({ method: "GET", path: `${set.name}${key.predicate}`, query });
  return { entitySet: set.name, key: key.values, record: redactRows(model, set, stripOData(res.data), tc.policy) };
}

/* ------------------------------------------------------------------ */
/* create / update / delete                                             */
/* ------------------------------------------------------------------ */

export async function createEntity(tc: ToolContext, input: { entitySet: string; data: Record<string, unknown> }): Promise<{ entitySet: string; created: unknown }> {
  const model = await tc.bridge.metadata.get();
  const set = requireEntitySet(model, input.entitySet, tc.visibility);
  if (!set.capabilities.insertable) {
    throw new ValidationError({ code: "not_insertable", message: `${set.name} does not allow inserts (Capabilities.InsertRestrictions).`, target: set.name });
  }
  const body = prepareBody(set, input.data, "create");
  const res = await tc.bridge.http.request<unknown>({ method: "POST", path: set.name, body });
  return { entitySet: set.name, created: redactRows(model, set, stripOData(res.data), tc.policy) };
}

export async function updateEntity(
  tc: ToolContext,
  input: { entitySet: string; key: KeyInput; data: Record<string, unknown>; includeDrafts?: boolean | undefined },
): Promise<{ entitySet: string; key: Record<string, unknown>; updated: unknown }> {
  const model = await tc.bridge.metadata.get();
  const set = requireEntitySet(model, input.entitySet, tc.visibility);
  if (!set.capabilities.updatable) {
    throw new ValidationError({ code: "not_updatable", message: `${set.name} does not allow updates (Capabilities.UpdateRestrictions).`, target: set.name });
  }
  const key = buildKeyPredicate(set, input.key, { includeDrafts: input.includeDrafts ?? false });
  const body = prepareBody(set, input.data, "update");
  const res = await tc.bridge.http.request<unknown>({
    method: "PATCH",
    path: `${set.name}${key.predicate}`,
    body,
    headers: { Prefer: "return=representation" },
  });
  const updated = res.status === 204 ? { ...key.values, ...body } : redactRows(model, set, stripOData(res.data), tc.policy);
  return { entitySet: set.name, key: key.values, updated };
}

export async function deleteEntity(
  tc: ToolContext,
  input: { entitySet: string; key: KeyInput; includeDrafts?: boolean | undefined },
): Promise<{ entitySet: string; key: Record<string, unknown>; deleted: true }> {
  const model = await tc.bridge.metadata.get();
  const set = requireEntitySet(model, input.entitySet, tc.visibility);
  if (!set.capabilities.deletable) {
    throw new ValidationError({ code: "not_deletable", message: `${set.name} does not allow deletes (Capabilities.DeleteRestrictions).`, target: set.name });
  }
  const key = buildKeyPredicate(set, input.key, { includeDrafts: input.includeDrafts ?? false });
  await tc.bridge.http.request<unknown>({ method: "DELETE", path: `${set.name}${key.predicate}` });
  return { entitySet: set.name, key: key.values, deleted: true };
}

/**
 * Validate a create/update payload against the entity's schema and coerce values to the JSON
 * form the service expects (decimals as strings, numeric strings as numbers, ...).
 */
export function prepareBody(set: EntitySet, data: Record<string, unknown>, mode: "create" | "update"): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ValidationError({ code: "invalid_body", message: `data must be an object of property values for ${set.name}.`, target: set.name });
  }
  const props = new Map(set.properties.map((p) => [p.name, p]));
  const navs = new Set(set.navigations.map((n) => n.name));
  const writable = set.properties.filter((p) => !p.readOnly && !(mode === "update" && p.isKey)).map((p) => p.name);
  const out: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(data)) {
    if (navs.has(name)) {
      out[name] = value; // deep insert / nested composition: passed through, the service validates
      continue;
    }
    const prop = props.get(name);
    if (!prop) {
      throw new ValidationError({
        code: "unknown_field",
        message: `"${name}" is not a property of ${set.name}.`,
        target: name,
        validOptions: writable,
      });
    }
    if (prop.readOnly) {
      throw new ValidationError({
        code: "read_only_field",
        message: `"${name}" on ${set.name} is read-only (computed by the service) and cannot be set.`,
        target: name,
        validOptions: writable,
      });
    }
    if (mode === "update" && prop.isKey) {
      throw new ValidationError({ code: "read_only_field", message: `Key "${name}" cannot be changed with update; delete and recreate instead.`, target: name });
    }
    out[name] = coerceValue(prop, value, name, set.name);
  }

  if (mode === "create") {
    const missing = set.properties.filter((p) => p.mandatory && !p.readOnly && data[p.name] === undefined && p.defaultValue === undefined);
    if (missing.length > 0) {
      throw new ValidationError({
        code: "missing_mandatory",
        message: `Missing mandatory field${missing.length > 1 ? "s" : ""} for ${set.name}: ${missing.map((p) => p.name).join(", ")}.`,
        target: set.name,
        validOptions: missing.map((p) => p.name),
      });
    }
  }
  return out;
}

function coerceValue(prop: Property, value: unknown, name: string, setName: string): unknown {
  if (value === null || value === undefined) {
    if (!prop.nullable && !prop.isKey) {
      throw new ValidationError({ code: "invalid_value", message: `"${name}" on ${setName} is not nullable.`, target: name });
    }
    return null;
  }
  if (prop.isCollection || prop.complexType) return value;
  const kind = literalKind(prop.type, { isEnum: Boolean(prop.enumType) });
  const check = checkLiteral(kind, value);
  if (!check.ok) {
    throw new ValidationError({
      code: "invalid_value",
      message: `"${name}" on ${setName} is ${prop.type}; value ${JSON.stringify(value)} is not valid: expected ${check.expected}.`,
      target: name,
    });
  }
  if (prop.maxLength !== undefined && typeof value === "string" && value.length > prop.maxLength) {
    throw new ValidationError({ code: "invalid_value", message: `"${name}" on ${setName} allows at most ${prop.maxLength} characters (got ${value.length}).`, target: name });
  }
  return toJsonValue(kind, value);
}

/* ------------------------------------------------------------------ */
/* functions / actions                                                  */
/* ------------------------------------------------------------------ */

export interface InvokeInput {
  name: string;
  parameters?: Record<string, unknown> | undefined;
  /** Required for bound operations: which record (or collection) to call it on. */
  boundTo?: { entitySet: string; key?: KeyInput | undefined } | undefined;
}

export async function listOperations(tc: ToolContext, kind: "action" | "function"): Promise<OperationDescription[]> {
  const model = await tc.bridge.metadata.get();
  return operationsOf(model, kind, tc).map(describeOperation);
}

function operationsOf(model: ServiceModel, kind: "action" | "function", tc: ToolContext): Operation[] {
  const list = kind === "action" ? model.actions : model.functions;
  return list.filter((op) => {
    if (isDraftInternal(op)) return false;
    if (!op.boundTo) return true;
    const set = findEntitySetForType(model, op.boundTo.entityType);
    return set ? tc.visibility.isVisible(set.name) : true;
  });
}

export async function invokeOperation(tc: ToolContext, kind: "action" | "function", input: InvokeInput): Promise<{ operation: string; kind: string; result: unknown }> {
  const model = await tc.bridge.metadata.get();
  const candidates = operationsOf(model, kind, tc);
  const matches = candidates.filter((op) => op.name === input.name || op.qualifiedName === input.name || op.qualifiedName.endsWith(`.${input.name}`));
  if (matches.length === 0) {
    throw new ValidationError({
      code: `unknown_${kind}`,
      message: `${kind === "action" ? "Action" : "Function"} "${input.name}" does not exist.`,
      target: input.name,
      validOptions: candidates.map((op) => (op.isBound ? `${op.qualifiedName} (bound to ${findEntitySetForType(model, op.boundTo?.entityType ?? "")?.name ?? op.boundTo?.entityType})` : op.name)),
    });
  }

  // Prefer the overload matching the boundTo entity set, else the unbound one.
  let op = matches.find((m) => !m.isBound);
  if (input.boundTo) {
    const set = requireEntitySet(model, input.boundTo.entitySet, tc.visibility);
    op = matches.find((m) => m.isBound && m.boundTo?.entityType === set.entityType) ?? op;
  }
  if (!op) op = matches[0] as Operation;

  const params = input.parameters ?? {};
  const known = new Set(op.parameters.map((p) => p.name));
  for (const name of Object.keys(params)) {
    if (!known.has(name)) {
      throw new ValidationError({
        code: "unknown_parameter",
        message: `"${name}" is not a parameter of ${op.name}.`,
        target: name,
        validOptions: op.parameters.map((p) => p.name),
      });
    }
  }
  const missing = op.parameters.filter((p) => !p.nullable && params[p.name] === undefined).map((p) => p.name);
  if (missing.length > 0) {
    throw new ValidationError({ code: "missing_parameter", message: `${op.name} requires parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`, target: op.name, validOptions: missing });
  }

  let path: string;
  if (op.isBound) {
    if (!input.boundTo) {
      const set = findEntitySetForType(model, op.boundTo?.entityType ?? "");
      throw new ValidationError({
        code: "missing_binding",
        message: `${op.qualifiedName} is bound to ${set?.name ?? op.boundTo?.entityType}; pass boundTo: { entitySet${op.boundTo?.isCollection ? "" : ", key"} }.`,
        target: op.name,
      });
    }
    const set = requireEntitySet(model, input.boundTo.entitySet, tc.visibility);
    if (op.boundTo?.isCollection) {
      path = `${set.name}/${op.qualifiedName}`;
    } else {
      if (input.boundTo.key === undefined) {
        throw new ValidationError({ code: "missing_binding", message: `${op.qualifiedName} is bound to a single ${set.name} record; pass boundTo.key.`, target: op.name });
      }
      path = `${set.name}${buildKeyPredicate(set, input.boundTo.key).predicate}/${op.qualifiedName}`;
    }
  } else {
    path = op.name;
  }

  let data: unknown;
  if (kind === "function") {
    const inline = op.parameters
      .filter((p) => params[p.name] !== undefined)
      .map((p) => `${p.name}=${functionLiteral(p.name, p.type, params[p.name], op)}`)
      .join(",");
    const res = await tc.bridge.http.request<unknown>({ method: "GET", path: `${path}(${inline})` });
    data = res.data;
  } else {
    const body: Record<string, unknown> = {};
    for (const p of op.parameters) {
      if (params[p.name] === undefined) continue;
      const kindOfParam = literalKind(p.type);
      body[p.name] = p.isCollection ? params[p.name] : toJsonValue(kindOfParam, params[p.name]);
    }
    const res = await tc.bridge.http.request<unknown>({ method: "POST", path, body });
    data = res.data;
  }

  const returnSet = op.returnType ? findEntitySetForType(model, op.returnType.type) ?? findEntitySet(model, op.returnType.type) : undefined;
  const result = stripOData(data);
  return { operation: op.name, kind, result: returnSet ? redactRows(model, returnSet, result, tc.policy) : result };
}

function functionLiteral(name: string, type: string, value: unknown, op: Operation): string {
  const kind = literalKind(type);
  const check = checkLiteral(kind, value);
  if (!check.ok) {
    throw new ValidationError({ code: "invalid_parameter", message: `Parameter "${name}" of ${op.name} is ${type}; value ${JSON.stringify(value)} is not valid: expected ${check.expected}.`, target: name });
  }
  return formatLiteral(kind, value);
}

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

/** Remove `@odata.*` control information so responses are just data. Unwraps `{ value: ... }` for single results. */
export function stripOData(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(stripOData);
  if (!data || typeof data !== "object") return data;
  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length > 0 && keys.every((k) => k === "value" || k.startsWith("@odata"))) {
    return stripOData(obj["value"]);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("@odata") || k.includes("@odata.")) continue;
    out[k] = v && typeof v === "object" ? stripOData(v) : v;
  }
  return out;
}
