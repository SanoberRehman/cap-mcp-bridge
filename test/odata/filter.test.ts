import { describe, expect, it } from "vitest";
import { parseFilter } from "../../src/odata/filter/parse.js";
import { structuredToAst } from "../../src/odata/filter/structured.js";
import type { StructuredFilter } from "../../src/odata/filter/structured.js";
import { serializeFilter } from "../../src/odata/filter/serialize.js";
import { makeResolver, validateFilter } from "../../src/odata/validate.js";
import { findEntitySet } from "../../src/metadata/model.js";
import type { ServiceModel } from "../../src/metadata/model.js";
import { ValidationError } from "../../src/util/errors.js";
import { bookshopModel, northwindModel } from "../helpers.js";

const bookshop = bookshopModel();
const northwind = northwindModel();

function compile(model: ServiceModel, setName: string, filter: StructuredFilter | string): string {
  const set = findEntitySet(model, setName);
  if (!set) throw new Error(`no set ${setName}`);
  const ast = typeof filter === "string" ? parseFilter(filter) : structuredToAst(filter);
  validateFilter(model, set, ast);
  return serializeFilter(ast, makeResolver(model, set));
}

function failure(model: ServiceModel, setName: string, filter: StructuredFilter | string): ValidationError {
  try {
    compile(model, setName, filter);
  } catch (e) {
    if (e instanceof ValidationError) return e;
    throw e;
  }
  throw new Error("expected a ValidationError");
}

describe("structured filters → OData", () => {
  it("quotes strings and leaves numbers bare, regardless of the JSON type sent", () => {
    expect(compile(bookshop, "Books", { field: "title", op: "eq", value: "Jane Eyre" })).toBe("title eq 'Jane Eyre'");
    expect(compile(bookshop, "Books", { field: "stock", op: "gt", value: "10" })).toBe("stock gt 10");
    expect(compile(bookshop, "Books", { field: "price", op: "gt", value: "1000" })).toBe("price gt 1000");
    expect(compile(bookshop, "Books", { field: "price", op: "le", value: 19.99 })).toBe("price le 19.99");
  });

  it("escapes single quotes inside strings", () => {
    expect(compile(bookshop, "Authors", { field: "name", op: "eq", value: "O'Brien" })).toBe("name eq 'O''Brien'");
  });

  it("emits date, datetime and guid literals unquoted", () => {
    expect(compile(bookshop, "Books", { field: "publishedAt", op: "ge", value: "1847-01-01" })).toBe("publishedAt ge 1847-01-01");
    expect(compile(bookshop, "Books", { field: "createdAt", op: "lt", value: "2024-01-31T10:00:00Z" })).toBe("createdAt lt 2024-01-31T10:00:00Z");
    expect(compile(bookshop, "Books", { field: "ID", op: "eq", value: "6b1a0a2e-0003-4000-8000-000000000001" })).toBe(
      "ID eq 6b1a0a2e-0003-4000-8000-000000000001",
    );
  });

  it("builds string functions, in-lists and null tests", () => {
    expect(compile(bookshop, "Books", { field: "title", op: "contains", value: "Jane" })).toBe("contains(title,'Jane')");
    expect(compile(bookshop, "Books", { field: "title", op: "startswith", value: "The" })).toBe("startswith(title,'The')");
    expect(compile(bookshop, "Books", { field: "status", op: "in", value: ["available", "discontinued"] })).toBe(
      "status in ('available','discontinued')",
    );
    expect(compile(bookshop, "Books", { field: "genre_ID", op: "isnull" })).toBe("genre_ID eq null");
    expect(compile(bookshop, "Books", { field: "genre_ID", op: "isnotnull" })).toBe("genre_ID ne null");
  });

  it("combines and / or / not with correct grouping", () => {
    const f: StructuredFilter = {
      and: [
        { field: "stock", op: "gt", value: 0 },
        { or: [{ field: "title", op: "contains", value: "Raven" }, { field: "title", op: "contains", value: "Eyre" }] },
        { not: { field: "status", op: "eq", value: "discontinued" } },
      ],
    };
    expect(compile(bookshop, "Books", f)).toBe(
      "stock gt 0 and (contains(title,'Raven') or contains(title,'Eyre')) and not (status eq 'discontinued')",
    );
  });

  it("allows paths through single-valued navigations", () => {
    expect(compile(bookshop, "Books", { field: "author/name", op: "eq", value: "Emily Brontë" })).toBe("author/name eq 'Emily Brontë'");
    expect(compile(northwind, "Orders", { field: "Customer/Country", op: "eq", value: "Germany" })).toBe("Customer/Country eq 'Germany'");
  });

  it("names the bad field and lists valid ones for an unknown property", () => {
    const err = failure(bookshop, "Books", { field: "titel", op: "eq", value: "x" });
    expect(err.code).toBe("unknown_field");
    expect(err.message).toMatch(/"titel" does not exist on Books/);
    expect(err.validOptions).toContain("title");
  });

  it("explains a to-many navigation in a path", () => {
    const err = failure(bookshop, "Books", { field: "reviews/rating", op: "gt", value: 3 });
    expect(err.code).toBe("invalid_path");
    expect(err.message).toMatch(/to-many/);
    expect(err.validOptions).toEqual(["author", "genre", "currency"]);
  });

  it("rejects operators that are illegal for the field type", () => {
    const err = failure(bookshop, "Books", { field: "stock", op: "contains", value: "1" });
    expect(err.code).toBe("invalid_operator");
    expect(err.message).toMatch(/Edm.Int32/);
    // For a string function the useful alternatives are the string fields, not the operators.
    expect(err.validOptions).toContain("title");
    expect(err.validOptions).not.toContain("stock");

    const bool = failure(bookshop, "Orders", { field: "IsActiveEntity", op: "gt", value: true });
    expect(bool.code).toBe("invalid_operator");
    expect(bool.message).toMatch(/Edm.Boolean/);
    expect(bool.validOptions).toEqual(expect.arrayContaining(["eq", "ne", "in"]));
    expect(bool.validOptions).not.toContain("gt");
  });

  it("rejects malformed literals with the expected format", () => {
    const date = failure(bookshop, "Books", { field: "publishedAt", op: "ge", value: "01/01/1847" });
    expect(date.code).toBe("invalid_literal");
    expect(date.message).toMatch(/YYYY-MM-DD/);

    const num = failure(bookshop, "Books", { field: "stock", op: "gt", value: "many" });
    expect(num.code).toBe("invalid_literal");

    const guid = failure(bookshop, "Books", { field: "ID", op: "eq", value: "123" });
    expect(guid.message).toMatch(/GUID/);
  });

  it("rejects fields excluded by Capabilities.FilterRestrictions and lists filterable ones", () => {
    const err = failure(northwind, "Categories", { field: "Picture", op: "eq", value: "x" });
    expect(err.code).toBe("not_filterable");
    expect(err.message).toMatch(/Filterable fields: CategoryID/);
  });

  it("rejects misuse of arrays and missing values", () => {
    expect(() => structuredToAst({ field: "stock", op: "eq", value: [1, 2] })).toThrow(/single value/);
    expect(() => structuredToAst({ field: "stock", op: "gt" })).toThrow(/requires a value/);
    expect(() => structuredToAst({ field: "stock", op: "in", value: [] })).toThrow(/non-empty/);
  });
});

describe("raw $filter strings", () => {
  it("parses and normalises the common shapes", () => {
    expect(compile(northwind, "Orders", "Freight gt 100 and ShipCountry eq 'Germany'")).toBe("Freight gt 100 and ShipCountry eq 'Germany'");
    expect(compile(northwind, "Orders", "(Freight gt 100 or Freight lt 1) and not (ShipCountry eq 'Germany')")).toBe(
      "(Freight gt 100 or Freight lt 1) and not (ShipCountry eq 'Germany')",
    );
    expect(compile(northwind, "Customers", "contains(CompanyName, 'Alfreds') and Country in ('Germany','Mexico')")).toBe(
      "contains(CompanyName,'Alfreds') and Country in ('Germany','Mexico')",
    );
    expect(compile(northwind, "Orders", "year(OrderDate) eq 1997")).toBe("year(OrderDate) eq 1997");
    expect(compile(northwind, "Customers", "tolower(City) eq 'berlin'")).toBe("tolower(City) eq 'berlin'");
  });

  it("accepts bare date/guid literals and quotes nothing that must stay bare", () => {
    expect(compile(bookshop, "Books", "publishedAt ge 1847-01-01 and ID ne 6b1a0a2e-0003-4000-8000-000000000001")).toBe(
      "publishedAt ge 1847-01-01 and ID ne 6b1a0a2e-0003-4000-8000-000000000001",
    );
  });

  it("re-quotes literals from the field type: a quoted date becomes bare, an unquoted string is an error", () => {
    expect(compile(bookshop, "Books", "publishedAt ge '1847-01-01'")).toBe("publishedAt ge 1847-01-01");
    const err = failure(bookshop, "Books", "title eq Jane");
    expect(err.code).toBe("invalid_literal");
    expect(err.message).toMatch(/must be quoted/);
  });

  it("reports syntax errors with a position instead of forwarding them", () => {
    const err = failure(northwind, "Orders", "Freight gt");
    expect(err.code).toBe("filter_parse_error");
    expect(err.message).toMatch(/position/);
    expect(failure(northwind, "Orders", "Freight gt 'x").message).toMatch(/unterminated string/);
    expect(failure(northwind, "Orders", "Freight = 5").message).toMatch(/unexpected character/);
  });

  it("validates function usage", () => {
    expect(failure(northwind, "Orders", "contains(Freight, 'x')").code).toBe("invalid_operator");
    expect(failure(northwind, "Orders", "foo(Freight) eq 1").code).toBe("unknown_function");
    expect(failure(northwind, "Orders", "year(Freight) eq 1").message).toMatch(/date/);
  });

  it("rejects a non-boolean field standing alone", () => {
    const err = failure(bookshop, "Books", "title");
    expect(err.message).toMatch(/cannot stand alone/);
  });

  it("validates fields inside raw strings exactly like structured ones", () => {
    const err = failure(bookshop, "Books", "titel eq 'x'");
    expect(err.code).toBe("unknown_field");
    expect(err.validOptions).toContain("title");
  });
});
