/**
 * AST → OData `$filter` string. Literal quoting is decided here, from the resolved field type,
 * so neither the model nor the structured-filter caller ever has to get it right.
 */

import type { Expr, FilterNode } from "./ast.js";
import type { FieldResolver } from "../validate.js";
import { formatLiteral } from "../../metadata/types.js";
import type { LiteralKind } from "../../metadata/types.js";

/** What a literal should be formatted as: derived from the field on the other side of the operator. */
interface Target {
  kind: LiteralKind;
  enumType?: string;
}

const TEXT_FUNCS = new Set(["tolower", "toupper", "trim", "concat", "substring"]);
const NUMBER_FUNCS = new Set(["year", "month", "day", "hour", "minute", "second", "length", "indexof", "round", "floor", "ceiling"]);
const STRING_ARG_FUNCS = new Set(["contains", "startswith", "endswith", "tolower", "toupper", "trim", "length", "indexof", "concat", "substring"]);

export function serializeFilter(node: FilterNode, resolve: FieldResolver): string {
  return ser(node, resolve, false);
}

function ser(node: FilterNode, resolve: FieldResolver, nested: boolean): string {
  switch (node.kind) {
    case "and": {
      const s = node.args.map((a) => ser(a, resolve, true)).join(" and ");
      return nested && node.args.length > 1 ? `(${s})` : s;
    }
    case "or": {
      const s = node.args.map((a) => ser(a, resolve, true)).join(" or ");
      return nested && node.args.length > 1 ? `(${s})` : s;
    }
    case "not":
      return `not (${ser(node.arg, resolve, false)})`;
    case "cmp": {
      const target = targetOf(node.left, resolve) ?? targetOf(node.right, resolve);
      return `${expr(node.left, resolve, target)} ${node.op} ${expr(node.right, resolve, target)}`;
    }
    case "in": {
      const target = targetOf(node.left, resolve);
      return `${expr(node.left, resolve, target)} in (${node.values.map((v) => expr(v, resolve, target)).join(",")})`;
    }
    case "bool":
      return expr(node.expr, resolve, { kind: "boolean" });
  }
}

/** The literal target an expression implies, when it can be derived from a field. */
function targetOf(e: Expr, resolve: FieldResolver): Target | undefined {
  if (e.kind === "field") {
    const r = resolve(e.path);
    if (!r) return undefined;
    return r.enumType ? { kind: r.kind, enumType: r.enumType } : { kind: r.kind };
  }
  if (e.kind === "call") {
    if (TEXT_FUNCS.has(e.name)) return { kind: "text" };
    if (NUMBER_FUNCS.has(e.name)) return { kind: "number" };
    if (e.name === "date") return { kind: "date" };
    if (e.name === "time") return { kind: "time" };
    if (e.name === "now") return { kind: "datetime" };
    const first = e.args[0];
    return first ? targetOf(first, resolve) : undefined;
  }
  return undefined;
}

function expr(e: Expr, resolve: FieldResolver, target: Target | undefined): string {
  switch (e.kind) {
    case "field":
      return e.path;
    case "call": {
      const args = e.args.map((a, i) => {
        if (i === 0) return expr(a, resolve, targetOf(a, resolve) ?? target);
        return expr(a, resolve, STRING_ARG_FUNCS.has(e.name) ? { kind: "text" } : { kind: "number" });
      });
      return `${e.name}(${args.join(",")})`;
    }
    case "lit": {
      if (e.value === null) return "null";
      if (e.enumType) return formatLiteral("enum", e.value, e.enumType);
      if (target?.kind === "enum") return formatLiteral("enum", e.value, target.enumType);
      const kind = target?.kind ?? inferKind(e);
      return formatLiteral(kind, e.value);
    }
  }
}

/** Fallback when no field type is available (e.g. comparing two literals): keep what the caller wrote. */
function inferKind(e: Extract<Expr, { kind: "lit" }>): LiteralKind {
  if (typeof e.value === "number") return "number";
  if (typeof e.value === "boolean") return "boolean";
  if (e.quoted === false) return "number"; // bare token (date, guid): emit as-is
  return "text";
}
