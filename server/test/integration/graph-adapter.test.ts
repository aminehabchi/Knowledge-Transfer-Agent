import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GraphDocumentRepository } from "../../src/modules/sharepoint/graph-adapter.ts";
import { GraphClient, parseRetryAfter } from "../../src/modules/sharepoint/graph-client.ts";
import { IntegrationError } from "../../src/modules/sharepoint/types.ts";

type Handler = (url: URL, init: RequestInit) => Response | undefined;

/** A scripted fake of the Entra token endpoint and Microsoft Graph, recording every call. */
class FakeGraph {
  calls: { method: string; url: string; auth?: string }[] = [];
  tokensIssued = 0;
  files = new Map<string, { id: string; body: string; version: number }>();
  queue: Response[] = [];
  handlers: Handler[] = [];

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    this.calls.push({ method, url: url.pathname + url.search, auth: (init.headers as Record<string, string> | undefined)?.authorization });
    if (url.hostname === "login.example") {
      this.tokensIssued++;
      return Response.json({ access_token: `token-${this.tokensIssued}`, expires_in: 3600 });
    }
    const scripted = this.queue.shift();
    if (scripted) return scripted;
    for (const h of this.handlers) {
      const r = h(url, init);
      if (r) return r;
    }
    const m = /^\/v1\.0\/drives\/drive-1\/root:\/(.+):\/content$/.exec(decodeURIComponent(url.pathname));
    if (m && method === "PUT") {
      const path = m[1]!;
      const existing = this.files.get(path);
      const f = { id: existing?.id ?? `item-${this.files.size + 1}`, body: String(init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : init.body), version: (existing?.version ?? 0) + 1 };
      this.files.set(path, f);
      return Response.json({ id: f.id, name: path.split("/").pop(), webUrl: `https://contoso.sharepoint.com/sites/kt/${path}`, eTag: `"{x},${f.version}"`, lastModifiedDateTime: "2026-11-02T09:00:00Z", size: f.body.length, file: { mimeType: "text/markdown" } });
    }
    if (url.pathname.endsWith("/listItem/fields")) return Response.json({});
    return Response.json({ error: { code: "itemNotFound" } }, { status: 404 });
  };
}

function setup(fake = new FakeGraph(), opts: { setMetadata?: boolean } = {}) {
  const sleeps: number[] = [];
  const client = new GraphClient(
    { tenantId: "tenant", clientId: "client", clientSecret: "s3cr3t-value" },
    { fetchFn: fake.fetch as typeof fetch, sleep: async (ms) => void sleeps.push(ms), baseUrl: "https://graph.example/v1.0", loginBaseUrl: "https://login.example" },
  );
  const repo = new GraphDocumentRepository(client, { siteId: "site-1", driveId: "drive-1", rootFolder: "KnowledgeTransfer", setMetadata: opts.setMetadata ?? true });
  return { fake, repo, sleeps };
}

const upload = (repo: GraphDocumentRepository, body = "# Handover") =>
  repo.upload({ projectCode: "ORION", folder: "handover", fileName: "ORION-handover-v1.md", content: new TextEncoder().encode(body), contentType: "text/markdown", metadata: { KtaVersion: 1 } });

describe("Microsoft Graph adapter (against a fake Graph server)", () => {
  it("uploads to a deterministic path with conflictBehavior=replace and applies metadata", async () => {
    const { fake, repo } = setup();
    const res = await upload(repo);
    assert.equal(res.metadataStatus, "applied");
    assert.equal(res.item.path, "ORION/01-Handover/ORION-handover-v1.md");
    assert.match(res.item.webUrl, /^https:\/\/contoso\.sharepoint\.com/);
    const put = fake.calls.find((c) => c.method === "PUT")!;
    assert.match(put.url, /root:\/KnowledgeTransfer\/ORION\/01-Handover\/ORION-handover-v1\.md:\/content\?@microsoft\.graph\.conflictBehavior=replace/);
    assert.equal(put.auth, "Bearer token-1");
  });

  it("retrying the same upload replaces the item instead of creating a duplicate", async () => {
    const { fake, repo } = setup();
    const a = await upload(repo, "v1");
    const b = await upload(repo, "v1 retry");
    assert.equal(a.item.id, b.item.id);
    assert.equal(fake.files.size, 1);
  });

  it("caches the access token across requests", async () => {
    const { fake, repo } = setup();
    await upload(repo);
    await upload(repo);
    assert.equal(fake.tokensIssued, 1);
  });

  it("refreshes the token once when Graph answers 401", async () => {
    const { fake, repo } = setup();
    fake.queue.push(Response.json({ error: { code: "InvalidAuthenticationToken" } }, { status: 401 }));
    await upload(repo);
    assert.equal(fake.tokensIssued, 2);
  });

  it("honours Retry-After on 429 throttling and then succeeds", async () => {
    const { fake, repo, sleeps } = setup();
    fake.queue.push(new Response(null, { status: 429, headers: { "retry-after": "3" } }));
    await upload(repo);
    assert.deepEqual(sleeps, [3000]);
  });

  it("hands long throttling waits back to the job queue as a retryable error", async () => {
    const { fake, repo } = setup();
    fake.queue.push(new Response(null, { status: 429, headers: { "retry-after": "120" } }));
    await assert.rejects(upload(repo), (e: IntegrationError) => e.retryable && e.retryAfterMs === 120_000);
  });

  it("retries transient 5xx errors with backoff", async () => {
    const { fake, repo, sleeps } = setup();
    fake.queue.push(new Response(null, { status: 502 }), new Response(null, { status: 500 }));
    await upload(repo);
    assert.equal(sleeps.length, 2);
  });

  it("classifies 403 as a permanent permission failure without leaking the token", async () => {
    const { fake, repo } = setup();
    fake.queue.push(Response.json({ error: { code: "accessDenied" } }, { status: 403 }));
    await assert.rejects(upload(repo), (e: IntegrationError) => {
      assert.equal(e.retryable, false);
      assert.match(e.message, /permission denied.*accessDenied/);
      assert.doesNotMatch(e.message, /token-1|s3cr3t/);
      assert.doesNotMatch(e.message, /ORION-handover/); // file names are redacted from errors
      return true;
    });
  });

  it("keeps the document when metadata columns are missing, reporting metadataStatus=failed", async () => {
    const { fake, repo } = setup();
    fake.handlers.push((url) => (url.pathname.endsWith("/listItem/fields") ? Response.json({ error: { code: "invalidRequest" } }, { status: 400 }) : undefined));
    const res = await upload(repo);
    assert.equal(res.metadataStatus, "failed");
    assert.equal(fake.files.size, 1);
  });

  it("lists project folders following @odata.nextLink and treats missing folders as empty", async () => {
    const { fake, repo } = setup();
    const item = (id: string, name: string) => ({ id, name, webUrl: `https://x/${name}`, eTag: "e", lastModifiedDateTime: "2026-01-01T00:00:00Z", size: 1, file: { mimeType: "text/markdown" } });
    fake.handlers.push((url) => {
      const p = decodeURIComponent(url.pathname);
      if (p.includes("02-Project-Documents:/children") && !url.searchParams.has("page")) {
        return Response.json({ value: [item("a", "one.md"), { ...item("f", "sub"), file: undefined, folder: {} }], "@odata.nextLink": "https://graph.example/v1.0/next?page=2" });
      }
      if (url.pathname === "/v1.0/next") return Response.json({ value: [item("b", "two.md")] });
      return undefined;
    });
    const items = await repo.listProjectItems("ORION");
    assert.deepEqual(items.map((i) => [i.id, i.path]), [["a", "ORION/02-Project-Documents/one.md"], ["b", "ORION/02-Project-Documents/two.md"]]);
  });

  it("maps unique item permissions to an explicit ACL and inherited permissions to null", async () => {
    const { fake, repo } = setup();
    fake.handlers.push((url) => {
      if (url.pathname.endsWith("/items/inherited/permissions")) return Response.json({ value: [{ inheritedFrom: { path: "/x" }, grantedToV2: { user: { email: "a@x.com" } } }] });
      if (url.pathname.endsWith("/items/unique/permissions")) return Response.json({ value: [{ grantedToV2: { user: { email: "Maya.Chen@example.com" } } }, { grantedToV2: { siteUser: { email: "b@x.com" } } }] });
      return undefined;
    });
    assert.equal(await repo.getAcl("inherited"), null);
    assert.deepEqual(await repo.getAcl("unique"), ["maya.chen@example.com", "b@x.com"]);
  });

  it("reports health failures without throwing", async () => {
    const { fake, repo } = setup();
    fake.queue.push(Response.json({ error: { code: "accessDenied" } }, { status: 403 }));
    const h = await repo.health();
    assert.equal(h.ok, false);
    assert.equal(h.simulated, false);
  });

  it("parses Retry-After in seconds and HTTP-date form", () => {
    assert.equal(parseRetryAfter("5"), 5000);
    assert.equal(parseRetryAfter(null), undefined);
    assert.ok(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())! > 0);
  });
});
