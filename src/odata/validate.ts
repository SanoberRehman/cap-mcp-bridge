/**
 * Schema validation for everything that goes into an OData URL: filter trees, select lists,
 * expand paths, order-by clauses and key values.
 *
 * Every failure is a ValidationError naming the offending field and listing what would have been
 * valid. Nothing here touches the network.
 */

import type { EntitySet, EntityType, Property, ServiceModel } from "../metadata/model.js";
import { findEntitySet, findEntitySetForType, findEntityType, findEnum } from "../metadata/model.js";
import { checkLiteral, legalOpsFor, literalKind } from "../metadata/types.js";
import type { FilterOp, LiteralKind } from "../metadata/types.js";
import { ValidationError } from "../util/errors.js";
import type { Expr, FilterNode } from "./filter/ast.js";

export interface FieldResolution {
  path: string;
  property: Property;
  kind: LiteralKind;
  enumType?: string;
  enumMembers?: string[];
  /** True when the path crosses one or more navigations. */
  viaNavigation: boolean;
  /** Whether this field may be used in `$filter` on its owning entity. */
  filterable: boolean;
  /** Whether this field may be used in `$orderby` on its owning entity. */
  sortable: boolean;
}

export type FieldResolver = (path: string) => FieldResolution | undefined;

export interface Visibility {
  /** Entity set names the bridge exposes (after allow/deny lists). */
  isVisible(setName: string): boolean;
}

export const ALL_VISIBLE: Visibility = { isVisible: () => true };

/* ------------------------------------------------------------------ */
/* Field paths                                                          */
/* ------------------------------------------------------------------ */

interface Owner {
  type: EntityType;
  set: EntitySet | undefined;
}

function ownerOf(model: ServiceModel, set: EntitySet): Owner {
  const type = findEntityType(model, set.entityType);
  return { type: type ?? { name: set.entityType, keys: set.keys, properties: set.properties, navigations: set.navigations }, set };
}

function ownerOfType(model: ServiceModel, qualified: string, boundSet?: string): Owner | undefined {
  const type = findEntityType(model, qualified);
  if (!type) return undefined;
  const set = (boundSet ? findEntitySet(model, boundSet) : undefined) ?? findEntitySetForType(model, qualified);
  return { type, set };
}

function propertyNames(o: Owner): string[] {
  return o.type.properties.map((p) => p.name);
}

function navigationNames(o: Owner): string[] {
  return o.type.navigations.map((n) => n.name);
}

/**
 * Resolve `Status` or `Customer/Country` against an entity set. Throws with the list of valid
 * properties (and navigations) at the segment that failed.
 */
export function resolveFieldPath(model: ServiceModel, set: EntitySet, path: string, visibility: Visibility = ALL_VISIBLE): FieldResolution {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new ValidationError({ code: "unknown_field", message: `Empty field path on ${set.name}`, target: set.name });
  }
  let owner = ownerOf(model, set);
  let viaNavigation = false;

  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i] ?? "";
    const nav = owner.type.navigations.find((n) => n.name === seg);
    if (nav) {
      if (nav.isCollection) {
        throw new ValidationError({
          code: "invalid_path",
          message: `"${seg}" on ${owner.type.name} is a to-many navigation; it cannot be used in a field path. Filter on the target entity set instead, or use expand.`,
          target: path,
          validOptions: owner.type.navigations.filter((n) => !n.isCollection).map((n) => n.name),
        });
      }
      const next = ownerOfType(model, nav.targetType, nav.targetSet);
      if (!next) {
        throw new ValidationError({ code: "invalid_path", message: `Navigation "${seg}" points at unknown type ${nav.targetType}`, target: path });
      }
      if (next.set && !visibility.isVisible(next.set.name)) {
        throw new ValidationError({
          code: "entity_not_exposed",
          message: `Navigation "${seg}" targets entity set ${next.set.name}, which is not exposed by this bridge.`,
          target: path,
        });
      }
      owner = next;
      viaNavigation = true;
      continue;
    }
    const complex = owner.type.properties.find((p) => p.name === seg && p.complexType);
    if (complex) {
      const ct = model.complexTypes.find((c) => c.name === complex.complexType);
      if (!ct) throw new ValidationError({ code: "invalid_path", message: `Unknown complex type ${complex.complexType}`, target: path });
      owner = { type: { name: ct.name, keys: [], properties: ct.properties, navigations: [] }, set: undefined };
      continue;
    }
    throw new ValidationError({
      code: "unknown_field",
      message: `"${seg}" is not a navigation or complex property of ${owner.type.name} (in path "${path}").`,
      target: path,
      validOptions: [...navigationNames(owner), ...owner.type.properties.filter((p) => p.complexType).map((p) => p.name)],
    });
  }

  const last = segments[segments.length - 1] ?? "";
  const property = owner.type.properties.find((p) => p.name === last);
  if (!property) {
    const nav = owner.type.navigations.find((n) => n.name === last);
    const hint = nav
      ? ` "${last}" is a navigation; name a property on it, e.g. ${path}/${(ownerOfType(model, nav.targetType)?.type.properties[0]?.name ?? "ID")}.`
      : "";
    throw new ValidationError({
      code: "unknown_field",
      message: `Field "${last}" does not exist on ${owner.set?.name ?? owner.type.name}.${hint}`,
      target: path,
      validOptions: propertyNames(owner),
    });
  }

  const kind = literalKind(property.type, { isEnum: Boolean(property.enumType), isComplex: Boolean(property.complexType) });
  const caps = owner.set?.capabilities;
  const res: FieldResolution = {
    path,
    property,
    kind,
    viaNavigation,
    filterable: caps ? caps.filterable.includes(property.name) : kind !== "complex" && kind !== "binary",
    sortable: caps ? caps.sortable.includes(property.name) : kind !== "complex" && kind !== "binary",
  };
  if (property.enumType) {
    res.enumType = property.enumType;
    const en = findEnum(model, property.enumType);
    if (en) res.enumMembers = en.members.map((m) => m.name);
  }
  return res;
}

export function makeResolver(model: ServiceModel, set: EntitySet, visibility: Visibility = ALL_VISIBLE): FieldResolver {
  const cache = new Map<string, FieldResolution | undefined>();
  return (path) => {
    if (cache.has(path)) return cache.get(path);
    let r: FieldResolution | undefined;
    try {
      r = resolveFieldPath(model, set, path, visibility);
    } catch {
      r = undefined;
    }
    cache.set(path, r);
    return r;
  };
}

/* ------------------------------------------------------------------ */
/* Filter trees                                                         */
/* ------------------------------------------------------------------ */

interface FnSpec {
  arity: number | [number, number];
  /** Kind required of the first argument, if any. */
  first?: LiteralKind[];
  /** Kind the call evaluates to. */
  returns: LiteralKind | "boolean";
}

const FUNCTIONS: Record<string, FnSpec> = {
  contains: { arity: 2, first: ["text"], returns: "boolean" },
  startswith: { arity: 2, first: ["text"], returns: "boolean" },
  endswith: { arity: 2, first: ["text"], returns: "boolean" },
  tolower: { arity: 1, first: ["text"], returns: "text" },
  toupper: { arity: 1, first: ["text"], returns: "text" },
  trim: { arity: 1, first: ["text"], returns: "text" },
  length: { arity: 1, first: ["text"], returns: "number" },
  indexof: { arity: 2, first: ["text"], returns: "number" },
  substring: { arity: [2, 3], first: ["text"], returns: "text" },
  concat: { arity: 2, first: ["text"], returns: "text" },
  year: { arity: 1, first: ["date", "datetime"], returns: "number" },
  month: { arity: 1, first: ["date", "datetime"], returns: "number" },
  day: { arity: 1, first: ["date", "datetime"], returns: "number" },
  hour: { arity: 1, first: ["datetime", "time"], returns: "number" },
  minute: { arity: 1, first: ["datetime", "time"], returns: "number" },
  second: { arity: 1, first: ["datetime", "time"], returns: "number" },
  date: { arity: 1, first: ["datetime"], returns: "date" },
  time: { arity: 1, first: ["datetime"], returns: "time" },
  now: { arity: 0, returns: "datetime" },
  round: { arity: 1, first: ["number", "decimal"], returns: "number" },
  floor: { arity: 1, first: ["number", "decimal"], returns: "number" },
  ceiling: { arity: 1, first: ["number", "decimal"], returns: "number" },
};

const CMP_TO_OP: Record<string, FilterOp> = { eq: "eq", ne: "ne", gt: "gt", ge: "ge", lt: "lt", le: "le" };

/** Validate a filter tree against the entity set. Throws ValidationError; returns nothing. */
export function validateFilter(model: ServiceModel, set: EntitySet, node: FilterNode, visibility: Visibility = ALL_VISIBLE): void {
  const ctx: Ctx = { model, set, visibility, resolve: makeResolver(model, set, visibility) };
  walk(node, ctx);
}

interface Ctx {
  model: ServiceModel;
  set: EntitySet;
  visibility: Visibility;
  /** Non-throwing lookup, for "is this even a field?" checks. */
  resolve: FieldResolver;
}

function walk(node: FilterNode, ctx: Ctx): void {
  switch (node.kind) {
    case "and":
    case "or":
      node.args.forEach((n) => walk(n, ctx));
      return;
    case "not":
      walk(node.arg, ctx);
      return;
    case "cmp": {
      const left = typeOf(node.left, ctx, true);
      // `title eq Jane`: the parser reads an unquoted word as a field. If it is not one and the other
      // side is a string field, the far more likely mistake is a missing pair of quotes.
      if (node.right.kind === "field" && left.field?.kind === "text" && !ctx.resolve(node.right.path)) {
        throw new ValidationError({
          code: "invalid_literal",
          message: `"${left.field.path}" is a string; the value ${node.right.path} must be quoted: ${left.field.path} ${node.op} '${node.right.path}'.`,
          target: left.field.path,
          hint: "Or use the structured filter form, which quotes for you.",
        });
      }
      const right = typeOf(node.right, ctx, true);
      const fieldSide = node.left.kind === "field" ? left : node.right.kind === "field" ? right : undefined;
      const litSide = node.right.kind === "lit" ? node.right : node.left.kind === "lit" ? node.left : undefined;
      if (fieldSide?.field) {
        const op = CMP_TO_OP[node.op] as FilterOp;
        assertOpLegal(fieldSide.field, op);
        if (litSide) assertLiteral(fieldSide.field, litSide, op);
      } else if (left.kind === "boolean" && node.left.kind === "call" && litSide) {
        // e.g. contains(x,'y') eq true — acceptable
      }
      return;
    }
    case "in": {
      if (node.left.kind !== "field") {
        throw new ValidationError({ code: "invalid_filter", message: `"in" requires a field on the left-hand side.` });
      }
      const f = resolveFieldPath(ctx.model, ctx.set, node.left.path, ctx.visibility);
      assertOpLegal(f, "in");
      node.values.forEach((v) => {
        if (v.kind !== "lit") throw new ValidationError({ code: "invalid_filter", message: `Values in an "in" list must be literals (field ${f.path}).`, target: f.path });
        assertLiteral(f, v, "in");
      });
      return;
    }
    case "bool": {
      const t = typeOf(node.expr, ctx, false);
      if (t.kind !== "boolean") {
        throw new ValidationError({
          code: "invalid_filter",
          message:
            node.expr.kind === "field"
              ? `"${node.expr.path}" is ${t.kind === "text" ? "a string" : `of type ${t.kind}`}, so it cannot stand alone as a condition. Compare it: ${node.expr.path} eq <value>.`
              : `Expression does not evaluate to a boolean.`,
          ...(node.expr.kind === "field" ? { target: node.expr.path } : {}),
        });
      }
      return;
    }
  }
}

interface ExprType {
  kind: LiteralKind | "boolean" | "literal";
  field?: FieldResolution;
}

function typeOf(e: Expr, ctx: Ctx, allowNonBooleanField: boolean): ExprType {
  switch (e.kind) {
    case "field": {
      const f = resolveFieldPath(ctx.model, ctx.set, e.path, ctx.visibility);
      if (!f.filterable) {
        throw new ValidationError({
          code: "not_filterable",
          message: `"${e.path}" is not filterable on ${ctx.set.name}. Filterable fields: ${filterableList(ctx).join(", ")}`,
          target: e.path,
          validOptions: filterableList(ctx),
        });
      }
      void allowNonBooleanField;
      return { kind: f.kind, field: f };
    }
    case "lit":
      return { kind: "literal" };
    case "call": {
      const spec = FUNCTIONS[e.name];
      if (!spec) {
        throw new ValidationError({
          code: "unknown_function",
          message: `Unknown filter function "${e.name}".`,
          validOptions: Object.keys(FUNCTIONS),
        });
      }
      const [min, max] = Array.isArray(spec.arity) ? spec.arity : [spec.arity, spec.arity];
      if (e.args.length < min || e.args.length > max) {
        throw new ValidationError({
          code: "invalid_filter",
          message: `${e.name}() takes ${min === max ? min : `${min}-${max}`} argument(s), got ${e.args.length}.`,
        });
      }
      const first = e.args[0];
      if (first && spec.first) {
        const ft = typeOf(first, ctx, true);
        if (ft.kind !== "literal" && !spec.first.includes(ft.kind as LiteralKind)) {
          throw new ValidationError({
            code: "invalid_operator",
            message: `${e.name}() expects a ${spec.first.join("/")} argument, but ${first.kind === "field" ? `"${first.path}"` : "the argument"} is ${ft.field?.property.type ?? ft.kind}.`,
            ...(first.kind === "field" ? { target: first.path, validOptions: fieldsOfKind(ctx, spec.first) } : {}),
          });
        }
      }
      e.args.slice(1).forEach((a) => typeOf(a, ctx, true));
      return { kind: spec.returns };
    }
  }
}

function assertOpLegal(f: FieldResolution, op: FilterOp): void {
  const legal = legalOpsFor(f.kind);
  if (!legal.includes(op)) {
    throw new ValidationError({
      code: "invalid_operator",
      message: `Operator "${op}" is not valid for "${f.path}" (${f.property.type}). Valid operators: ${legal.join(", ")}`,
      target: f.path,
      validOptions: legal,
    });
  }
}

function assertLiteral(f: FieldResolution, lit: Extract<Expr, { kind: "lit" }>, op: FilterOp): void {
  if (lit.value === null) {
    if (op !== "eq" && op !== "ne") {
      throw new ValidationError({ code: "invalid_filter", message: `null can only be compared with eq / ne (field "${f.path}").`, target: f.path });
    }
    if (!f.property.nullable) {
      throw new ValidationError({ code: "invalid_filter", message: `"${f.path}" is not nullable, so comparing it with null is always ${op === "eq" ? "false" : "true"}.`, target: f.path });
    }
    return;
  }
  if (lit.enumType && f.enumType && lit.enumType !== f.enumType) {
    throw new ValidationError({ code: "invalid_literal", message: `Enum literal type ${lit.enumType} does not match "${f.path}" (${f.enumType}).`, target: f.path });
  }
  const check = checkLiteral(f.kind, lit.value, f.enumMembers);
  if (!check.ok) {
    throw new ValidationError({
      code: "invalid_literal",
      message: `Value ${JSON.stringify(lit.value)} is not valid for "${f.path}" (${f.property.type}): expected ${check.expected}.`,
      target: f.path,
      ...(f.enumMembers ? { validOptions: f.enumMembers } : {}),
    });
  }
  if (f.kind === "text" && lit.quoted === false && typeof lit.value === "string") {
    throw new ValidationError({
      code: "invalid_literal",
      message: `"${f.path}" is a string; the value ${lit.value} must be quoted: ${f.path} ${op} '${lit.value}'.`,
      target: f.path,
      hint: "Or use the structured filter form, which quotes for you.",
    });
  }
}

function filterableList(ctx: Ctx): string[] {
  return ctx.set.capabilities.filterable;
}

function fieldsOfKind(ctx: Ctx, kinds: LiteralKind[]): string[] {
  return ctx.set.properties
    .filter((p) => kinds.includes(literalKind(p.type, { isEnum: Boolean(p.enumType), isComplex: Boolean(p.complexType) })))
    .filter((p) => ctx.set.capabilities.filterable.includes(p.name))
    .map((p) => p.name);
}

/* ------------------------------------------------------------------ */
/* select / expand / orderby                                            */
/* ------------------------------------------------------------------ */

export function validateSelect(model: ServiceModel, set: EntitySet, select: string[]): void {
  const valid = [...set.properties.map((p) => p.name), ...set.navigations.map((n) => n.name)];
  for (const s of select) {
    if (s.includes("/")) {
      resolveFieldPath(model, set, s);
      continue;
    }
    if (!valid.includes(s)) {
      throw new ValidationError({
        code: "unknown_field",
        message: `Cannot select "${s}": it is not a property of ${set.name}.`,
        target: s,
        validOptions: set.properties.map((p) => p.name),
      });
    }
  }
}

export interface ExpandResolution {
  path: string;
  segments: string[];
  /** Entity set of the final navigation target, when known. */
  targetSet: EntitySet | undefined;
}

export function validateExpand(model: ServiceModel, set: EntitySet, expand: string[], visibility: Visibility = ALL_VISIBLE): ExpandResolution[] {
  return expand.map((path) => {
    const segments = path.split("/").filter(Boolean);
    let owner = ownerOf(model, set);
    for (const seg of segments) {
      const nav = owner.type.navigations.find((n) => n.name === seg);
      if (!nav) {
        throw new ValidationError({
          code: "unknown_navigation",
          message: `"${seg}" is not a navigation of ${owner.set?.name ?? owner.type.name} (expand "${path}").`,
          target: path,
          validOptions: navigationNames(owner),
        });
      }
      const next = ownerOfType(model, nav.targetType, nav.targetSet);
      if (!next) {
        throw new ValidationError({ code: "unknown_navigation", message: `Navigation "${seg}" targets unknown type ${nav.targetType}`, target: path });
      }
      if (next.set && !visibility.isVisible(next.set.name)) {
        throw new ValidationError({
          code: "entity_not_exposed",
          message: `Cannot expand "${seg}": its target entity set ${next.set.name} is not exposed by this bridge.`,
          target: path,
        });
      }
      owner = next;
    }
    return { path, segments, targetSet: owner.set };
  });
}

export interface OrderBy {
  field: string;
  dir?: "asc" | "desc" | undefined;
}

export function validateOrderBy(model: ServiceModel, set: EntitySet, orderBy: OrderBy[], visibility: Visibility = ALL_VISIBLE): void {
  for (const o of orderBy) {
    const f = resolveFieldPath(model, set, o.field, visibility);
    if (!f.sortable) {
      throw new ValidationError({
        code: "not_sortable",
        message: `"${o.field}" is not sortable on ${set.name}. Sortable fields: ${set.capabilities.sortable.join(", ")}`,
        target: o.field,
        validOptions: set.capabilities.sortable,
      });
    }
    if (o.dir && o.dir !== "asc" && o.dir !== "desc") {
      throw new ValidationError({ code: "invalid_filter", message: `orderBy dir must be "asc" or "desc" (field "${o.field}")`, target: o.field, validOptions: ["asc", "desc"] });
    }
  }
}
