/**
 * Filter AST shared by the structured-object path and the raw-string path.
 * Both are converted into this shape, validated once, then serialised once.
 */

export type ComparisonOp = "eq" | "ne" | "gt" | "ge" | "lt" | "le";

export type Expr =
  /** A property path such as `Status` or `Customer/Country`. */
  | { kind: "field"; path: string }
  /**
   * A literal. `value` is the JS value. `quoted` records whether a raw-string literal was written with
   * quotes, so the validator can explain quoting mistakes and the serialiser can normalise them.
   */
  | { kind: "lit"; value: string | number | boolean | null; quoted?: boolean; enumType?: string }
  /** A value-returning function such as `tolower(Name)` or `year(Date)`. */
  | { kind: "call"; name: string; args: Expr[] };

export type FilterNode =
  | { kind: "and"; args: FilterNode[] }
  | { kind: "or"; args: FilterNode[] }
  | { kind: "not"; arg: FilterNode }
  | { kind: "cmp"; op: ComparisonOp; left: Expr; right: Expr }
  | { kind: "in"; left: Expr; values: Expr[] }
  /** A boolean function such as `contains(Name,'x')`, or a bare boolean property. */
  | { kind: "bool"; expr: Expr };

/* ---- constructors, so callers do not hand-write object literals ---- */

export const F = {
  and: (...args: FilterNode[]): FilterNode => ({ kind: "and", args }),
  or: (...args: FilterNode[]): FilterNode => ({ kind: "or", args }),
  not: (arg: FilterNode): FilterNode => ({ kind: "not", arg }),
  cmp: (op: ComparisonOp, left: Expr, right: Expr): FilterNode => ({ kind: "cmp", op, left, right }),
  in: (left: Expr, values: Expr[]): FilterNode => ({ kind: "in", left, values }),
  bool: (expr: Expr): FilterNode => ({ kind: "bool", expr }),
  field: (path: string): Expr => ({ kind: "field", path }),
  lit: (value: string | number | boolean | null, quoted?: boolean): Expr =>
    quoted === undefined ? { kind: "lit", value } : { kind: "lit", value, quoted },
  call: (name: string, ...args: Expr[]): Expr => ({ kind: "call", name, args }),
};

/** Every field path referenced anywhere in the tree, in order of first appearance. */
export function collectFields(node: FilterNode, out: string[] = []): string[] {
  const visitExpr = (e: Expr): void => {
    if (e.kind === "field") {
      if (!out.includes(e.path)) out.push(e.path);
    } else if (e.kind === "call") e.args.forEach(visitExpr);
  };
  switch (node.kind) {
    case "and":
    case "or":
      node.args.forEach((n) => collectFields(n, out));
      break;
    case "not":
      collectFields(node.arg, out);
      break;
    case "cmp":
      visitExpr(node.left);
      visitExpr(node.right);
      break;
    case "in":
      visitExpr(node.left);
      node.values.forEach(visitExpr);
      break;
    case "bool":
      visitExpr(node.expr);
      break;
  }
  return out;
}
