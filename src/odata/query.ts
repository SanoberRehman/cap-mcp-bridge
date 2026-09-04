/**
 * Query building: tool arguments → validated OData URL parts.
 * Draft handling and pagination limits live here so every caller gets them.
 */

import type { EntitySet, ServiceModel } from "../metadata/model.js";
import { findEntitySet } from "../metadata/model.js";
import { ValidationError } from "../util/errors.js";
import type { FilterNode } from "./filter/ast.js";
import { F } from "./filter/ast.js";
import { parseFilter } from "./filter/parse.js";
import { serializeFilter } from "./filter/serialize.js";
import type { StructuredFilter } from "./filter/structured.js";
import { structuredToAst } from "./filter/structured.js";
import { makeResolver, validateExpand, validateFilter, validateOrderBy, validateSelect, ALL_VISIBLE } from "./validate.js";
import type { OrderBy, Visibility } from "./validate.js";

export interface QueryLimits {
  defaultTop: number;
  maxTop: number;
}

export interface QueryInput {
  entitySet: string;
  filter?: StructuredFilter | string | undefined;
  select?: string[] | undefined;
  expand?: string[] | undefined;
  orderBy?: OrderBy[] | undefined;
  top?: number | undefined;
  skip?: number | undefined;
  search?: string | undefined;
  includeDrafts?: boolean | undefined;
}

export interface BuiltQuery {
  set: EntitySet;
  path: string;
  query: Record<string, string>;
  top: number;
  skip: number;
  /** True when `top` was reduced to the configured maximum. */
  topClamped: boolean;
  /** True when a draft filter was injected. */
  draftFilterApplied: boolean;
}

export function requireEntitySet(model: ServiceModel, name: string, visibility: Visibility = ALL_VISIBLE): EntitySet {
  const visible = model.entitySets.filter((s) => visibility.isVisible(s.name)).map((s) => s.name);
  const set = findEntitySet(model, name);
  if (!set || !visibility.isVisible(set.name)) {
    const close = visible.filter((n) => n.toLowerCase() === name.toLowerCase());
    throw new ValidationError({
      code: "unknown_entity_set",
      message: `Entity set "${name}" does not exist${close.length ? ` (did you mean ${close.join(" / ")}?)` : ""}.`,
      target: name,
      validOptions: visible,
      hint: "Call list_entity_sets to see what is available.",
    });
  }
  return set;
}

/** Convert either filter form to the AST, validate it, and (for drafts) add the active-entity guard. */
export function buildFilterString(
  model: ServiceModel,
  set: EntitySet,
  filter: StructuredFilter | string | undefined,
  opts: { includeDrafts?: boolean | undefined; visibility?: Visibility } = {},
): { filter: string | undefined; draftFilterApplied: boolean } {
  const visibility = opts.visibility ?? ALL_VISIBLE;
  let node: FilterNode | undefined;
  if (typeof filter === "string") {
    node = filter.trim() ? parseFilter(filter) : undefined;
  } else if (filter) {
    node = structuredToAst(filter);
  }
  if (node) validateFilter(model, set, node, visibility);

  let draftFilterApplied = false;
  if (set.draftEnabled && !opts.includeDrafts) {
    const guard = F.cmp("eq", F.field("IsActiveEntity"), F.lit(true));
    node = node ? F.and(guard, node) : guard;
    draftFilterApplied = true;
  }
  if (!node) return { filter: undefined, draftFilterApplied };
  return { filter: serializeFilter(node, makeResolver(model, set, visibility)), draftFilterApplied };
}

export function buildQuery(model: ServiceModel, input: QueryInput, limits: QueryLimits, visibility: Visibility = ALL_VISIBLE): BuiltQuery {
  const set = requireEntitySet(model, input.entitySet, visibility);
  const query: Record<string, string> = {};

  const { filter, draftFilterApplied } = buildFilterString(model, set, input.filter, { includeDrafts: input.includeDrafts, visibility });
  if (filter) query["$filter"] = filter;

  if (input.select && input.select.length > 0) {
    validateSelect(model, set, input.select);
    // Keys are always included so a follow-up get/update can address the record.
    const keys = set.keys.map((k) => k.name).filter((k) => !input.select?.includes(k));
    query["$select"] = [...input.select, ...keys].join(",");
  }

  if (input.expand && input.expand.length > 0) {
    const resolved = validateExpand(model, set, input.expand, visibility);
    query["$expand"] = resolved.map((r) => nestedExpand(r.segments)).join(",");
  }

  if (input.orderBy && input.orderBy.length > 0) {
    validateOrderBy(model, set, input.orderBy, visibility);
    query["$orderby"] = input.orderBy.map((o) => `${o.field}${o.dir === "desc" ? " desc" : ""}`).join(",");
  }

  if (input.search) {
    if (!set.capabilities.searchable) {
      throw new ValidationError({ code: "not_searchable", message: `${set.name} does not support $search. Use a filter with contains instead.`, target: set.name });
    }
    query["$search"] = input.search;
  }

  const requestedTop = input.top ?? limits.defaultTop;
  if (!Number.isInteger(requestedTop) || requestedTop < 1) {
    throw new ValidationError({ code: "invalid_paging", message: `top must be a positive integer (got ${requestedTop}).`, target: "top" });
  }
  const top = Math.min(requestedTop, limits.maxTop);
  const skip = input.skip ?? 0;
  if (!Number.isInteger(skip) || skip < 0) {
    throw new ValidationError({ code: "invalid_paging", message: `skip must be a non-negative integer (got ${skip}).`, target: "skip" });
  }
  query["$top"] = String(top);
  if (skip > 0) query["$skip"] = String(skip);
  query["$count"] = "true";

  return { set, path: set.name, query, top, skip, topClamped: top !== requestedTop, draftFilterApplied };
}

/** `["author","books"]` → `author($expand=books)`. */
function nestedExpand(segments: string[]): string {
  const [head, ...rest] = segments;
  if (!head) return "";
  return rest.length === 0 ? head : `${head}($expand=${nestedExpand(rest)})`;
}
