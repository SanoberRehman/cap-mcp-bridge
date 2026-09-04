import type { EntitySet, Operation, Property, ServiceModel } from "./model.js";
import { shortTypeName } from "./types.js";

/** Render a ServiceModel as an indented tree. Used by `--print-model` and the M1 acceptance check. */
export function printModelTree(model: ServiceModel): string {
  const lines: string[] = [];
  lines.push(`${model.serviceUrl}  (OData ${model.odataVersion}, namespace ${model.namespace})`);
  lines.push(`entity sets (${model.entitySets.length})`);
  model.entitySets.forEach((set, i) => renderEntitySet(lines, set, i === model.entitySets.length - 1));

  if (model.functions.length > 0) {
    lines.push(`functions (${model.functions.length})`);
    model.functions.forEach((op, i) => renderOperation(lines, op, i === model.functions.length - 1));
  }
  if (model.actions.length > 0) {
    lines.push(`actions (${model.actions.length})`);
    model.actions.forEach((op, i) => renderOperation(lines, op, i === model.actions.length - 1));
  }
  if (model.enums.length > 0) {
    lines.push(`enums (${model.enums.length})`);
    model.enums.forEach((en, i) => {
      const last = i === model.enums.length - 1;
      lines.push(`${last ? "└─" : "├─"} ${en.name}: ${en.members.map((m) => m.name).join(" | ")}`);
    });
  }
  return lines.join("\n");
}

function renderEntitySet(lines: string[], set: EntitySet, last: boolean): void {
  const flags = [
    set.capabilities.insertable ? "C" : "-",
    "R",
    set.capabilities.updatable ? "U" : "-",
    set.capabilities.deletable ? "D" : "-",
  ].join("");
  const bits = [`[${flags}]`];
  if (set.draftEnabled) bits.push("draft");
  const label = set.label ? `  "${set.label}"` : "";
  lines.push(`${last ? "└─" : "├─"} ${set.name} (${set.entityType})${label}  ${bits.join(" ")}`);
  const pad = last ? "   " : "│  ";
  const filterable = new Set(set.capabilities.filterable);
  const sortable = new Set(set.capabilities.sortable);
  set.properties.forEach((p, i) => {
    const isLast = i === set.properties.length - 1 && set.navigations.length === 0;
    lines.push(`${pad}${isLast ? "└─" : "├─"} ${renderProperty(p, filterable.has(p.name), sortable.has(p.name))}`);
  });
  set.navigations.forEach((n, i) => {
    const isLast = i === set.navigations.length - 1;
    const card = n.isCollection ? "*" : "1";
    const target = n.targetSet ? `${n.targetSet}` : n.targetType;
    lines.push(`${pad}${isLast ? "└─" : "├─"} → ${n.name} [${card}] ${target}`);
  });
}

function renderProperty(p: Property, filterable: boolean, sortable: boolean): string {
  const tags: string[] = [];
  if (p.isKey) tags.push("key");
  if (!p.nullable && !p.isKey) tags.push("required");
  if (p.mandatory) tags.push("mandatory");
  if (p.readOnly) tags.push("readonly");
  if (p.sensitive) tags.push("sensitive");
  if (!filterable) tags.push("no-filter");
  if (!sortable) tags.push("no-sort");
  const type = p.isCollection ? `[${shortTypeName(p.type)}]` : shortTypeName(p.type);
  const label = p.label ? ` "${p.label}"` : "";
  return `${p.name}: ${type}${label}${tags.length ? `  (${tags.join(", ")})` : ""}`;
}

function renderOperation(lines: string[], op: Operation, last: boolean): void {
  const params = op.parameters.map((p) => `${p.name}: ${shortTypeName(p.type)}`).join(", ");
  const ret = op.returnType ? ` → ${op.returnType.isCollection ? "[" : ""}${shortTypeName(op.returnType.type)}${op.returnType.isCollection ? "]" : ""}` : "";
  const bound = op.boundTo ? ` bound to ${op.boundTo.entityType}${op.boundTo.isCollection ? "[]" : ""}` : "";
  lines.push(`${last ? "└─" : "├─"} ${op.name}(${params})${ret}${bound}`);
}
