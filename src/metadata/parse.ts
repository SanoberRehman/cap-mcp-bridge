/**
 * EDMX (OData v4 CSDL XML) → ServiceModel.
 *
 * This is the only file that knows XML element names, vocabulary term names and alias rules.
 * It is deliberately tolerant about *shape* (single vs. repeated elements, alias vs. namespace,
 * inline vs. external annotations) and deliberately strict about *version* (v2 is rejected).
 */

import { XMLParser } from "fast-xml-parser";
import { UnsupportedODataVersionError, BridgeError } from "../util/errors.js";
import { log } from "../util/log.js";
import type {
  ComplexType,
  EntityCapabilities,
  EntitySet,
  EntityType,
  EnumType,
  Navigation,
  Operation,
  Parameter,
  Property,
  ServiceModel,
} from "./model.js";
import { isPrimitive } from "./types.js";

/* ------------------------------------------------------------------ */
/* XML shapes (loosely typed; fast-xml-parser gives us plain objects)   */
/* ------------------------------------------------------------------ */

type Attrs = Record<string, string | undefined>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = Attrs & Record<string, any>;

const ARRAY_TAGS = new Set([
  "Reference",
  "Include",
  "Schema",
  "EntityType",
  "ComplexType",
  "EnumType",
  "Member",
  "Property",
  "NavigationProperty",
  "PropertyRef",
  "ReferentialConstraint",
  "EntityContainer",
  "EntitySet",
  "Singleton",
  "NavigationPropertyBinding",
  "ActionImport",
  "FunctionImport",
  "Action",
  "Function",
  "Parameter",
  "Annotations",
  "Annotation",
  "PropertyValue",
  "Record",
  "Collection",
  "PropertyPath",
  "NavigationPropertyPath",
  "Path",
  "String",
  "Bool",
  "Int",
  "EnumMember",
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (name) => ARRAY_TAGS.has(name),
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

/** Well-known vocabularies → the short alias everyone actually uses in annotations. */
const CANONICAL_ALIAS: Record<string, string> = {
  "Org.OData.Core.V1": "Core",
  "Org.OData.Capabilities.V1": "Capabilities",
  "Org.OData.Validation.V1": "Validation",
  "Org.OData.Measures.V1": "Measures",
  "Org.OData.Aggregation.V1": "Aggregation",
  "Org.OData.Authorization.V1": "Authorization",
  "com.sap.vocabularies.Common.v1": "Common",
  "com.sap.vocabularies.UI.v1": "UI",
  "com.sap.vocabularies.PersonalData.v1": "PersonalData",
  "com.sap.vocabularies.Analytics.v1": "Analytics",
  "com.sap.vocabularies.Communication.v1": "Communication",
  "com.sap.vocabularies.Session.v1": "Session",
  "com.sap.vocabularies.CodeList.v1": "CodeList",
  "com.sap.vocabularies.Hierarchy.v1": "Hierarchy",
  "com.sap.vocabularies.HTML5.v1": "HTML5",
  "com.sap.vocabularies.DataIntegration.v1": "DataIntegration",
  "com.sap.vocabularies.ODM.v1": "ODM",
  "com.sap.vocabularies.Graph.v1": "Graph",
  "com.sap.vocabularies.Temporal.v1": "Temporal",
};

/* ------------------------------------------------------------------ */
/* Public entry point                                                   */
/* ------------------------------------------------------------------ */

export function parseEdmx(xml: string, serviceUrl: string): ServiceModel {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (e) {
    throw new BridgeError({
      code: "metadata_parse_error",
      message: `Could not parse $metadata as XML: ${(e as Error).message}`,
    });
  }

  const edmx = doc["Edmx"] as Node | undefined;
  if (!edmx) {
    throw new BridgeError({
      code: "metadata_parse_error",
      message: "Response is not an EDMX document (no <edmx:Edmx> root). Is the URL the service root?",
      hint: "The bridge fetches {url}/$metadata. Point --url at the OData service root, not at an entity set.",
    });
  }

  detectVersionOrThrow(edmx);

  const dataServices = edmx["DataServices"] as Node | undefined;
  const schemas = (dataServices?.["Schema"] as Node[] | undefined) ?? [];
  if (schemas.length === 0) {
    throw new BridgeError({ code: "metadata_parse_error", message: "$metadata contains no <Schema> elements." });
  }

  const aliases = collectAliases(edmx, schemas);
  const ctx = new ParseContext(aliases);

  // Pass 1: raw type declarations, keyed by qualified name.
  for (const schema of schemas) {
    const ns = attr(schema, "Namespace") ?? "";
    for (const en of asArray(schema["EnumType"])) ctx.enums.set(`${ns}.${attr(en, "Name")}`, parseEnum(en, ns));
    for (const ct of asArray(schema["ComplexType"])) ctx.rawComplex.set(`${ns}.${attr(ct, "Name")}`, ct);
    for (const et of asArray(schema["EntityType"])) ctx.rawEntities.set(`${ns}.${attr(et, "Name")}`, et);
    for (const ann of asArray(schema["Annotations"])) ctx.collectExternalAnnotations(ann);
    for (const op of asArray(schema["Action"])) ctx.rawOperations.push({ node: op, kind: "action", ns });
    for (const op of asArray(schema["Function"])) ctx.rawOperations.push({ node: op, kind: "function", ns });
  }

  // Pass 2: resolve complex types, then entity types (with inheritance), then the container.
  for (const [name, node] of ctx.rawComplex) ctx.complexTypes.set(name, ctx.buildComplexType(name, node));
  for (const name of ctx.rawEntities.keys()) ctx.resolveEntityType(name);

  let containerNs = "";
  const entitySets: EntitySet[] = [];
  const operations: Operation[] = [];

  for (const schema of schemas) {
    const ns = attr(schema, "Namespace") ?? "";
    for (const container of asArray(schema["EntityContainer"])) {
      containerNs = ns;
      const containerName = attr(container, "Name") ?? "EntityContainer";
      const containerTarget = `${ns}.${containerName}`;

      for (const es of asArray(container["EntitySet"])) {
        for (const ann of asArray(es["Annotation"])) {
          ctx.addAnnotation(`${containerTarget}/${attr(es, "Name")}`, ann);
        }
        entitySets.push(ctx.buildEntitySet(es, containerTarget));
      }
      for (const single of asArray(container["Singleton"])) {
        log.debug(`Skipping singleton ${attr(single, "Name")}: singletons are not exposed as entity sets`);
      }
      for (const imp of asArray(container["ActionImport"])) {
        const op = ctx.buildUnboundOperation(imp, "action", containerTarget);
        if (op) operations.push(op);
      }
      for (const imp of asArray(container["FunctionImport"])) {
        const op = ctx.buildUnboundOperation(imp, "function", containerTarget);
        if (op) operations.push(op);
      }
    }
  }

  // Bound operations do not need an import.
  for (const raw of ctx.rawOperations) {
    if (attr(raw.node, "IsBound") !== "true") continue;
    const op = ctx.buildBoundOperation(raw.node, raw.kind, raw.ns);
    if (op) operations.push(op);
  }

  if (entitySets.length === 0) {
    log.warn("$metadata has an EntityContainer with no entity sets");
  }

  return {
    serviceUrl: serviceUrl.replace(/\/+$/, ""),
    odataVersion: attr(edmx, "Version") ?? "4.0",
    namespace: containerNs,
    entitySets,
    actions: operations.filter((o) => o.kind === "action"),
    functions: operations.filter((o) => o.kind === "function"),
    enums: [...ctx.enums.values()],
    complexTypes: [...ctx.complexTypes.values()],
    entityTypes: [...ctx.entityTypes.values()],
    fetchedAt: new Date(),
  };
}

/* ------------------------------------------------------------------ */
/* Version detection                                                    */
/* ------------------------------------------------------------------ */

function detectVersionOrThrow(edmx: Node): void {
  const version = attr(edmx, "Version");
  const dataServices = edmx["DataServices"] as Node | undefined;
  const dsVersion = dataServices ? attr(dataServices, "DataServiceVersion") : undefined;
  const schemaNs = (asArray(dataServices?.["Schema"])[0] as Node | undefined)?.["@_xmlns"];

  const isV2 =
    version === "1.0" ||
    (dsVersion !== undefined && dsVersion.startsWith("2")) ||
    (typeof schemaNs === "string" && schemaNs.includes("schemas.microsoft.com/ado"));

  if (isV2) throw new UnsupportedODataVersionError(`v2 (EDMX ${version ?? "?"}, DataServiceVersion ${dsVersion ?? "?"})`);
  if (version && !version.startsWith("4")) throw new UnsupportedODataVersionError(`version ${version}`);
}

/* ------------------------------------------------------------------ */
/* Aliases                                                              */
/* ------------------------------------------------------------------ */

interface AliasTable {
  /** alias → namespace */
  toNamespace: Map<string, string>;
  /** namespace → canonical alias used for term keys */
  toTermAlias: Map<string, string>;
}

function collectAliases(edmx: Node, schemas: Node[]): AliasTable {
  const toNamespace = new Map<string, string>();
  const toTermAlias = new Map<string, string>(Object.entries(CANONICAL_ALIAS));

  for (const ref of asArray(edmx["Reference"])) {
    for (const inc of asArray(ref["Include"])) {
      const ns = attr(inc, "Namespace");
      const alias = attr(inc, "Alias");
      if (!ns) continue;
      if (alias) toNamespace.set(alias, ns);
      if (!toTermAlias.has(ns)) toTermAlias.set(ns, alias ?? ns);
    }
  }
  for (const schema of schemas) {
    const ns = attr(schema, "Namespace");
    const alias = attr(schema, "Alias");
    if (ns && alias) toNamespace.set(alias, ns);
  }
  return { toNamespace, toTermAlias };
}

/* ------------------------------------------------------------------ */
/* Parse context: holds intermediate state for one document            */
/* ------------------------------------------------------------------ */

type AnnotationMap = Map<string, unknown>; // term → value

class ParseContext {
  readonly enums = new Map<string, EnumType>();
  readonly rawComplex = new Map<string, Node>();
  readonly rawEntities = new Map<string, Node>();
  readonly rawOperations: Array<{ node: Node; kind: "action" | "function"; ns: string }> = [];
  readonly complexTypes = new Map<string, ComplexType>();
  readonly entityTypes = new Map<string, EntityType>();
  /** Fully-qualified target → annotations. */
  readonly annotations = new Map<string, AnnotationMap>();

  constructor(private readonly aliases: AliasTable) {}

  /* ---- name resolution ---- */

  /** `Alias.Type` → `Namespace.Type`; `Collection(Alias.Type)` → `Collection(Namespace.Type)`. */
  resolveQualified(name: string): string {
    const coll = /^Collection\((.+)\)$/.exec(name);
    if (coll) return `Collection(${this.resolveQualified(coll[1] ?? "")})`;
    const dot = name.lastIndexOf(".");
    if (dot < 0) return name;
    const prefix = name.slice(0, dot);
    const ns = this.aliases.toNamespace.get(prefix);
    return ns ? `${ns}.${name.slice(dot + 1)}` : name;
  }

  /** Term names are keyed by canonical alias: `com.sap.vocabularies.Common.v1.Label` → `Common.Label`. */
  private normaliseTerm(term: string): string {
    const dot = term.lastIndexOf(".");
    if (dot < 0) return term;
    const prefix = term.slice(0, dot);
    const local = term.slice(dot + 1);
    const ns = this.aliases.toNamespace.get(prefix) ?? prefix;
    const alias = this.aliases.toTermAlias.get(ns) ?? CANONICAL_ALIAS[ns] ?? ns;
    return `${alias}.${local}`;
  }

  /** Annotation targets may use aliases in the namespace part: `Cat.Books/title` → `CatalogService.Books/title`. */
  private normaliseTarget(target: string): string {
    const slash = target.indexOf("/");
    const head = slash >= 0 ? target.slice(0, slash) : target;
    const tail = slash >= 0 ? target.slice(slash) : "";
    // Strip operation overload signatures: `ns.Action(ns.Type)` → `ns.Action`, `ns.Fn()` → `ns.Fn`.
    const paren = head.indexOf("(");
    const bare = paren >= 0 ? head.slice(0, paren) : head;
    return `${this.resolveQualified(bare)}${tail}`;
  }

  /* ---- annotations ---- */

  collectExternalAnnotations(block: Node): void {
    const target = attr(block, "Target");
    if (!target) return;
    const qualifier = attr(block, "Qualifier");
    for (const ann of asArray(block["Annotation"])) this.addAnnotation(target, ann, qualifier);
  }

  addAnnotation(target: string, ann: Node, blockQualifier?: string): void {
    const term = attr(ann, "Term");
    if (!term) return;
    const qualifier = attr(ann, "Qualifier") ?? blockQualifier;
    const key = qualifier ? `${this.normaliseTerm(term)}#${qualifier}` : this.normaliseTerm(term);
    const normTarget = this.normaliseTarget(target);
    let map = this.annotations.get(normTarget);
    if (!map) {
      map = new Map();
      this.annotations.set(normTarget, map);
    }
    map.set(key, annotationValue(ann));
  }

  ann(target: string, term: string): unknown {
    return this.annotations.get(target)?.get(term);
  }

  private labelOf(...targets: string[]): string | undefined {
    for (const t of targets) {
      const v = this.ann(t, "Common.Label") ?? this.ann(t, "Core.Description#Title");
      if (typeof v === "string" && v.length > 0) return humaniseI18n(v);
    }
    return undefined;
  }

  private descriptionOf(...targets: string[]): string | undefined {
    for (const t of targets) {
      const v = this.ann(t, "Core.Description") ?? this.ann(t, "Core.LongDescription") ?? this.ann(t, "Common.QuickInfo");
      if (typeof v === "string" && v.length > 0) return humaniseI18n(v);
    }
    return undefined;
  }

  /* ---- types ---- */

  buildProperty(node: Node, ownerTarget: string, isKey: boolean): Property {
    const name = attr(node, "Name") ?? "";
    const rawType = this.resolveQualified(attr(node, "Type") ?? "Edm.String");
    const coll = /^Collection\((.+)\)$/.exec(rawType);
    const type = coll ? (coll[1] ?? rawType) : rawType;
    const target = `${ownerTarget}/${name}`;
    for (const inline of asArray(node["Annotation"])) this.addAnnotation(target, inline);

    const fieldControl = this.ann(target, "Common.FieldControl");
    const mandatory =
      (typeof fieldControl === "string" && /Mandatory$/.test(fieldControl)) ||
      fieldControl === 7 ||
      fieldControl === "7";

    const sensitive =
      this.ann(target, "PersonalData.IsPotentiallySensitive") === true ||
      this.ann(target, "PersonalData.IsPotentiallyPersonal") === true;

    const prop: Property = {
      name,
      type,
      isCollection: Boolean(coll),
      nullable: attr(node, "Nullable") !== "false",
      isKey,
      readOnly: this.ann(target, "Core.Computed") === true || this.ann(target, "Core.Immutable") === true,
      mandatory,
      sensitive,
    };
    const maxLength = attr(node, "MaxLength");
    if (maxLength && maxLength !== "max") prop.maxLength = Number(maxLength);
    const precision = attr(node, "Precision");
    if (precision) prop.precision = Number(precision);
    const scale = attr(node, "Scale");
    if (scale && scale !== "variable" && scale !== "floating") prop.scale = Number(scale);
    const def = attr(node, "DefaultValue");
    if (def !== undefined) prop.defaultValue = def;
    const label = this.labelOf(target);
    if (label) prop.label = label;
    const description = this.descriptionOf(target);
    if (description) prop.description = description;
    if (this.enums.has(type)) prop.enumType = type;
    else if (!isPrimitive(type)) prop.complexType = type;
    return prop;
  }

  buildComplexType(name: string, node: Node): ComplexType {
    const props = asArray(node["Property"]).map((p) => this.buildProperty(p, name, false));
    const base = attr(node, "BaseType");
    if (base) {
      const baseName = this.resolveQualified(base);
      const baseNode = this.rawComplex.get(baseName);
      if (baseNode) {
        const parent = this.complexTypes.get(baseName) ?? this.buildComplexType(baseName, baseNode);
        this.complexTypes.set(baseName, parent);
        return { name, properties: [...parent.properties, ...props] };
      }
    }
    return { name, properties: props };
  }

  resolveEntityType(name: string): EntityType | undefined {
    const cached = this.entityTypes.get(name);
    if (cached) return cached;
    const node = this.rawEntities.get(name);
    if (!node) return undefined;

    for (const inline of asArray(node["Annotation"])) this.addAnnotation(name, inline);

    let inherited: EntityType | undefined;
    const baseAttr = attr(node, "BaseType");
    if (baseAttr) {
      inherited = this.resolveEntityType(this.resolveQualified(baseAttr));
      if (!inherited) log.warn(`Entity type ${name} has unknown BaseType ${baseAttr}`);
    }

    const keyNames = new Set<string>(
      asArray((node["Key"] as Node | undefined)?.["PropertyRef"]).map((r) => attr(r, "Name") ?? ""),
    );
    for (const k of inherited?.keys ?? []) keyNames.add(k.name);

    const ownProps = asArray(node["Property"]).map((p) => this.buildProperty(p, name, keyNames.has(attr(p, "Name") ?? "")));
    const ownNavs = asArray(node["NavigationProperty"]).map((n) => this.buildNavigation(n, name));

    const properties = mergeByName(inherited?.properties ?? [], ownProps);
    const navigations = mergeByName(inherited?.navigations ?? [], ownNavs);

    const et: EntityType = {
      name,
      keys: properties.filter((p) => keyNames.has(p.name)),
      properties,
      navigations,
    };
    if (baseAttr) et.baseType = this.resolveQualified(baseAttr);
    const label = this.labelOf(name) ?? inherited?.label;
    if (label) et.label = label;
    const description = this.descriptionOf(name) ?? inherited?.description;
    if (description) et.description = description;
    this.entityTypes.set(name, et);
    return et;
  }

  buildNavigation(node: Node, ownerTarget: string): Navigation {
    const name = attr(node, "Name") ?? "";
    const rawType = this.resolveQualified(attr(node, "Type") ?? "");
    const coll = /^Collection\((.+)\)$/.exec(rawType);
    const target = `${ownerTarget}/${name}`;
    for (const inline of asArray(node["Annotation"])) this.addAnnotation(target, inline);
    const nav: Navigation = {
      name,
      targetType: coll ? (coll[1] ?? rawType) : rawType,
      isCollection: Boolean(coll),
      nullable: attr(node, "Nullable") !== "false",
      referentialConstraints: asArray(node["ReferentialConstraint"]).map((rc) => ({
        property: attr(rc, "Property") ?? "",
        referencedProperty: attr(rc, "ReferencedProperty") ?? "",
      })),
    };
    const partner = attr(node, "Partner");
    if (partner) nav.partner = partner;
    const label = this.labelOf(target);
    if (label) nav.label = label;
    const description = this.descriptionOf(target);
    if (description) nav.description = description;
    return nav;
  }

  /* ---- container ---- */

  buildEntitySet(node: Node, containerTarget: string): EntitySet {
    const name = attr(node, "Name") ?? "";
    const typeName = this.resolveQualified(attr(node, "EntityType") ?? "");
    const et = this.resolveEntityType(typeName);
    if (!et) {
      throw new BridgeError({
        code: "metadata_parse_error",
        message: `Entity set ${name} references unknown entity type ${typeName}`,
      });
    }
    const setTarget = `${containerTarget}/${name}`;

    const bindings = new Map<string, string>();
    for (const b of asArray(node["NavigationPropertyBinding"])) {
      const path = attr(b, "Path");
      const target = attr(b, "Target");
      if (path && target) bindings.set(path, target);
    }
    const navigations = et.navigations.map((n) => {
      const bound = bindings.get(n.name);
      return bound ? { ...n, targetSet: bound } : { ...n };
    });

    const set: EntitySet = {
      name,
      entityType: typeName,
      keys: et.keys,
      properties: et.properties,
      navigations,
      capabilities: this.buildCapabilities(setTarget, typeName, et),
      draftEnabled: et.properties.some((p) => p.name === "IsActiveEntity"),
    };
    const label = this.labelOf(setTarget, typeName);
    if (label) set.label = label;
    const description = this.descriptionOf(setTarget, typeName);
    if (description) set.description = description;
    return set;
  }

  private buildCapabilities(setTarget: string, typeTarget: string, et: EntityType): EntityCapabilities {
    const rec = (term: string): Record<string, unknown> => {
      const v = this.ann(setTarget, term) ?? this.ann(typeTarget, term);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    };
    const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
    const paths = (v: unknown): Set<string> =>
      new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

    const insert = rec("Capabilities.InsertRestrictions");
    const update = rec("Capabilities.UpdateRestrictions");
    const del = rec("Capabilities.DeleteRestrictions");
    const filter = rec("Capabilities.FilterRestrictions");
    const sort = rec("Capabilities.SortRestrictions");
    const search = rec("Capabilities.SearchRestrictions");

    // Only primitive, non-collection properties can be filtered/sorted by name. Complex and binary
    // properties are excluded; navigation paths are validated separately by the query layer.
    const candidates = et.properties.filter(
      (p) => !p.isCollection && !p.complexType && p.type !== "Edm.Binary" && p.type !== "Edm.Stream",
    );

    const nonFilterable = paths(filter["NonFilterableProperties"]);
    const nonSortable = paths(sort["NonSortableProperties"]);
    const filterable = bool(filter["Filterable"], true) ? candidates.filter((p) => !nonFilterable.has(p.name)) : [];
    const sortable = bool(sort["Sortable"], true) ? candidates.filter((p) => !nonSortable.has(p.name)) : [];

    return {
      insertable: bool(insert["Insertable"], true),
      updatable: bool(update["Updatable"], true),
      deletable: bool(del["Deletable"], true),
      filterable: filterable.map((p) => p.name),
      sortable: sortable.map((p) => p.name),
      searchable: bool(search["Searchable"], true),
    };
  }

  /* ---- operations ---- */

  private findRawOperation(qualified: string, kind: "action" | "function", bound: boolean): Node | undefined {
    const dot = qualified.lastIndexOf(".");
    const ns = qualified.slice(0, dot);
    const local = qualified.slice(dot + 1);
    return this.rawOperations.find(
      (r) => r.kind === kind && r.ns === ns && attr(r.node, "Name") === local && (attr(r.node, "IsBound") === "true") === bound,
    )?.node;
  }

  buildUnboundOperation(importNode: Node, kind: "action" | "function", containerTarget: string): Operation | undefined {
    const importName = attr(importNode, "Name") ?? "";
    const qualified = this.resolveQualified(attr(importNode, kind === "action" ? "Action" : "Function") ?? "");
    const node = this.findRawOperation(qualified, kind, false);
    if (!node) {
      log.warn(`${kind} import ${importName} references unknown ${kind} ${qualified}`);
      return undefined;
    }
    for (const inline of asArray(importNode["Annotation"])) this.addAnnotation(`${containerTarget}/${importName}`, inline);
    const op = this.buildOperation(node, kind, qualified, importName);
    const label = this.labelOf(`${containerTarget}/${importName}`, qualified);
    if (label) op.label = label;
    const description = this.descriptionOf(`${containerTarget}/${importName}`, qualified);
    if (description) op.description = description;
    return op;
  }

  buildBoundOperation(node: Node, kind: "action" | "function", ns: string): Operation | undefined {
    const qualified = `${ns}.${attr(node, "Name")}`;
    const params = asArray(node["Parameter"]);
    const binding = params[0];
    if (!binding) {
      log.warn(`Bound ${kind} ${qualified} has no binding parameter; skipping`);
      return undefined;
    }
    const bindType = this.resolveQualified(attr(binding, "Type") ?? "");
    const coll = /^Collection\((.+)\)$/.exec(bindType);
    const op = this.buildOperation(node, kind, qualified, qualified, 1);
    op.isBound = true;
    op.boundTo = { entityType: coll ? (coll[1] ?? bindType) : bindType, isCollection: Boolean(coll) };
    const label = this.labelOf(qualified);
    if (label) op.label = label;
    const description = this.descriptionOf(qualified);
    if (description) op.description = description;
    return op;
  }

  private buildOperation(node: Node, kind: "action" | "function", qualified: string, name: string, skipParams = 0): Operation {
    for (const inline of asArray(node["Annotation"])) this.addAnnotation(qualified, inline);
    const parameters: Parameter[] = asArray(node["Parameter"])
      .slice(skipParams)
      .map((p) => {
        const pname = attr(p, "Name") ?? "";
        const target = `${qualified}/${pname}`;
        for (const inline of asArray(p["Annotation"])) this.addAnnotation(target, inline);
        const rawType = this.resolveQualified(attr(p, "Type") ?? "Edm.String");
        const coll = /^Collection\((.+)\)$/.exec(rawType);
        const param: Parameter = {
          name: pname,
          type: coll ? (coll[1] ?? rawType) : rawType,
          isCollection: Boolean(coll),
          nullable: attr(p, "Nullable") !== "false",
        };
        const label = this.labelOf(target);
        if (label) param.label = label;
        const description = this.descriptionOf(target);
        if (description) param.description = description;
        return param;
      });

    const op: Operation = { name, qualifiedName: qualified, kind, isBound: false, parameters };
    const rt = firstNode(node["ReturnType"]);
    if (rt) {
      const rawType = this.resolveQualified(attr(rt, "Type") ?? "");
      const coll = /^Collection\((.+)\)$/.exec(rawType);
      op.returnType = { type: coll ? (coll[1] ?? rawType) : rawType, isCollection: Boolean(coll) };
    }
    return op;
  }
}

/**
 * CAP emits untranslated labels as `{i18n>CreatedAt}` when no bundle is applied at compile time.
 * Turn the key into readable text (`Created At`) rather than leaking the placeholder into a tool description.
 */
export function humaniseI18n(text: string): string {
  const m = /^\{i18n>([^}]+)\}$/.exec(text.trim());
  if (!m) return text;
  const key = (m[1] ?? "").split(".").pop() ?? "";
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Enum + annotation value helpers                                      */
/* ------------------------------------------------------------------ */

function parseEnum(node: Node, ns: string): EnumType {
  return {
    name: `${ns}.${attr(node, "Name")}`,
    underlyingType: attr(node, "UnderlyingType") ?? "Edm.Int32",
    isFlags: attr(node, "IsFlags") === "true",
    members: asArray(node["Member"]).map((m, i) => ({
      name: attr(m, "Name") ?? "",
      value: attr(m, "Value") !== undefined ? Number(attr(m, "Value")) : i,
    })),
  };
}

/**
 * Reduce an <Annotation> (or <PropertyValue>) element to a JS value:
 *   attribute form  String="x" / Bool="true" / EnumMember="..."  → primitive
 *   <Collection>    → array
 *   <Record>        → object keyed by PropertyValue name
 *   child <String>  → primitive
 *   nothing         → true  (tag annotations like PersonalData.IsPotentiallySensitive)
 */
function annotationValue(node: Node): unknown {
  if (node["@_String"] !== undefined) return node["@_String"];
  if (node["@_Bool"] !== undefined) return node["@_Bool"] === "true";
  if (node["@_Int"] !== undefined) return Number(node["@_Int"]);
  if (node["@_Decimal"] !== undefined) return node["@_Decimal"];
  if (node["@_Float"] !== undefined) return Number(node["@_Float"]);
  if (node["@_EnumMember"] !== undefined) return node["@_EnumMember"];
  if (node["@_Path"] !== undefined) return node["@_Path"];
  if (node["@_PropertyPath"] !== undefined) return node["@_PropertyPath"];
  if (node["@_NavigationPropertyPath"] !== undefined) return node["@_NavigationPropertyPath"];
  if (node["@_AnnotationPath"] !== undefined) return node["@_AnnotationPath"];
  if (node["@_Date"] !== undefined) return node["@_Date"];
  if (node["@_DateTimeOffset"] !== undefined) return node["@_DateTimeOffset"];
  if (node["@_Guid"] !== undefined) return node["@_Guid"];

  const collection = firstNode(node["Collection"]);
  if (collection) return collectionValue(collection);
  const record = firstNode(node["Record"]);
  if (record) return recordValue(record);

  for (const tag of ["String", "Bool", "Int", "EnumMember", "Path", "PropertyPath", "Decimal"]) {
    const child = firstOf(node[tag]);
    if (child === undefined) continue;
    const text = typeof child === "string" ? child : ((child as Node)["#text"] as string | undefined) ?? "";
    if (tag === "Bool") return text === "true";
    if (tag === "Int") return Number(text);
    return text;
  }
  // Tag annotation without a value (e.g. <Annotation Term="PersonalData.IsPotentiallySensitive"/>).
  return true;
}

function collectionValue(node: Node): unknown[] {
  const out: unknown[] = [];
  for (const [tag, items] of Object.entries(node)) {
    if (tag.startsWith("@_")) continue;
    for (const item of asArray(items)) {
      if (tag === "Record") out.push(recordValue(item as Node));
      else if (typeof item === "string") out.push(item);
      else if (item && typeof item === "object") {
        const text = (item as Node)["#text"];
        out.push(typeof text === "string" ? text : annotationValue(item as Node));
      }
    }
  }
  return out;
}

function recordValue(node: Node): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pv of asArray(node["PropertyValue"])) {
    const prop = attr(pv, "Property");
    if (prop) out[prop] = annotationValue(pv);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tiny node helpers                                                    */
/* ------------------------------------------------------------------ */

function attr(node: Node | undefined, name: string): string | undefined {
  const v = node?.[`@_${name}`];
  return typeof v === "string" ? v : undefined;
}

function asArray(v: unknown): Node[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? (v as Node[]) : [v as Node];
}

function firstOf(v: unknown): Node | string | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v[0] as Node | string | undefined;
  return v as Node | string;
}

/** Like firstOf, but an empty element (parsed as "") counts as an empty node rather than text. */
function firstNode(v: unknown): Node | undefined {
  const f = firstOf(v);
  if (f === undefined) return undefined;
  return typeof f === "string" ? {} : f;
}

/** Derived (own) definitions override inherited ones with the same name; order is base-first. */
function mergeByName<T extends { name: string }>(base: T[], own: T[]): T[] {
  const ownNames = new Set(own.map((o) => o.name));
  return [...base.filter((b) => !ownNames.has(b.name)), ...own];
}
