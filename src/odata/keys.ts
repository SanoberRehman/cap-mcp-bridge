/**
 * Key predicates: `Books(6b1a...)`, `Orders(ID=...,IsActiveEntity=true)`, `Currencies_texts(locale='en',code='EUR')`.
 */

import type { EntitySet } from "../metadata/model.js";
import { checkLiteral, formatLiteral, literalKind } from "../metadata/types.js";
import { ValidationError } from "../util/errors.js";

export type KeyInput = string | number | boolean | Record<string, string | number | boolean>;

export interface KeyPredicate {
  /** `(...)` including parentheses. */
  predicate: string;
  /** Normalised key values by property name, after draft defaults were applied. */
  values: Record<string, string | number | boolean>;
}

/**
 * Build a key predicate. For draft-enabled entities a missing `IsActiveEntity` defaults to `true`
 * (the active record), so a caller can address `Orders` by ID alone.
 */
export function buildKeyPredicate(set: EntitySet, key: KeyInput, opts: { includeDrafts?: boolean } = {}): KeyPredicate {
  const keyProps = set.keys;
  if (keyProps.length === 0) {
    throw new ValidationError({ code: "invalid_key", message: `${set.name} has no key properties; records cannot be addressed by key.`, target: set.name });
  }

  const values: Record<string, string | number | boolean> = {};
  if (typeof key === "object" && key !== null) {
    for (const [k, v] of Object.entries(key)) values[k] = v;
  } else {
    // A scalar: acceptable when there is exactly one "business" key (ignoring the draft flag).
    const business = keyProps.filter((p) => p.name !== "IsActiveEntity");
    if (business.length !== 1) {
      throw new ValidationError({
        code: "invalid_key",
        message: `${set.name} has a composite key (${keyProps.map((p) => p.name).join(", ")}); pass an object with every key property.`,
        target: set.name,
        validOptions: keyProps.map((p) => p.name),
      });
    }
    values[(business[0] as { name: string }).name] = key;
  }

  if (set.draftEnabled && values["IsActiveEntity"] === undefined) {
    values["IsActiveEntity"] = !opts.includeDrafts;
  }

  const missing = keyProps.filter((p) => values[p.name] === undefined).map((p) => p.name);
  if (missing.length > 0) {
    throw new ValidationError({
      code: "invalid_key",
      message: `Missing key propert${missing.length === 1 ? "y" : "ies"} for ${set.name}: ${missing.join(", ")}.`,
      target: set.name,
      validOptions: keyProps.map((p) => p.name),
    });
  }
  const unknown = Object.keys(values).filter((k) => !keyProps.some((p) => p.name === k));
  if (unknown.length > 0) {
    throw new ValidationError({
      code: "invalid_key",
      message: `${unknown.join(", ")} ${unknown.length === 1 ? "is not a key property" : "are not key properties"} of ${set.name}.`,
      target: set.name,
      validOptions: keyProps.map((p) => p.name),
    });
  }

  const parts = keyProps.map((p) => {
    const kind = literalKind(p.type, { isEnum: Boolean(p.enumType) });
    const v = values[p.name] as string | number | boolean;
    const check = checkLiteral(kind, v);
    if (!check.ok) {
      throw new ValidationError({
        code: "invalid_key",
        message: `Key "${p.name}" of ${set.name} is ${p.type}; value ${JSON.stringify(v)} is not valid: expected ${check.expected}.`,
        target: p.name,
      });
    }
    return `${p.name}=${formatLiteral(kind, v, p.enumType)}`;
  });

  const predicate =
    keyProps.length === 1
      ? `(${formatLiteral(literalKind((keyProps[0] as { type: string }).type, { isEnum: Boolean(keyProps[0]?.enumType) }), values[(keyProps[0] as { name: string }).name], keyProps[0]?.enumType)})`
      : `(${parts.join(",")})`;
  return { predicate, values };
}
