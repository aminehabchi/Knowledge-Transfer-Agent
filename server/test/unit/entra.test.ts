import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { testConfig } from "../../src/config.ts";
import { migrate, openDatabase } from "../../src/db/database.ts";
import { EntraOidc, safeReturnTo } from "../../src/modules/identity/entra.ts";
import { TestClock } from "../helpers.ts";

const cfg = testConfig({ AUTH_MODE: "entra", ENTRA_TENANT_ID: "tenant-1", ENTRA_CLIENT_ID: "client-1", ENTRA_CLIENT_SECRET: "x", ENTRA_REDIRECT_URI: "http://localhost:3001/api/auth/callback" });

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new TestClock();
  const oidc = new EntraOidc(cfg, db, clock, { keys: createLocalJWKSet({ keys: [jwk] }) });
  const sign = (claims: Record<string, unknown>, opts: { aud?: string; iss?: string; exp?: number } = {}) =>
    new SignJWT({ tid: "tenant-1", oid: "oid-1", email: "Maya.Chen@example.com", name: "Maya", nonce: "n1", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? oidc.issuer)
      .setAudience(opts.aud ?? "client-1")
      .setIssuedAt(Math.floor(clock.t / 1000))
      .setExpirationTime(opts.exp ?? Math.floor(clock.t / 1000) + 3600)
      .sign(privateKey);
  return { oidc, sign, clock };
}

describe("Microsoft Entra ID token verification", () => {
  it("accepts a valid id_token and normalises the email", async () => {
    const { oidc, sign } = await setup();
    const id = await oidc.verifyIdToken(await sign({}), "n1");
    assert.deepEqual(id, { oid: "oid-1", tenantId: "tenant-1", email: "maya.chen@example.com", name: "Maya" });
  });

  const bad: [string, Parameters<Awaited<ReturnType<typeof setup>>["sign"]>][] = [
    ["wrong audience", [{}, { aud: "other-app" }]],
    ["wrong issuer", [{}, { iss: "https://login.microsoftonline.com/evil/v2.0" }]],
    ["wrong tenant", [{ tid: "evil" }]],
    ["wrong nonce", [{ nonce: "replayed" }]],
    ["missing oid", [{ oid: undefined }]],
  ];
  for (const [name, args] of bad) {
    it(`rejects tokens with ${name}`, async () => {
      const { oidc, sign } = await setup();
      await assert.rejects(oidc.verifyIdToken(await sign(...args), "n1"), /Sign-in with Microsoft Entra ID failed/);
    });
  }

  it("rejects expired tokens", async () => {
    const { oidc, sign, clock } = await setup();
    const token = await sign({});
    clock.advance(2 * 3600_000);
    await assert.rejects(oidc.verifyIdToken(token, "n1"));
  });

  it("builds a PKCE authorize URL and rejects unknown state on callback", async () => {
    const { oidc } = await setup();
    const url = new URL(oidc.beginLogin("/manager"));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("state") && url.searchParams.get("nonce"));
    await assert.rejects(oidc.completeLogin("unknown-state", "code"), /expired or is invalid/);
  });

  it("only allows same-origin relative return paths", () => {
    assert.equal(safeReturnTo("/onboarding"), "/onboarding");
    for (const v of ["https://evil.example", "//evil.example", "/\\evil", undefined]) assert.equal(safeReturnTo(v), "/");
  });
});

describe("configuration guards", () => {
  it("refuses demo auth and mock SharePoint in production", async () => {
    const { loadConfig } = await import("../../src/config.ts");
    assert.throws(() => loadConfig({ NODE_ENV: "production" }), /AUTH_MODE=demo is not allowed/);
    assert.throws(
      () => loadConfig({ NODE_ENV: "production", AUTH_MODE: "entra", ENTRA_TENANT_ID: "t", ENTRA_CLIENT_ID: "c", ENTRA_CLIENT_SECRET: "s", ENTRA_REDIRECT_URI: "https://x/cb" }),
      /SHAREPOINT_MODE=mock is not allowed/,
    );
  });

  it("requires all Graph settings when SHAREPOINT_MODE=graph", async () => {
    const { loadConfig } = await import("../../src/config.ts");
    assert.throws(() => loadConfig({ SHAREPOINT_MODE: "graph" }), /GRAPH_TENANT_ID.*SHAREPOINT_DRIVE_ID/);
  });
});
