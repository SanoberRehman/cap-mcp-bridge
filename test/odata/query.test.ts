import { describe, expect, it } from "vitest";
import { buildQuery, requireEntitySet } from "../../src/odata/query.js";
import { buildKeyPredicate } from "../../src/odata/keys.js";
import { findEntitySet } from "../../src/metadata/model.js";
import type { ValidationError } from "../../src/util/errors.js";
import { bookshopModel, northwindModel } from "../helpers.js";

const bookshop = bookshopModel();
const northwind = northwindModel();
const limits = { defaultTop: 25, maxTop: 200 };

describe("buildQuery", () => {
  it("always requests a count and applies the default page size", () => {
    const q = buildQuery(bookshop, { entitySet: "Books" }, limits);
    expect(q.path).toBe("Books");
    expect(q.query).toEqual({ $top: "25", $count: "true" });
    expect(q.topClamped).toBe(false);
  });

  it("clamps top to the hard cap and reports it", () => {
    const q = buildQuery(bookshop, { entitySet: "Books", top: 5000, skip: 40 }, limits);
    expect(q.query["$top"]).toBe("200");
    expect(q.query["$skip"]).toBe("40");
    expect(q.topClamped).toBe(true);
  });

  it("injects IsActiveEntity eq true for draft-enabled entities unless includeDrafts", () => {
    expect(buildQuery(bookshop, { entitySet: "Orders" }, limits).query["$filter"]).toBe("IsActiveEntity eq true");
    expect(buildQuery(bookshop, { entitySet: "Orders", filter: { field: "customer", op: "eq", value: "Ada" } }, limits).query["$filter"]).toBe(
      "IsActiveEntity eq true and customer eq 'Ada'",
    );
    expect(
      buildQuery(
        bookshop,
        { entitySet: "Orders", filter: { or: [{ field: "customer", op: "eq", value: "Ada" }, { field: "customer", op: "eq", value: "Grace" }] } },
        limits,
      ).query["$filter"],
    ).toBe("IsActiveEntity eq true and (customer eq 'Ada' or customer eq 'Grace')");
    expect(buildQuery(bookshop, { entitySet: "Orders", includeDrafts: true }, limits).query["$filter"]).toBeUndefined();
    expect(buildQuery(bookshop, { entitySet: "Books" }, limits).draftFilterApplied).toBe(false);
  });

  it("adds key properties to $select so records stay addressable", () => {
    const q = buildQuery(bookshop, { entitySet: "Books", select: ["title", "price"] }, limits);
    expect(q.query["$select"]).toBe("title,price,ID");
    const drafts = buildQuery(bookshop, { entitySet: "Orders", select: ["customer"] }, limits);
    expect(drafts.query["$select"]).toBe("customer,ID,IsActiveEntity");
  });

  it("builds nested $expand and validates navigation names", () => {
    expect(buildQuery(bookshop, { entitySet: "Books", expand: ["author", "reviews"] }, limits).query["$expand"]).toBe("author,reviews");
    expect(buildQuery(bookshop, { entitySet: "Books", expand: ["author/books"] }, limits).query["$expand"]).toBe("author($expand=books)");
    expect(() => buildQuery(bookshop, { entitySet: "Books", expand: ["writer"] }, limits)).toThrow(/"writer" is not a navigation of Books/);
  });

  it("validates orderBy against sortable fields", () => {
    expect(buildQuery(bookshop, { entitySet: "Books", orderBy: [{ field: "price", dir: "desc" }, { field: "title" }] }, limits).query["$orderby"]).toBe(
      "price desc,title",
    );
    let err: ValidationError | undefined;
    try {
      buildQuery(bookshop, { entitySet: "Books", orderBy: [{ field: "author", dir: "asc" }] }, limits);
    } catch (e) {
      err = e as ValidationError;
    }
    expect(err?.code).toBe("unknown_field");
  });

  it("rejects an unknown entity set with a did-you-mean and the valid list", () => {
    let err: ValidationError | undefined;
    try {
      requireEntitySet(bookshop, "books");
    } catch (e) {
      err = e as ValidationError;
    }
    expect(err?.code).toBe("unknown_entity_set");
    expect(err?.message).toMatch(/did you mean Books/);
    expect(err?.validOptions).toContain("Authors");
  });

  it("rejects invalid paging values", () => {
    expect(() => buildQuery(bookshop, { entitySet: "Books", top: 0 }, limits)).toThrow(/positive integer/);
    expect(() => buildQuery(bookshop, { entitySet: "Books", skip: -1 }, limits)).toThrow(/non-negative/);
  });
});

describe("buildKeyPredicate", () => {
  it("formats single keys by type", () => {
    const books = findEntitySet(bookshop, "Books")!;
    expect(buildKeyPredicate(books, "6b1a0a2e-0003-4000-8000-000000000001").predicate).toBe("(6b1a0a2e-0003-4000-8000-000000000001)");
    const customers = findEntitySet(northwind, "Customers")!;
    expect(buildKeyPredicate(customers, "ALFKI").predicate).toBe("('ALFKI')");
    const orders = findEntitySet(northwind, "Orders")!;
    expect(buildKeyPredicate(orders, 10248).predicate).toBe("(10248)");
    expect(buildKeyPredicate(orders, "10248").predicate).toBe("(10248)");
  });

  it("defaults IsActiveEntity=true for draft entities addressed by business key", () => {
    const orders = findEntitySet(bookshop, "Orders")!;
    expect(buildKeyPredicate(orders, "6b1a0a2e-0005-4000-8000-000000000001").predicate).toBe(
      "(ID=6b1a0a2e-0005-4000-8000-000000000001,IsActiveEntity=true)",
    );
    expect(buildKeyPredicate(orders, "6b1a0a2e-0005-4000-8000-000000000001", { includeDrafts: true }).predicate).toBe(
      "(ID=6b1a0a2e-0005-4000-8000-000000000001,IsActiveEntity=false)",
    );
    expect(buildKeyPredicate(orders, { ID: "6b1a0a2e-0005-4000-8000-000000000001", IsActiveEntity: false }).predicate).toBe(
      "(ID=6b1a0a2e-0005-4000-8000-000000000001,IsActiveEntity=false)",
    );
  });

  it("handles composite keys and explains what is missing", () => {
    const texts = findEntitySet(bookshop, "Currencies_texts")!;
    expect(buildKeyPredicate(texts, { locale: "en", code: "EUR" }).predicate).toBe("(locale='en',code='EUR')");
    expect(() => buildKeyPredicate(texts, "en")).toThrow(/composite key/);
    expect(() => buildKeyPredicate(texts, { locale: "en" })).toThrow(/Missing key property for Currencies_texts: code/);
    expect(() => buildKeyPredicate(texts, { locale: "en", code: "EUR", extra: 1 })).toThrow(/not a key property/);
  });

  it("validates key literal formats", () => {
    const books = findEntitySet(bookshop, "Books")!;
    expect(() => buildKeyPredicate(books, "1")).toThrow(/GUID/);
  });
});
