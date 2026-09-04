/**
 * Everything the model reads about an entity comes from here, and everything here comes from the
 * ServiceModel (i.e. from CDS annotations). Nothing is hand-written per service.
 */

import type { EntitySet, Operation, Property, ServiceModel } from "../metadata/model.js";
import { findEnum } from "../metadata/model.js";
import { edmToJsonSchema, shortTypeName } from "../metadata/types.js";

export interface PropertyDescription {
  name: string;
  type: string;
  format?: string;
  edmType: string;
  label?: string;
  description?: string;
  key: boolean;
  nullable: boolean;
  readOnly: boolean;
  mandatory: boolean;
  /** Always redacted in responses. */
  sensitive: boolean;
  filterable: boolean;
  sortable: boolean;
  maxLength?: number;
  enum?: string[];
  note?: string;
}

export interface NavigationDescription {
  name: string;
  target: string;
  cardinality: "one" | "many";
  label?: string;
  description?: string;
}

export interface OperationDescription {
  name: string;
  kind: "action" | "function";
  label?: string;
  description?: string;
  parameters: Array<{ name: string; type: string; edmType: string; required: boolean; label?: string; description?: string }>;
  returns?: string;
}

export interface EntityDescription {
  name: string;
  entityType: string;
  label?: string;
  description?: string;
  draftEnabled: boolean;
  keys: string[];
  capabilities: { insertable: boolean; updatable: boolean; deletable: boolean; searchable: boolean };
  filterable: string[];
  sortable: string[];
  properties: PropertyDescription[];
  navigations: NavigationDescription[];
  boundActions: OperationDescription[];
  boundFunctions: OperationDescription[];
  hints: string[];
}

export function describeProperty(model: ServiceModel, set: EntitySet, p: Property): PropertyDescription {
  const schema = edmToJsonSchema(p.type);
  const d: PropertyDescription = {
    name: p.name,
    type: p.isCollection ? `array<${schema.type}>` : schema.type,
    edmType: p.isCollection ? `Collection(${p.type})` : p.type,
    key: p.isKey,
    nullable: p.nullable,
    readOnly: p.readOnly,
    mandatory: p.mandatory,
    sensitive: p.sensitive,
    filterable: set.capabilities.filterable.includes(p.name),
    sortable: set.capabilities.sortable.includes(p.name),
  };
  if (schema.format) d.format = schema.format;
  if (p.label) d.label = p.label;
  if (p.description) d.description = p.description;
  if (p.maxLength !== undefined) d.maxLength = p.maxLength;
  if (schema.note) d.note = schema.note;
  if (p.enumType) {
    const en = findEnum(model, p.enumType);
    if (en) d.enum = en.members.map((m) => m.name);
  }
  return d;
}

export function describeOperation(op: Operation): OperationDescription {
  const d: OperationDescription = {
    name: op.name,
    kind: op.kind,
    parameters: op.parameters.map((p) => {
      const pd: OperationDescription["parameters"][number] = {
        name: p.name,
        type: p.isCollection ? `array<${edmToJsonSchema(p.type).type}>` : edmToJsonSchema(p.type).type,
        edmType: p.type,
        required: !p.nullable,
      };
      if (p.label) pd.label = p.label;
      if (p.description) pd.description = p.description;
      return pd;
    }),
  };
  if (op.label) d.label = op.label;
  if (op.description) d.description = op.description;
  if (op.returnType) d.returns = `${op.returnType.isCollection ? "array<" : ""}${op.returnType.type}${op.returnType.isCollection ? ">" : ""}`;
  return d;
}

export function describeEntity(model: ServiceModel, set: EntitySet): EntityDescription {
  const bound = (kind: "action" | "function"): OperationDescription[] =>
    (kind === "action" ? model.actions : model.functions)
      .filter((op) => op.isBound && op.boundTo?.entityType === set.entityType && !isDraftInternal(op))
      .map(describeOperation);

  const hints: string[] = [];
  if (set.draftEnabled) {
    hints.push("Draft-enabled: queries return only active records unless includeDrafts=true. Keys include IsActiveEntity (defaults to true).");
  }
  const sensitive = set.properties.filter((p) => p.sensitive).map((p) => p.name);
  if (sensitive.length) hints.push(`Redacted in responses (personal data): ${sensitive.join(", ")}.`);
  const decimals = set.properties.filter((p) => p.type === "Edm.Decimal").map((p) => p.name);
  if (decimals.length) hints.push(`Decimal fields are strings in responses and accept strings in filters: ${decimals.join(", ")}.`);

  const d: EntityDescription = {
    name: set.name,
    entityType: set.entityType,
    draftEnabled: set.draftEnabled,
    keys: set.keys.map((k) => k.name),
    capabilities: {
      insertable: set.capabilities.insertable,
      updatable: set.capabilities.updatable,
      deletable: set.capabilities.deletable,
      searchable: set.capabilities.searchable,
    },
    filterable: set.capabilities.filterable,
    sortable: set.capabilities.sortable,
    properties: set.properties.map((p) => describeProperty(model, set, p)),
    navigations: set.navigations.map((n) => {
      const nd: NavigationDescription = {
        name: n.name,
        target: n.targetSet ?? n.targetType,
        cardinality: n.isCollection ? "many" : "one",
      };
      if (n.label) nd.label = n.label;
      if (n.description) nd.description = n.description;
      return nd;
    }),
    boundActions: bound("action"),
    boundFunctions: bound("function"),
    hints,
  };
  if (set.label) d.label = set.label;
  if (set.description) d.description = set.description;
  return d;
}

/** CAP's draft lifecycle actions are plumbing, not business operations. */
export function isDraftInternal(op: Operation): boolean {
  return /\.(draftPrepare|draftActivate|draftEdit)$/.test(op.qualifiedName);
}

/* ------------------------------------------------------------------ */
/* Text used inside tool descriptions                                   */
/* ------------------------------------------------------------------ */

/** One line per entity set: `Orders — Customer orders (draft-enabled)`. */
export function entitySetLine(set: EntitySet): string {
  const bits: string[] = [];
  if (set.label && set.label !== set.name) bits.push(set.label);
  if (set.description) bits.push(set.description);
  const flags: string[] = [];
  if (set.draftEnabled) flags.push("draft-enabled");
  if (!set.capabilities.insertable && !set.capabilities.updatable && !set.capabilities.deletable) flags.push("read-only");
  const text = bits.join(": ");
  return `${set.name}${text ? ` — ${text}` : ""}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}

/** Compact property summary for a typed per-entity tool description. */
export function propertySummary(set: EntitySet, maxProps = 40): string {
  const lines = set.properties.slice(0, maxProps).map((p) => {
    const tags: string[] = [];
    if (p.isKey) tags.push("key");
    if (!set.capabilities.filterable.includes(p.name)) tags.push("not filterable");
    if (p.sensitive) tags.push("redacted");
    const label = p.label && p.label !== p.name ? ` "${p.label}"` : "";
    const type = p.type === "Edm.Decimal" ? "Decimal (string)" : shortTypeName(p.type);
    return `${p.name}: ${type}${label}${tags.length ? ` [${tags.join(", ")}]` : ""}`;
  });
  const more = set.properties.length > maxProps ? `, … ${set.properties.length - maxProps} more (see describe_entity)` : "";
  return lines.join("; ") + more;
}

export function navigationSummary(set: EntitySet): string {
  return set.navigations.map((n) => `${n.name} → ${n.targetSet ?? n.targetType}${n.isCollection ? " [many]" : ""}`).join("; ");
}
