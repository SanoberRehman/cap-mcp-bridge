import { describe, expect, it } from "vitest";
import {
  checkLiteral,
  edmToJsonSchema,
  formatLiteral,
  legalOpsFor,
  literalKind,
  toJsonValue,
} from "../../src/metadata/types.js";

describe("EDM type table", () => {
  it("maps Edm.Decimal to a string with an explanatory note", () => {
    const s = edmToJsonSchema("Edm.Decimal");
    expect(s.type).toBe("string");
    expect(s.note).toMatch(/precision/);
  });

  it("maps the documented primitives", () => {
    expect(edmToJsonSchema("Edm.String")).toEqual({ type: "string" });
    expect(edmToJsonSchema("Edm.Boolean")).toEqual({ type: "boolean" });
    expect(edmToJsonSchema("Edm.Guid")).toEqual({ type: "string", format: "uuid" });
    expect(edmToJsonSchema("Edm.Int16").type).toBe("integer");
    expect(edmToJsonSchema("Edm.Int32").type).toBe("integer");
    expect(edmToJsonSchema("Edm.Int64").type).toBe("integer");
    expect(edmToJsonSchema("Edm.Date")).toEqual({ type: "string", format: "date" });
    expect(edmToJsonSchema("Edm.DateTimeOffset")).toEqual({ type: "string", format: "date-time" });
    expect(edmToJsonSchema("Edm.TimeOfDay").type).toBe("string");
    expect(edmToJsonSchema("My.Complex").type).toBe("object");
  });

  it("keeps decimals as strings in JSON bodies and coerces numeric strings for integers", () => {
    expect(toJsonValue("decimal", 19.99)).toBe("19.99");
    expect(toJsonValue("decimal", "19.99")).toBe("19.99");
    expect(toJsonValue("number", "42")).toBe(42);
    expect(toJsonValue("boolean", "true")).toBe(true);
  });
});

describe("literal formatting and validation", () => {
  it("quotes text and escapes single quotes", () => {
    expect(formatLiteral("text", "O'Reilly")).toBe("'O''Reilly'");
  });

  it("leaves numbers, guids, dates and booleans bare", () => {
    expect(formatLiteral("number", 5)).toBe("5");
    expect(formatLiteral("decimal", "1000")).toBe("1000");
    expect(formatLiteral("guid", "6b1a0a2e-0003-4000-8000-000000000001")).toBe("6b1a0a2e-0003-4000-8000-000000000001");
    expect(formatLiteral("date", "2024-01-31")).toBe("2024-01-31");
    expect(formatLiteral("boolean", true)).toBe("true");
    expect(formatLiteral("text", null)).toBe("null");
  });

  it("formats enum literals with the qualified type", () => {
    expect(formatLiteral("enum", "Happy", "S.Mood")).toBe("S.Mood'Happy'");
  });

  it("rejects malformed literals with an expectation", () => {
    expect(checkLiteral("date", "31/01/2024").ok).toBe(false);
    expect(checkLiteral("date", "31/01/2024").expected).toMatch(/YYYY-MM-DD/);
    expect(checkLiteral("guid", "not-a-guid").ok).toBe(false);
    expect(checkLiteral("number", "abc").ok).toBe(false);
    expect(checkLiteral("number", "1000").ok).toBe(true);
    expect(checkLiteral("boolean", "yes").ok).toBe(false);
    expect(checkLiteral("datetime", "2024-01-31T10:00:00Z").ok).toBe(true);
    expect(checkLiteral("enum", "Angry", ["Happy", "Sad"]).expected).toMatch(/Happy, Sad/);
  });

  it("restricts operators by type", () => {
    expect(legalOpsFor("boolean")).not.toContain("gt");
    expect(legalOpsFor("number")).not.toContain("contains");
    expect(legalOpsFor("text")).toContain("contains");
    expect(legalOpsFor("date")).toContain("ge");
    expect(legalOpsFor("binary")).toEqual([]);
  });

  it("derives literal kinds from EDM types", () => {
    expect(literalKind("Edm.Decimal")).toBe("decimal");
    expect(literalKind("S.Mood", { isEnum: true })).toBe("enum");
    expect(literalKind("S.Address")).toBe("complex");
  });
});
