/**
 * zod input schemas for tools. The generic shapes take strings; the per-entity factory narrows
 * them to enums of real property / navigation names so a client sees exact valid values.
 */

import { z } from "zod";
import type { EntitySet, ServiceModel } from "../metadata/model.js";
import { findEnum } from "../metadata/model.js";
import { FILTER_OPS, edmToJsonSchema } from "../metadata/types.js";
import { StructuredFilterSchema } from "../odata/filter/structured.js";
import type { StructuredFilter } from "../odata/filter/structured.js";

const Literal = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const KeySchema = z
  .union([z.string(), z.number(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))])
  .describe("Key value. A scalar for single-key entities, or an object { keyName: value } for composite keys. Draft entities default IsActiveEntity to true.");

export const OrderBySchema = z.object({
  field: z.string().describe("A sortable property name"),
  dir: z.enum(["asc", "desc"]).optional().describe("Sort direction, default asc"),
});

const FILTER_DOC =
  "Filter. Preferred: a structured object { field, op, value } or { and: [...] } / { or: [...] } / { not: ... }. " +
  `Operators: ${FILTER_OPS.join(", ")}. Values are plain JSON; never add quotes. ` +
  "Alternatively a raw OData $filter string, which is parsed and validated before sending.";

export function querySchema(maxTop: number): {
  entitySet: z.ZodString;
  filter: z.ZodOptional<z.ZodUnion<readonly [z.ZodType<StructuredFilter>, z.ZodString]>>;
  select: z.ZodOptional<z.ZodArray<z.ZodString>>;
  expand: z.ZodOptional<z.ZodArray<z.ZodString>>;
  orderBy: z.ZodOptional<z.ZodArray<typeof OrderBySchema>>;
  top: z.ZodOptional<z.ZodNumber>;
  skip: z.ZodOptional<z.ZodNumber>;
  search: z.ZodOptional<z.ZodString>;
  includeDrafts: z.ZodOptional<z.ZodBoolean>;
} {
  return {
    entitySet: z.string().describe("Entity set name (see list_entity_sets)"),
    filter: z.union([StructuredFilterSchema, z.string()]).optional().describe(FILTER_DOC),
    select: z.array(z.string()).optional().describe("Properties to return. Keys are always included. Omit for all properties."),
    expand: z.array(z.string()).optional().describe("Navigation properties to include inline, e.g. [\"author\"] or nested [\"author/books\"]."),
    orderBy: z.array(OrderBySchema).optional(),
    top: z.number().int().min(1).max(maxTop).optional().describe(`Page size (max ${maxTop})`),
    skip: z.number().int().min(0).optional().describe("Offset for paging; use nextSkip from the previous response"),
    search: z.string().optional().describe("Free-text $search, when the entity supports it"),
    includeDrafts: z.boolean().optional().describe("Draft-enabled entities only: include draft records (default false)"),
  };
}

/* ------------------------------------------------------------------ */
/* Typed per-entity variants                                            */
/* ------------------------------------------------------------------ */

function enumOf(values: string[]): z.ZodEnum<Record<string, string>> | z.ZodString {
  return values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string();
}

/**
 * `field` stays a string (not an enum) on purpose: navigation paths such as `author/name` are legal
 * and cannot be enumerated, and a wrong name should reach the validator, which answers with the
 * filterable list, rather than fail schema validation with a generic protocol error.
 */
export function typedFilterSchema(filterable: string[]): z.ZodType<StructuredFilter> {
  const Condition = z
    .object({
      field: z.string().describe(`Filterable: ${filterable.join(", ")}. Paths through single-valued navigations (e.g. nav/prop) are allowed.`),
      op: z.enum(FILTER_OPS as [string, ...string[]]),
      value: z.union([Literal, z.array(Literal)]).optional(),
    })
    .strict();
  const Filter: z.ZodType<StructuredFilter> = z.lazy(() =>
    z.union([
      z.object({ and: z.array(Filter).min(1) }).strict(),
      z.object({ or: z.array(Filter).min(1) }).strict(),
      z.object({ not: Filter }).strict(),
      Condition as unknown as z.ZodType<StructuredFilter>,
    ]),
  );
  return Filter;
}

export function typedQuerySchema(set: EntitySet, maxTop: number): Record<string, z.ZodTypeAny> {
  const props = set.properties.map((p) => p.name);
  const navs = set.navigations.map((n) => n.name);
  const shape: Record<string, z.ZodTypeAny> = {
    filter: z.union([typedFilterSchema(set.capabilities.filterable), z.string()]).optional().describe(FILTER_DOC),
    select: z.array(enumOf(props)).optional().describe("Properties to return. Keys are always included."),
    expand: z.array(navs.length ? z.union([enumOf(navs), z.string()]) : z.string()).optional().describe(
      navs.length ? `Navigations to include inline: ${navs.join(", ")}. Nested paths like a/b are allowed.` : "This entity has no navigations.",
    ),
    orderBy: z
      .array(z.object({ field: enumOf(set.capabilities.sortable), dir: z.enum(["asc", "desc"]).optional() }))
      .optional(),
    top: z.number().int().min(1).max(maxTop).optional().describe(`Page size (max ${maxTop})`),
    skip: z.number().int().min(0).optional().describe("Offset for paging; use nextSkip from the previous response"),
  };
  if (set.capabilities.searchable) shape["search"] = z.string().optional().describe("Free-text $search");
  if (set.draftEnabled) shape["includeDrafts"] = z.boolean().optional().describe("Include draft records (default false)");
  return shape;
}

/** Typed object schema for create/update payloads: one optional field per writable property. */
export function typedDataSchema(model: ServiceModel, set: EntitySet, mode: "create" | "update"): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of set.properties) {
    if (p.readOnly) continue;
    if (mode === "update" && p.isKey) continue;
    let field: z.ZodTypeAny;
    const js = edmToJsonSchema(p.type);
    if (p.enumType) {
      const en = findEnum(model, p.enumType);
      field = en ? z.enum(en.members.map((m) => m.name) as [string, ...string[]]) : z.string();
    } else if (p.type === "Edm.Decimal") {
      field = z.union([z.string(), z.number()]);
    } else if (js.type === "integer") field = z.number().int();
    else if (js.type === "number") field = z.number();
    else if (js.type === "boolean") field = z.boolean();
    else if (js.type === "object") field = z.record(z.string(), z.unknown());
    else field = z.string();
    if (p.isCollection) field = z.array(field);
    const bits: string[] = [];
    if (p.label && p.label !== p.name) bits.push(p.label);
    if (p.description) bits.push(p.description);
    if (js.note) bits.push(js.note);
    if (js.format) bits.push(js.format);
    if (p.mandatory && mode === "create") bits.push("mandatory");
    const described = bits.length ? field.describe(bits.join(". ")) : field;
    shape[p.name] = p.nullable ? described.nullable().optional() : described.optional();
  }
  // Loose so nested composition payloads (deep insert) pass through to handler-side validation.
  return z.looseObject(shape);
}
