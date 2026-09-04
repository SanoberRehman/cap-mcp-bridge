import { describe, expect, it } from "vitest";
import { BasicAuth, BearerAuth, ClientCredentialsAuth } from "../../src/odata/auth.js";
import { fakeFetch } from "../helpers.js";

describe("auth providers", () => {
  it("basic encodes username:password", async () => {
    expect(await new BasicAuth("alice", "s3cret").headers()).toEqual({ Authorization: `Basic ${Buffer.from("alice:s3cret").toString("base64")}` });
  });

  it("bearer passes the token through, with or without the prefix", async () => {
    expect(await new BearerAuth("abc").headers()).toEqual({ Authorization: "Bearer abc" });
    expect(await new BearerAuth("Bearer abc").headers()).toEqual({ Authorization: "Bearer abc" });
  });

  describe("oauth2 client credentials", () => {
    const opts = { tokenUrl: "https://idp/oauth/token", clientId: "id", clientSecret: "secret" };

    it("fetches one token for concurrent callers (single-flight)", async () => {
      const f = fakeFetch([{ body: { access_token: "t1", expires_in: 3600 } }]);
      const auth = new ClientCredentialsAuth({ ...opts, fetchImpl: f.fetch });
      const results = await Promise.all(Array.from({ length: 5 }, () => auth.headers()));
      expect(results.every((h) => h["Authorization"] === "Bearer t1")).toBe(true);
      expect(f.calls.length).toBe(1);
      const init = f.calls[0]?.init;
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
      expect(init?.body).toBe("grant_type=client_credentials");
    });

    it("refreshes 60s before expiry and not before", async () => {
      let now = 1_000_000;
      const f = fakeFetch([{ body: { access_token: "t1", expires_in: 300 } }, { body: { access_token: "t2", expires_in: 300 } }]);
      const auth = new ClientCredentialsAuth({ ...opts, fetchImpl: f.fetch, now: () => now });
      expect((await auth.headers())["Authorization"]).toBe("Bearer t1");
      now += 200_000; // 100s left: still valid
      expect((await auth.headers())["Authorization"]).toBe("Bearer t1");
      now += 50_000; // 50s left: inside the 60s leeway
      expect((await auth.headers())["Authorization"]).toBe("Bearer t2");
      expect(f.calls.length).toBe(2);
    });

    it("fails with a hint and without echoing the response body", async () => {
      const f = fakeFetch([{ status: 401, body: { error: "invalid_client", client_id: "id" } }]);
      const auth = new ClientCredentialsAuth({ ...opts, fetchImpl: f.fetch });
      await expect(auth.headers()).rejects.toMatchObject({ status: 401, message: expect.not.stringContaining("invalid_client"), hint: expect.stringMatching(/client id/) });
    });

    it("refuses incomplete configuration", () => {
      expect(() => new ClientCredentialsAuth({ tokenUrl: "", clientId: "id", clientSecret: "s" })).toThrow(/requires tokenUrl/);
    });
  });
});
