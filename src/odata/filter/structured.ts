/**
 * The structured filter object accepted by query tools, and its conversion to the AST.
 * This is the documented-first form: the model names a field, an operator and a value, and never
 * has to think about quoting.
 */

import { z } from "zod";
import { FILTER_OPS } from "../../metadata/types.js";
import type { FilterNode, Expr } from "./ast.js";
import { F } from "./ast.js";
import { ValidationError } from "../../util/errors.js";

const LiteralSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const ConditionSchema = z
  .object({
    field: z.string().min(1).describe("Property name, or a path through a single-valued navigation such as Customer/Country"),
    op: z.enum(FILTER_OPS as [string, ...string[]]).describe("eq ne gt ge lt le in contains startswith endswith isnull isnotnull"),
    value: z
      .union([LiteralSchema, z.array(LiteralSchema)])
      .optional()
      .describe("Literal value. Use an array with op=in. Omit for isnull / isnotnull. Send decimals and dates as strings."),
  })
  .strict();

export type Condition = z.infer<typeof ConditionSchema>;

export type StructuredFilter =
  | { and: StructuredFilter[] }
  | { or: StructuredFilter[] }
  | { not: StructuredFilter }
  | Condition;

export const StructuredFilterSchema: z.ZodType<StructuredFilter> = z.lazy(() =>
  z.union([
    z.object({ and: z.array(StructuredFilterSchema).min(1) }).strict(),
    z.object({ or: z.array(StructuredFilterSchema).min(1) }).strict(),
    z.object({ not: StructuredFilterSchema }).strict(),
    ConditionSchema,
  ]),
);

export function structuredToAst(filter: StructuredFilter): FilterNode {
  if ("and" in filter) return F.and(...filter.and.map(structuredToAst));
  if ("or" in filter) return F.or(...filter.or.map(structuredToAst));
  if ("not" in filter) return F.not(structuredToAst(filter.not));
  return conditionToAst(filter);
}

function conditionToAst(c: Condition): FilterNode {
  const field = F.field(c.field);
  const single = (): Expr => {
    if (Array.isArray(c.value)) {
      throw new ValidationError({
        code: "invalid_filter",
        message: `Operator "${c.op}" on "${c.field}" takes a single value, but an array was given. Use op "in" for arrays.`,
        target: c.field,
      });
    }
    return F.lit(c.value === undefined ? null : c.value);
  };
  switch (c.op) {
    case "eq":
    case "ne":
    case "gt":
    case "ge":
    case "lt":
    case "le":
      if (c.value === undefined) {
        throw new ValidationError({
          code: "invalid_filter",
          message: `Operator "${c.op}" on "${c.field}" requires a value. Use isnull / isnotnull to test for null.`,
          target: c.field,
        });
      }
      return F.cmp(c.op, field, single());
    case "in": {
      const values = Array.isArray(c.value) ? c.value : c.value === undefined ? [] : [c.value];
      if (values.length === 0) {
        throw new ValidationError({
          code: "invalid_filter",
          message: `Operator "in" on "${c.field}" requires a non-empty array of values.`,
          target: c.field,
        });
      }
      return F.in(
        field,
        values.map((v) => F.lit(v)),
      );
    }
    case "contains":
    case "startswith":
    case "endswith":
      if (c.value === undefined || c.value === null) {
        throw new ValidationError({
          code: "invalid_filter",
          message: `Operator "${c.op}" on "${c.field}" requires a string value.`,
          target: c.field,
        });
      }
      return F.bool(F.call(c.op, field, single()));
    case "isnull":
      return F.cmp("eq", field, F.lit(null));
    case "isnotnull":
      return F.cmp("ne", field, F.lit(null));
    default:
      throw new ValidationError({
        code: "invalid_filter",
        message: `Unknown operator "${c.op}" on "${c.field}".`,
        target: c.field,
        validOptions: [...FILTER_OPS],
      });
  }
}
