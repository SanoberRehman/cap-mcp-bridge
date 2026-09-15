import { describe, expect, it } from "vitest";
import { printModelJson, printModelTree } from "../../src/metadata/print.js";
import type { ServiceModel } from "../../src/metadata/model.js";
import { bookshopModel, northwindModel } from "../helpers.js";

describe("printModelTree", () => {
  it("lists every entity set with its type and CRUD flags", () => {
    const out = printModelTree(northwindModel());
    expect(out).toContain("entity sets (26)");
    expect(out).toContain("Orders (NorthwindModel.Order)");
    expect(out).toMatch(/Products \(NorthwindModel\.Product\).*\[CRUD\]/);
  });

  it("marks draft-enabled sets", () => {
    const model = bookshopModel();
    const draft = model.entitySets.find((s) => s.draftEnabled);
    expect(draft).toBeDefined();
    const line = printModelTree(model)
      .split("\n")
      .find((l) => l.includes(` ${draft!.name} (`));
    expect(line).toContain("draft");
  });
});

describe("printModelJson", () => {
  it("is valid JSON carrying the whole model except fetchedAt", () => {
    const model = northwindModel();
    const parsed = JSON.parse(printModelJson(model)) as Omit<ServiceModel, "fetchedAt"> & { fetchedAt?: unknown };
    expect(parsed.fetchedAt).toBeUndefined();
    expect(parsed.serviceUrl).toBe(model.serviceUrl);
    expect(parsed.entitySets).toHaveLength(model.entitySets.length);
    const orders = parsed.entitySets.find((s) => s.name === "Orders");
    expect(orders?.keys).toEqual(model.entitySets.find((s) => s.name === "Orders")?.keys);
    expect(orders?.navigations.map((n) => n.name)).toContain("Customer");
  });

  it("is byte-identical across two parses of the same metadata, so runs can be diffed", () => {
    const a = printModelJson(northwindModel());
    const b = printModelJson(northwindModel());
    expect(a).toBe(b);
  });
});
