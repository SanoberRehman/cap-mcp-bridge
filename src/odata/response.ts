/**
 * Response shaping: redaction of sensitive fields and the response size ceiling.
 * Truncation is never silent: the returned envelope says how many rows were dropped and why.
 */

import type { EntitySet, ServiceModel } from "../metadata/model.js";
import { findEntitySet, findEntitySetForType, findEntityType } from "../metadata/model.js";
import { matchesAny } from "../util/glob.js";

export const REDACTED = "[REDACTED]";

export interface RedactionPolicy {
  /** Property names or globs from configuration. */
  patterns: readonly string[];
}

type Row = Record<string, unknown>;

/**
 * Redact sensitive properties in place-safe copies of the rows. Walks expanded navigations using
 * the model so a sensitive field on `Customer` is redacted inside `Orders?$expand=Customer`.
 */
export function redactRows(model: ServiceModel, set: EntitySet | undefined, rows: unknown, policy: RedactionPolicy): unknown {
  if (Array.isArray(rows)) return rows.map((r) => redactRows(model, set, r, policy));
  if (!rows || typeof rows !== "object") return rows;

  const row = rows as Row;
  const out: Row = {};
  const props = new Map((set?.properties ?? []).map((p) => [p.name, p]));
  const navs = new Map((set?.navigations ?? []).map((n) => [n.name, n]));

  for (const [key, value] of Object.entries(row)) {
    const prop = props.get(key);
    if ((prop?.sensitive || matchesAny(policy.patterns, key)) && value !== null && value !== undefined) {
      out[key] = REDACTED;
      continue;
    }
    const nav = navs.get(key);
    if (nav && value && typeof value === "object") {
      const target =
        (nav.targetSet ? findEntitySet(model, nav.targetSet) : undefined) ??
        findEntitySetForType(model, nav.targetType) ??
        setFromType(model, nav.targetType);
      out[key] = redactRows(model, target, value, policy);
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // Complex type or unknown structure: still honour configured patterns by name.
      out[key] = redactRows(model, undefined, value, policy);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((v) => (v && typeof v === "object" ? redactRows(model, undefined, v, policy) : v));
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** A pseudo entity set for types that have no set (e.g. DraftAdministrativeData) so their properties still redact. */
function setFromType(model: ServiceModel, qualified: string): EntitySet | undefined {
  const t = findEntityType(model, qualified);
  if (!t) return undefined;
  return {
    name: t.name,
    entityType: t.name,
    keys: t.keys,
    properties: t.properties,
    navigations: t.navigations,
    capabilities: { insertable: false, updatable: false, deletable: false, filterable: [], sortable: [], searchable: false },
    draftEnabled: false,
  };
}

export interface TruncationResult<T> {
  rows: T[];
  dropped: number;
  bytes: number;
}

/**
 * Drop rows from the end until the serialised size fits. Always keeps at least one row so a
 * single oversized record is still returned (with a note) rather than an empty page.
 */
export function truncateRows<T>(rows: T[], maxBytes: number): TruncationResult<T> {
  let kept = rows;
  let bytes = byteLength(kept);
  if (bytes <= maxBytes || rows.length <= 1) return { rows: kept, dropped: 0, bytes };

  // Binary search for the largest prefix that fits.
  let lo = 1;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(rows.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  kept = rows.slice(0, lo);
  bytes = byteLength(kept);
  return { rows: kept, dropped: rows.length - kept.length, bytes };
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export interface CollectionEnvelope {
  entitySet: string;
  /** Total matching records reported by the service (`@odata.count`), when available. */
  count: number | null;
  returned: number;
  skip: number;
  top: number;
  results: unknown[];
  truncated: boolean;
  /** Pass as `skip` to fetch the next page. Absent when there is no more data. */
  nextSkip?: number;
  notes: string[];
}

export interface ShapeOptions {
  set: EntitySet;
  skip: number;
  top: number;
  topClamped: boolean;
  maxBytes: number;
  draftFilterApplied: boolean;
  policy: RedactionPolicy;
}

/** Turn a raw OData collection response into the envelope returned to the model. */
export function shapeCollection(model: ServiceModel, body: unknown, opts: ShapeOptions): CollectionEnvelope {
  const raw = (body ?? {}) as { value?: unknown[]; "@odata.count"?: number | string };
  const value = Array.isArray(raw.value) ? raw.value : [];
  const count = raw["@odata.count"] !== undefined ? Number(raw["@odata.count"]) : null;

  const redacted = redactRows(model, opts.set, value, opts.policy) as unknown[];
  const { rows, dropped } = truncateRows(redacted, opts.maxBytes);

  const notes: string[] = [];
  if (opts.topClamped) notes.push(`top was reduced to the maximum of ${opts.top}.`);
  if (opts.draftFilterApplied) notes.push("Draft-enabled entity: only active records are returned. Pass includeDrafts=true to include drafts.");
  if (dropped > 0) {
    notes.push(
      `Response truncated to stay under ${Math.round(opts.maxBytes / 1000)}KB: ${dropped} of ${value.length} fetched rows were dropped. ` +
        `Use select to request fewer fields, or a smaller top.`,
    );
  }

  const returned = rows.length;
  const fetchedAll = value.length < opts.top; // service returned fewer than asked: no further page
  const hasMore = dropped > 0 || !fetchedAll || (count !== null && opts.skip + value.length < count);
  const envelope: CollectionEnvelope = {
    entitySet: opts.set.name,
    count,
    returned,
    skip: opts.skip,
    top: opts.top,
    results: rows,
    truncated: dropped > 0 || hasMore,
    notes,
  };
  if (hasMore) {
    envelope.nextSkip = opts.skip + returned;
    if (dropped === 0 && count !== null) notes.push(`${count - (opts.skip + returned)} more records match. Pass skip=${envelope.nextSkip} for the next page.`);
  }
  return envelope;
}
