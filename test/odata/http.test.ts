import { describe, expect, it } from "vitest";
import { ODataHttpClient } from "../../src/odata/http.js";
import { ODataError } from "../../src/util/errors.js";
import { fakeFetch } from "../helpers.js";

const noSleep = async (): Promise<void> => undefined;

describe("ODataHttpClient retry policy", () => {
  it("retries GET on 503 and 429 with backoff, then succeeds", async () => {
    const f = fakeFetch([{ status: 503, body: "down" }, { status: 429, body: "slow", headers: { "retry-after": "0" } }, { body: { value: [1] } }]);
    const client = new ODataHttpClient({ baseUrl: "http://svc/", fetchImpl: f.fetch, sleep: noSleep });
    const res = await client.request<{ value: number[] }>({ method: "GET", path: "Books" });
    expect(res.data.value).toEqual([1]);
    expect(f.calls.length).toBe(3);
  });

  it("never retries a 4xx", async () => {
    const f = fakeFetch([{ status: 400, body: { error: { code: "bad", message: "Invalid $filter" } } }]);
    const client = new ODataHttpClient({ baseUrl: "http://svc", fetchImpl: f.fetch, sleep: noSleep });
    await expect(client.request({ method: "GET", path: "Books" })).rejects.toMatchObject({ status: 400, message: "Invalid $filter", odataCode: "bad" });
    expect(f.calls.length).toBe(1);
  });

  it("never retries a write, even on 503", async () => {
    const f = fakeFetch([{ status: 503, body: "down" }, { body: {} }]);
    const client = new ODataHttpClient({ baseUrl: "http://svc", fetchImpl: f.fetch, sleep: noSleep });
    await expect(client.request({ method: "POST", path: "Books", body: { title: "x" } })).rejects.toBeInstanceOf(ODataError);
    expect(f.calls.length).toBe(1);
  });

  it("gives up after maxRetries", async () => {
    const f = fakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
    const client = new ODataHttpClient({ baseUrl: "http://svc", fetchImpl: f.fetch, sleep: noSleep, maxRetries: 2 });
    await expect(client.request({ method: "GET", path: "Books" })).rejects.toMatchObject({ status: 500 });
    expect(f.calls.length).toBe(3);
  });

  it("maps timeouts to a structured error with a hint", async () => {
    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    const f = fakeFetch([{ throw: timeout }, { throw: timeout }, { throw: timeout }, { throw: timeout }]);
    const client = new ODataHttpClient({ baseUrl: "http://svc", fetchImpl: f.fetch, sleep: noSleep, maxRetries: 1, timeoutMs: 5 });
    await expect(client.request({ method: "GET", path: "Books" })).rejects.toMatchObject({ code: "odata_error", message: /timed out/ });
  });

  it("sends auth headers, OData version headers and JSON bodies", async () => {
    const f = fakeFetch([{ body: {} }]);
    const client = new ODataHttpClient({
      baseUrl: "http://svc",
      fetchImpl: f.fetch,
      auth: { kind: "test", headers: async () => ({ Authorization: "Bearer t" }) },
      extraHeaders: { "x-tenant": "a" },
    });
    await client.request({ method: "POST", path: "Books", body: { title: "x" } });
    const headers = f.calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer t");
    expect(headers["OData-Version"]).toBe("4.0");
    expect(headers["x-tenant"]).toBe("a");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(f.calls[0]?.init?.body).toBe('{"title":"x"}');
  });

  it("encodes query values and keeps $ option names readable", () => {
    const client = new ODataHttpClient({ baseUrl: "http://svc/" });
    expect(client.buildUrl("Books", { $filter: "title eq 'a b'", $top: 5, $skip: undefined })).toBe("http://svc/Books?$filter=title%20eq%20'a%20b'&$top=5");
  });
});
