/**
 * EDM → JSON Schema / literal-kind mapping. The single place that knows what an `Edm.*` type means.
 *
 * Three consumers share this table so they can never disagree:
 *   - tool input schemas (zod) and `describe_entity` output
 *   - `$filter` literal validation and formatting
 *   - key predicate formatting in `get_entity` / `update_entity` / `delete_entity`
 */

export type JsonSchemaType = "string" | "integer" | "number" | "boolean" | "object" | "array";

/**
 * How a value of this type behaves in OData URL literals and comparisons.
 *  - text:     quoted with single quotes, supports string functions
 *  - number:   bare numeric literal, supports ordering comparisons
 *  - decimal:  bare numeric literal in URLs, but a *string* in JSON bodies/results
 *  - boolean:  bare `true`/`false`, only eq/ne
 *  - guid:     bare 8-4-4-4-12 literal, only eq/ne
 *  - date / datetime / time: bare ISO literal, supports ordering
 *  - enum:     `Namespace.Type'Member'`, only eq/ne/has
 *  - binary:   not filterable
 *  - complex:  not filterable directly, only via path
 */
export type LiteralKind =
  | "text"
  | "number"
  | "decimal"
  | "boolean"
  | "guid"
  | "date"
  | "datetime"
  | "time"
  | "duration"
  | "enum"
  | "binary"
  | "complex"
  | "unknown";

export interface JsonSchemaHint {
  type: JsonSchemaType;
  format?: string;
  /** Appended to the generated field description. */
  note?: string;
}

const PRIMITIVES: Record<string, { schema: JsonSchemaHint; kind: LiteralKind }> = {
  "Edm.String": { schema: { type: "string" }, kind: "text" },
  "Edm.Boolean": { schema: { type: "boolean" }, kind: "boolean" },
  "Edm.Guid": { schema: { type: "string", format: "uuid" }, kind: "guid" },
  "Edm.Byte": { schema: { type: "integer" }, kind: "number" },
  "Edm.SByte": { schema: { type: "integer" }, kind: "number" },
  "Edm.Int16": { schema: { type: "integer" }, kind: "number" },
  "Edm.Int32": { schema: { type: "integer" }, kind: "number" },
  "Edm.Int64": { schema: { type: "integer" }, kind: "number" },
  "Edm.Single": { schema: { type: "number" }, kind: "number" },
  "Edm.Double": { schema: { type: "number" }, kind: "number" },
  "Edm.Decimal": {
    schema: {
      type: "string",
      note: 'decimal, serialised as a string (e.g. "19.99") to preserve precision',
    },
    kind: "decimal",
  },
  "Edm.Date": { schema: { type: "string", format: "date" }, kind: "date" },
  "Edm.DateTimeOffset": { schema: { type: "string", format: "date-time" }, kind: "datetime" },
  "Edm.TimeOfDay": { schema: { type: "string", note: "time of day, HH:MM:SS" }, kind: "time" },
  "Edm.Time": { schema: { type: "string", note: "time of day, HH:MM:SS" }, kind: "time" },
  "Edm.Duration": { schema: { type: "string", note: "ISO 8601 duration" }, kind: "duration" },
  "Edm.Binary": { schema: { type: "string", format: "byte" }, kind: "binary" },
  "Edm.Stream": { schema: { type: "string", format: "byte" }, kind: "binary" },
};

export function isPrimitive(edmType: string): boolean {
  return edmType.startsWith("Edm.");
}

/** JSON Schema shape for an EDM type. Non-primitive types are treated as `object`. */
export function edmToJsonSchema(edmType: string): JsonSchemaHint {
  const hit = PRIMITIVES[edmType];
  if (hit) return hit.schema;
  if (edmType.startsWith("Edm.")) return { type: "string", note: `unmapped ${edmType}` };
  return { type: "object" };
}

/** Literal behaviour for an EDM type. Callers pass `isEnum` when the model says so. */
export function literalKind(edmType: string, opts: { isEnum?: boolean; isComplex?: boolean } = {}): LiteralKind {
  if (opts.isEnum) return "enum";
  if (opts.isComplex) return "complex";
  const hit = PRIMITIVES[edmType];
  if (hit) return hit.kind;
  return edmType.startsWith("Edm.") ? "unknown" : "complex";
}

/** Short human name used in descriptions: `Edm.DateTimeOffset` → `DateTimeOffset`. */
export function shortTypeName(edmType: string): string {
  return edmType.startsWith("Edm.") ? edmType.slice(4) : edmType;
}

const ORDERABLE: ReadonlySet<LiteralKind> = new Set(["number", "decimal", "date", "datetime", "time", "text", "duration"]);
const EQUALITY_ONLY: ReadonlySet<LiteralKind> = new Set(["boolean", "guid", "enum"]);

export type FilterOp =
  | "eq"
  | "ne"
  | "gt"
  | "ge"
  | "lt"
  | "le"
  | "in"
  | "contains"
  | "startswith"
  | "endswith"
  | "isnull"
  | "isnotnull";

export const FILTER_OPS: readonly FilterOp[] = [
  "eq",
  "ne",
  "gt",
  "ge",
  "lt",
  "le",
  "in",
  "contains",
  "startswith",
  "endswith",
  "isnull",
  "isnotnull",
];

/** Which structured-filter operators are legal for a literal kind. */
export function legalOpsFor(kind: LiteralKind): FilterOp[] {
  const ops: FilterOp[] = ["eq", "ne", "in", "isnull", "isnotnull"];
  if (ORDERABLE.has(kind)) ops.push("gt", "ge", "lt", "le");
  if (kind === "text") ops.push("contains", "startswith", "endswith");
  if (EQUALITY_ONLY.has(kind)) return ops;
  if (kind === "binary" || kind === "complex" || kind === "unknown") return [];
  return ops;
}

const RX = {
  guid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  integer: /^-?\d+$/,
  decimal: /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  datetime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
  time: /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/,
  duration: /^-?P(?!$)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/,
};

export interface LiteralCheck {
  ok: boolean;
  /** Human explanation when not ok, e.g. `expected a date in YYYY-MM-DD form`. */
  expected?: string;
}

/**
 * Check that a JS value can be formatted as a literal of the given kind. Accepts the natural JS
 * type *and* its string form, because models frequently send `"1000"` for a number.
 */
export function checkLiteral(kind: LiteralKind, value: unknown, enumMembers?: string[]): LiteralCheck {
  if (value === null || value === undefined) return { ok: true };
  const s = typeof value === "string" ? value : String(value);
  switch (kind) {
    case "text":
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? { ok: true }
        : { ok: false, expected: "a string" };
    case "number":
      return typeof value === "number" || RX.decimal.test(s) ? { ok: true } : { ok: false, expected: "a number" };
    case "decimal":
      return typeof value === "number" || RX.decimal.test(s)
        ? { ok: true }
        : { ok: false, expected: 'a decimal number, e.g. "19.99"' };
    case "boolean":
      return typeof value === "boolean" || s === "true" || s === "false"
        ? { ok: true }
        : { ok: false, expected: "true or false" };
    case "guid":
      return RX.guid.test(s) ? { ok: true } : { ok: false, expected: "a GUID in 8-4-4-4-12 hex form" };
    case "date":
      return RX.date.test(s) ? { ok: true } : { ok: false, expected: "a date in YYYY-MM-DD form" };
    case "datetime":
      return RX.datetime.test(s)
        ? { ok: true }
        : { ok: false, expected: "an ISO 8601 date-time with offset, e.g. 2024-01-31T10:00:00Z" };
    case "time":
      return RX.time.test(s) ? { ok: true } : { ok: false, expected: "a time in HH:MM:SS form" };
    case "duration":
      return RX.duration.test(s) ? { ok: true } : { ok: false, expected: "an ISO 8601 duration, e.g. P1DT2H" };
    case "enum":
      if (enumMembers && !enumMembers.includes(s)) {
        return { ok: false, expected: `one of: ${enumMembers.join(", ")}` };
      }
      return { ok: true };
    default:
      return { ok: false, expected: "a filterable primitive type" };
  }
}

function quoteText(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Format a JS value as an OData v4 URL literal for the given kind. Assumes `checkLiteral` passed.
 * `enumType` is required for enum kinds (OData needs the qualified type in the literal).
 */
export function formatLiteral(kind: LiteralKind, value: unknown, enumType?: string): string {
  if (value === null || value === undefined) return "null";
  const s = typeof value === "string" ? value : String(value);
  switch (kind) {
    case "text":
      return quoteText(s);
    case "enum":
      return enumType ? `${enumType}${quoteText(s)}` : quoteText(s);
    case "number":
    case "decimal":
    case "boolean":
    case "guid":
    case "date":
    case "datetime":
    case "time":
    case "duration":
      return s;
    default:
      return quoteText(s);
  }
}

/**
 * Format a JS value for a JSON request body (create/update/action parameters).
 * Decimals stay strings; everything else is passed through as its natural JSON type.
 */
export function toJsonValue(kind: LiteralKind, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (kind === "decimal") return typeof value === "number" ? String(value) : value;
  if (kind === "number" && typeof value === "string" && RX.decimal.test(value)) return Number(value);
  if (kind === "boolean" && typeof value === "string") return value === "true";
  return value;
}
