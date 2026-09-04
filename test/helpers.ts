import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseEdmx } from "../src/metadata/parse.js";
import type { ServiceModel } from "../src/metadata/model.js";

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(join(here, "fixtures", name), "utf8");
}

export function northwindModel(): ServiceModel {
  return parseEdmx(fixture("northwind.xml"), "https://services.odata.org/V4/Northwind/Northwind.svc");
}

export function bookshopModel(): ServiceModel {
  return parseEdmx(fixture("bookshop.xml"), "http://localhost:4004/odata/v4/catalog");
}

/** A fetch stub that answers from a queue of responses and records calls. */
export function fakeFetch(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string>; throw?: Error }>,
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const queue = [...responses];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift() ?? { status: 200, body: {} };
    if (next.throw) throw next.throw;
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {});
    return new Response(body, {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}
