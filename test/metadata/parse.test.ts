import { describe, expect, it } from "vitest";
import { parseEdmx } from "../../src/metadata/parse.js";
import { findEntitySet } from "../../src/metadata/model.js";
import { UnsupportedODataVersionError } from "../../src/util/errors.js";
import { fixture, northwindModel, bookshopModel } from "../helpers.js";

describe("parseEdmx: Northwind (plain OData v4, no CAP annotations)", () => {
  const model = northwindModel();

  it("finds every entity set with keys, properties and navigations", () => {
    expect(model.entitySets.length).toBe(26);
    const orders = findEntitySet(model, "Orders");
    expect(orders).toBeDefined();
    expect(orders?.keys.map((k) => k.name)).toEqual(["OrderID"]);
    expect(orders?.properties.find((p) => p.name === "Freight")?.type).toBe("Edm.Decimal");
    const customer = orders?.navigations.find((n) => n.name === "Customer");
    expect(customer?.targetType).toBe("NorthwindModel.Customer");
    expect(customer?.targetSet).toBe("Customers");
    expect(customer?.isCollection).toBe(false);
    expect(orders?.navigations.find((n) => n.name === "Order_Details")?.isCollection).toBe(true);
  });

  it("resolves entity types across namespaces (container lives in a different schema)", () => {
    expect(model.namespace).toBe("ODataWebV4.Northwind.Model");
    expect(findEntitySet(model, "Products")?.entityType).toBe("NorthwindModel.Product");
  });

  it("defaults capabilities to fully writable and filterable when unannotated", () => {
    const products = findEntitySet(model, "Products");
    expect(products?.capabilities.insertable).toBe(true);
    expect(products?.capabilities.updatable).toBe(true);
    expect(products?.capabilities.deletable).toBe(true);
    expect(products?.capabilities.filterable).toContain("UnitPrice");
    expect(products?.capabilities.sortable).toContain("ProductName");
  });

  it("does not mark anything as draft-enabled", () => {
    expect(model.entitySets.every((s) => !s.draftEnabled)).toBe(true);
  });

  it("excludes binary properties from filterable/sortable", () => {
    const categories = findEntitySet(model, "Categories");
    expect(categories?.properties.find((p) => p.name === "Picture")?.type).toBe("Edm.Binary");
    expect(categories?.capabilities.filterable).not.toContain("Picture");
  });
});

describe("parseEdmx: CAP bookshop (annotations, drafts, enums, operations)", () => {
  const model = bookshopModel();

  it("extracts labels and descriptions from Common.Label / Core.Description", () => {
    const books = findEntitySet(model, "Books");
    expect(books?.label).toBe("Books");
    expect(books?.description).toMatch(/catalogue/);
    expect(books?.properties.find((p) => p.name === "stock")?.label).toBe("Stock");
    expect(books?.properties.find((p) => p.name === "stock")?.description).toMatch(/warehouse/);
  });

  it("maps @readonly to readOnly and @mandatory to mandatory", () => {
    const orders = findEntitySet(model, "Orders");
    expect(orders?.properties.find((p) => p.name === "orderNo")?.readOnly).toBe(true);
    expect(orders?.properties.find((p) => p.name === "customer")?.mandatory).toBe(true);
    expect(orders?.properties.find((p) => p.name === "customer")?.readOnly).toBe(false);
  });

  it("flags @PersonalData.IsPotentiallySensitive properties", () => {
    const authors = findEntitySet(model, "Authors");
    expect(authors?.properties.find((p) => p.name === "email")?.sensitive).toBe(true);
    expect(authors?.properties.find((p) => p.name === "name")?.sensitive).toBe(false);
  });

  it("reads Capabilities restrictions from the entity set", () => {
    const genres = findEntitySet(model, "Genres");
    expect(genres?.capabilities.insertable).toBe(false);
    expect(genres?.capabilities.updatable).toBe(false);
    expect(genres?.capabilities.deletable).toBe(false);
    const books = findEntitySet(model, "Books");
    expect(books?.capabilities.deletable).toBe(false);
    expect(books?.capabilities.insertable).toBe(true);
  });

  it("detects draft-enabled entities", () => {
    expect(findEntitySet(model, "Orders")?.draftEnabled).toBe(true);
    expect(findEntitySet(model, "Books")?.draftEnabled).toBe(false);
  });

  it("keeps Edm.Decimal as Edm.Decimal so the type table can turn it into a string", () => {
    const price = findEntitySet(model, "Books")?.properties.find((p) => p.name === "price");
    expect(price?.type).toBe("Edm.Decimal");
    expect(price?.precision).toBe(9);
    expect(price?.scale).toBe(2);
  });

  it("collects enum types and links properties to them", () => {
    const status = findEntitySet(model, "Books")?.properties.find((p) => p.name === "status");
    expect(status?.enumType).toBeUndefined(); // CAP emits string enums as Edm.String; no EnumType in EDMX
    expect(status?.type).toBe("Edm.String");
  });

  it("collects unbound functions/actions via imports and bound actions via the type", () => {
    const top = model.functions.find((f) => f.name === "topBooks");
    expect(top?.isBound).toBe(false);
    expect(top?.parameters.map((p) => `${p.name}:${p.type}`)).toEqual(["n:Edm.Int32"]);
    expect(top?.returnType).toEqual({ type: "CatalogService.Books", isCollection: true });
    expect(top?.label).toBe("Top books");
    expect(top?.description).toMatch(/highest stock/);

    const submit = model.actions.find((a) => a.name === "submitOrder");
    expect(submit?.parameters[0]?.type).toBe("Edm.Guid");

    const restock = model.actions.find((a) => a.qualifiedName === "CatalogService.restock");
    expect(restock?.isBound).toBe(true);
    expect(restock?.boundTo).toEqual({ entityType: "CatalogService.Books", isCollection: false });
    expect(restock?.parameters.map((p) => p.name)).toEqual(["amount"]);
  });

  it("resolves navigation targets to entity sets via bindings", () => {
    const books = findEntitySet(model, "Books");
    expect(books?.navigations.find((n) => n.name === "author")?.targetSet).toBe("Authors");
    expect(books?.navigations.find((n) => n.name === "reviews")?.isCollection).toBe(true);
  });
});

describe("parseEdmx: version handling", () => {
  it("rejects OData v2 metadata with a clear message", () => {
    expect(() => parseEdmx(fixture("northwind-v2.xml"), "https://services.odata.org/V2/Northwind/Northwind.svc")).toThrow(
      UnsupportedODataVersionError,
    );
    try {
      parseEdmx(fixture("northwind-v2.xml"), "x");
    } catch (e) {
      expect((e as Error).message).toMatch(/OData v2/);
      expect((e as Error).message).toMatch(/v4 only/);
    }
  });

  it("rejects non-EDMX documents", () => {
    expect(() => parseEdmx("<html><body>login</body></html>", "x")).toThrow(/not an EDMX/);
  });
});

describe("parseEdmx: annotation edge cases", () => {
  const xml = `<?xml version="1.0"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:Reference Uri="x"><edmx:Include Namespace="com.sap.vocabularies.Common.v1" Alias="Common"/></edmx:Reference>
  <edmx:Reference Uri="y"><edmx:Include Namespace="Org.OData.Capabilities.V1" Alias="Cap"/></edmx:Reference>
  <edmx:DataServices>
    <Schema Namespace="S" Alias="Self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityContainer Name="EntityContainer">
        <EntitySet Name="Things" EntityType="Self.Thing">
          <Annotation Term="Cap.FilterRestrictions">
            <Record><PropertyValue Property="NonFilterableProperties"><Collection><PropertyPath>secret</PropertyPath></Collection></PropertyValue></Record>
          </Annotation>
        </EntitySet>
        <EntitySet Name="Subs" EntityType="Self.Sub"/>
      </EntityContainer>
      <EntityType Name="Base"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.Guid" Nullable="false"/><Property Name="inherited" Type="Edm.String"/></EntityType>
      <EntityType Name="Thing" BaseType="Self.Base">
        <Property Name="name" Type="Edm.String">
          <Annotation Term="com.sap.vocabularies.Common.v1.Label" String="Inline label"/>
        </Property>
        <Property Name="secret" Type="Edm.String"/>
        <Property Name="mood" Type="Self.Mood"/>
      </EntityType>
      <EntityType Name="Sub" BaseType="Self.Thing"><Property Name="extra" Type="Edm.Int64"/></EntityType>
      <EnumType Name="Mood"><Member Name="Happy" Value="0"/><Member Name="Sad" Value="1"/></EnumType>
      <Annotations Target="Self.Thing/secret">
        <Annotation Term="com.sap.vocabularies.PersonalData.v1.IsPotentiallySensitive"/>
        <Annotation Term="Common.FieldControl" EnumMember="Common.FieldControlType/Mandatory"/>
      </Annotations>
      <Annotations Target="S.EntityContainer/Things"><Annotation Term="Common.Label" String="Set label"/></Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
  const model = parseEdmx(xml, "http://x");

  it("resolves schema aliases and include aliases to namespaces", () => {
    const things = findEntitySet(model, "Things");
    expect(things?.entityType).toBe("S.Thing");
    expect(things?.label).toBe("Set label");
    expect(things?.properties.find((p) => p.name === "name")?.label).toBe("Inline label");
  });

  it("applies capability annotations declared with a non-standard alias", () => {
    const things = findEntitySet(model, "Things");
    expect(things?.capabilities.filterable).not.toContain("secret");
    expect(things?.capabilities.filterable).toContain("name");
  });

  it("treats tag annotations as true and reads FieldControl enum members", () => {
    const secret = findEntitySet(model, "Things")?.properties.find((p) => p.name === "secret");
    expect(secret?.sensitive).toBe(true);
    expect(secret?.mandatory).toBe(true);
  });

  it("inherits keys and properties through BaseType chains", () => {
    const subs = findEntitySet(model, "Subs");
    expect(subs?.keys.map((k) => k.name)).toEqual(["ID"]);
    expect(subs?.properties.map((p) => p.name)).toEqual(["ID", "inherited", "name", "secret", "mood", "extra"]);
    expect(subs?.properties.find((p) => p.name === "secret")?.sensitive).toBe(true);
  });

  it("links enum-typed properties to their EnumType", () => {
    expect(findEntitySet(model, "Things")?.properties.find((p) => p.name === "mood")?.enumType).toBe("S.Mood");
    expect(model.enums[0]?.members.map((m) => m.name)).toEqual(["Happy", "Sad"]);
  });
});
