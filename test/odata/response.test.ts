import { describe, expect, it } from "vitest";
import { REDACTED, redactRows, shapeCollection, truncateRows } from "../../src/odata/response.js";
import { findEntitySet } from "../../src/metadata/model.js";
import { bookshopModel } from "../helpers.js";

const model = bookshopModel();
const authors = findEntitySet(model, "Authors")!;
const books = findEntitySet(model, "Books")!;

describe("redaction", () => {
  it("redacts @PersonalData.IsPotentiallySensitive properties", () => {
    const out = redactRows(model, authors, [{ ID: "1", name: "Emily", email: "emily@example.com" }], { patterns: [] }) as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({ ID: "1", name: "Emily", email: REDACTED });
  });

  it("leaves nulls alone and redacts configured names and globs", () => {
    const out = redactRows(model, authors, { name: "Emily", email: null, placeOfBirth: "Thornton" }, { patterns: ["place*"] }) as Record<string, unknown>;
    expect(out).toEqual({ name: "Emily", email: null, placeOfBirth: REDACTED });
  });

  it("follows expanded navigations using the model", () => {
    const row = {
      ID: "b1",
      title: "Wuthering Heights",
      author: { ID: "a1", name: "Emily", email: "emily@example.com" },
      reviews: [{ ID: "r1", rating: 5, reviewer: "reader_one" }],
    };
    const out = redactRows(model, books, row, { patterns: [] }) as Record<string, Record<string, unknown> | Array<Record<string, unknown>>>;
    expect((out["author"] as Record<string, unknown>)["email"]).toBe(REDACTED);
    expect((out["author"] as Record<string, unknown>)["name"]).toBe("Emily");
    expect((out["reviews"] as Array<Record<string, unknown>>)[0]?.["reviewer"]).toBe(REDACTED);
  });
});

describe("truncation", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ ID: i, text: "x".repeat(100) }));

  it("keeps the largest prefix under the byte limit and reports what was dropped", () => {
    const { rows: kept, dropped, bytes } = truncateRows(rows, 2_000);
    expect(kept.length).toBeGreaterThan(5);
    expect(kept.length).toBeLessThan(100);
    expect(dropped).toBe(100 - kept.length);
    expect(bytes).toBeLessThanOrEqual(2_000);
  });

  it("always keeps at least one row", () => {
    expect(truncateRows(rows, 10).rows.length).toBe(1);
  });

  it("does nothing when the payload fits", () => {
    expect(truncateRows(rows.slice(0, 3), 100_000)).toEqual({ rows: rows.slice(0, 3), dropped: 0, bytes: expect.any(Number) });
  });
});

describe("shapeCollection", () => {
  const base = { set: books, skip: 0, top: 25, topClamped: false, maxBytes: 50_000, draftFilterApplied: false, policy: { patterns: [] } };

  it("reports count, nextSkip and notes", () => {
    const env = shapeCollection(model, { "@odata.count": 60, value: Array.from({ length: 25 }, (_, i) => ({ ID: i })) }, base);
    expect(env.count).toBe(60);
    expect(env.returned).toBe(25);
    expect(env.nextSkip).toBe(25);
    expect(env.truncated).toBe(true);
    expect(env.notes.join(" ")).toMatch(/35 more records match. Pass skip=25/);
  });

  it("has no nextSkip on the last page", () => {
    const env = shapeCollection(model, { "@odata.count": 3, value: [{ ID: 1 }, { ID: 2 }, { ID: 3 }] }, base);
    expect(env.nextSkip).toBeUndefined();
    expect(env.truncated).toBe(false);
  });

  it("explains size truncation explicitly and points nextSkip at the first dropped row", () => {
    const value = Array.from({ length: 25 }, (_, i) => ({ ID: i, text: "y".repeat(500) }));
    const env = shapeCollection(model, { "@odata.count": 25, value }, { ...base, maxBytes: 3_000 });
    expect(env.returned).toBeLessThan(25);
    expect(env.truncated).toBe(true);
    expect(env.nextSkip).toBe(env.returned);
    expect(env.notes.join(" ")).toMatch(/Response truncated/);
  });

  it("mentions draft filtering and clamped top", () => {
    const env = shapeCollection(model, { value: [] }, { ...base, draftFilterApplied: true, topClamped: true, top: 200 });
    expect(env.notes.join(" ")).toMatch(/only active records/);
    expect(env.notes.join(" ")).toMatch(/reduced to the maximum of 200/);
  });
});
