/**
 * ServiceModel — the contract between the metadata layer and everything above it.
 *
 * The parser produces this from EDMX. Tools, query building, validation and redaction all
 * consume it. Nothing above `metadata/` ever touches XML, vocabulary term names, or namespaces
 * beyond the qualified type names carried here.
 *
 * Everything is denormalised on purpose: an EntitySet carries its resolved keys, properties and
 * navigations (including anything inherited via BaseType) so consumers never walk a hierarchy.
 */

export interface Property {
  name: string;
  /** Qualified EDM type: `Edm.String`, `Edm.Decimal`, or a namespaced enum/complex type. */
  type: string;
  /** True for `Collection(...)` typed properties. */
  isCollection: boolean;
  nullable: boolean;
  isKey: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
  defaultValue?: string;
  /** From `@Common.Label` / `@title`. */
  label?: string;
  /** From `@Core.Description`. */
  description?: string;
  /** From `@Core.Computed` / `@Core.Immutable` (CAP `@readonly`). */
  readOnly: boolean;
  /** From `@Common.FieldControl: Mandatory` (CAP `@mandatory`). */
  mandatory: boolean;
  /** From `@PersonalData.IsPotentiallySensitive`. Always redacted from responses. */
  sensitive: boolean;
  /** Set when `type` refers to an EnumType in `ServiceModel.enums`. */
  enumType?: string;
  /** Set when `type` refers to a ComplexType in `ServiceModel.complexTypes`. */
  complexType?: string;
}

export interface Navigation {
  name: string;
  /** Qualified entity type the navigation points at. */
  targetType: string;
  /** Entity set the navigation is bound to, when the container declares a binding. */
  targetSet?: string;
  isCollection: boolean;
  nullable: boolean;
  /** Name of the partner navigation on the target, if declared. */
  partner?: string;
  label?: string;
  description?: string;
  /** Referential constraints: local property → target property. */
  referentialConstraints: Array<{ property: string; referencedProperty: string }>;
}

export interface EntityCapabilities {
  insertable: boolean;
  updatable: boolean;
  deletable: boolean;
  /** Property names that may appear in `$filter`. */
  filterable: string[];
  /** Property names that may appear in `$orderby`. */
  sortable: string[];
  /** Whether `$search` is supported. */
  searchable: boolean;
}

export interface EntityType {
  /** Qualified name, e.g. `CatalogService.Books`. */
  name: string;
  baseType?: string;
  keys: Property[];
  properties: Property[];
  navigations: Navigation[];
  label?: string;
  description?: string;
}

export interface EntitySet {
  name: string;
  /** Qualified entity type name. */
  entityType: string;
  keys: Property[];
  properties: Property[];
  navigations: Navigation[];
  /** From `@Common.Label` / `@title` on the set or its type. */
  label?: string;
  /** From `@Core.Description` on the set or its type. */
  description?: string;
  /** From the `@Capabilities.*` family, with sensible defaults where unannotated. */
  capabilities: EntityCapabilities;
  /** CAP draft-enabled: has `IsActiveEntity` (and usually `HasDraftEntity` / `DraftAdministrativeData`). */
  draftEnabled: boolean;
}

export interface Parameter {
  name: string;
  type: string;
  isCollection: boolean;
  nullable: boolean;
  label?: string;
  description?: string;
}

export interface Operation {
  /**
   * Callable name. For unbound operations this is the ActionImport / FunctionImport name
   * (what appears in the URL). For bound operations it is the qualified name, because bound
   * operations are addressed as `EntitySet(key)/Namespace.Name`.
   */
  name: string;
  qualifiedName: string;
  kind: "action" | "function";
  isBound: boolean;
  /** Present for bound operations: the entity type (and cardinality) they bind to. */
  boundTo?: { entityType: string; isCollection: boolean };
  /** Excludes the binding parameter. */
  parameters: Parameter[];
  returnType?: { type: string; isCollection: boolean };
  label?: string;
  description?: string;
}

export interface EnumType {
  /** Qualified name. */
  name: string;
  underlyingType: string;
  isFlags: boolean;
  members: Array<{ name: string; value: number }>;
}

export interface ComplexType {
  name: string;
  properties: Property[];
}

export interface ServiceModel {
  /** Service root the metadata was fetched from, without trailing slash. */
  serviceUrl: string;
  odataVersion: string;
  /** Namespace of the schema that owns the EntityContainer. */
  namespace: string;
  entitySets: EntitySet[];
  /** Unbound + bound actions. */
  actions: Operation[];
  /** Unbound + bound functions. */
  functions: Operation[];
  enums: EnumType[];
  complexTypes: ComplexType[];
  entityTypes: EntityType[];
  fetchedAt: Date;
}

/* ---- small lookup helpers so consumers never re-implement these ---- */

export function findEntitySet(model: ServiceModel, name: string): EntitySet | undefined {
  return model.entitySets.find((s) => s.name === name);
}

export function findEntityType(model: ServiceModel, qualifiedName: string): EntityType | undefined {
  return model.entityTypes.find((t) => t.name === qualifiedName);
}

export function findEnum(model: ServiceModel, qualifiedName: string): EnumType | undefined {
  return model.enums.find((e) => e.name === qualifiedName);
}

/** Entity set whose type matches, used to type expanded navigations that lack a binding. */
export function findEntitySetForType(model: ServiceModel, qualifiedType: string): EntitySet | undefined {
  return model.entitySets.find((s) => s.entityType === qualifiedType);
}

export function findOperation(model: ServiceModel, kind: "action" | "function", name: string): Operation | undefined {
  const list = kind === "action" ? model.actions : model.functions;
  return list.find((op) => op.name === name || op.qualifiedName === name);
}
