import type { ServiceModel } from "./model.js";
import { log } from "../util/log.js";

export interface MetadataCacheOptions {
  /** Time-to-live for a parsed model. Default 15 minutes. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * In-memory, single-flight cache around a `ServiceModel` loader.
 * Concurrent callers during a (re)load share one in-flight promise, so a burst of tool calls at
 * startup produces exactly one `$metadata` request.
 */
export class MetadataCache {
  private model: ServiceModel | undefined;
  private loadedAt = 0;
  private inflight: Promise<ServiceModel> | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly loader: () => Promise<ServiceModel>,
    opts: MetadataCacheOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 15 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  get(): Promise<ServiceModel> {
    if (this.model && this.now() - this.loadedAt < this.ttlMs) return Promise.resolve(this.model);
    return this.refresh();
  }

  /** Force a reload. Callers already waiting on a load share its result. */
  refresh(): Promise<ServiceModel> {
    if (this.inflight) return this.inflight;
    const p = this.loader()
      .then((m) => {
        this.model = m;
        this.loadedAt = this.now();
        log.info("metadata loaded", {
          entitySets: m.entitySets.length,
          actions: m.actions.length,
          functions: m.functions.length,
        });
        return m;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    this.inflight = p;
    return p;
  }

  /** Current model if one is loaded, regardless of age. Used for synchronous lookups such as resource listing. */
  peek(): ServiceModel | undefined {
    return this.model;
  }

  invalidate(): void {
    this.model = undefined;
    this.loadedAt = 0;
  }
}
