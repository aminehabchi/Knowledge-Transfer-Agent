import type { Db } from "../../db/database.ts";
import { iso, newId, sha256, type Clock } from "../../lib/util.ts";
import {
  FOLDERS,
  IntegrationError,
  type DocumentRepository,
  type HealthStatus,
  type ItemAcl,
  type RemoteItem,
  type UploadRequest,
  type UploadResult,
} from "./types.ts";

/** URL scheme used for mock items so they can never be mistaken for real SharePoint links. */
export const MOCK_URL_SCHEME = "mock-sharepoint://";

/**
 * MOCK SharePoint adapter - SIMULATED. Stores files in the `mock_sharepoint_items` table so the
 * demo works without a Microsoft 365 tenant. It reproduces the behaviours the application relies
 * on (path-based replace semantics, versions, per-item ACLs, transient failures for tests) but it
 * is not SharePoint. Config validation refuses it when NODE_ENV=production.
 */
export class MockDocumentRepository implements DocumentRepository {
  readonly mode = "mock" as const;
  readonly simulated = true;
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly rootFolder: string;
  private faults: { remaining: number; error: IntegrationError } | null = null;

  constructor(db: Db, clock: Clock, rootFolder: string) {
    this.db = db;
    this.clock = clock;
    this.rootFolder = rootFolder;
  }

  /** Test hook: make the next `count` operations fail with `error`. */
  injectFaults(count: number, error: IntegrationError) {
    this.faults = { remaining: count, error };
  }

  private maybeFail() {
    if (this.faults && this.faults.remaining > 0) {
      this.faults.remaining--;
      throw this.faults.error;
    }
  }

  /** Seeds a document as if authored directly in SharePoint (synthetic demo data only). */
  seed(projectCode: string, folder: keyof typeof FOLDERS, name: string, content: string, acl: ItemAcl = null, lastModified?: Date) {
    return this.write(`${projectCode}/${FOLDERS[folder]}/${name}`, name, new TextEncoder().encode(content), "text/markdown", acl, {}, lastModified);
  }

  private write(path: string, name: string, content: Uint8Array, contentType: string, acl: ItemAcl, fields: Record<string, unknown>, lastModified?: Date) {
    const existing = this.db.prepare("SELECT id, version FROM mock_sharepoint_items WHERE path = ?").get(path);
    const version = existing ? Number(existing.version) + 1 : 1;
    const id = existing ? String(existing.id) : newId();
    const etag = `"${sha256(content).slice(0, 16)},${version}"`;
    const modified = iso(lastModified ?? this.clock.now());
    this.db
      .prepare(
        `INSERT INTO mock_sharepoint_items (id, path, name, content, content_type, etag, version, acl_json, fields_json, last_modified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET content = excluded.content, content_type = excluded.content_type, etag = excluded.etag,
           version = excluded.version, fields_json = excluded.fields_json, last_modified = excluded.last_modified`,
      )
      .run(id, path, name, content, contentType, etag, version, acl ? JSON.stringify(acl) : null, JSON.stringify(fields), modified);
    return this.toRemote(this.db.prepare("SELECT * FROM mock_sharepoint_items WHERE id = ?").get(id)!);
  }

  async upload(req: UploadRequest): Promise<UploadResult> {
    this.maybeFail();
    const path = `${req.projectCode}/${FOLDERS[req.folder]}/${req.fileName}`;
    const item = this.write(path, req.fileName, req.content, req.contentType, null, req.metadata);
    return { item, metadataStatus: "applied" };
  }

  async listProjectItems(projectCode: string): Promise<RemoteItem[]> {
    this.maybeFail();
    return this.db
      .prepare("SELECT * FROM mock_sharepoint_items WHERE path LIKE ? ORDER BY path")
      .all(`${projectCode.replace(/[%_]/g, "")}/%`)
      .map((r) => this.toRemote(r));
  }

  async download(itemId: string): Promise<Uint8Array> {
    this.maybeFail();
    const r = this.db.prepare("SELECT content FROM mock_sharepoint_items WHERE id = ?").get(itemId);
    if (!r) throw new IntegrationError("Item not found", { retryable: false, status: 404 });
    return new Uint8Array(r.content as Uint8Array);
  }

  async getAcl(itemId: string): Promise<ItemAcl> {
    this.maybeFail();
    const r = this.db.prepare("SELECT acl_json FROM mock_sharepoint_items WHERE id = ?").get(itemId);
    if (!r) throw new IntegrationError("Item not found", { retryable: false, status: 404 });
    return r.acl_json ? (JSON.parse(String(r.acl_json)) as string[]) : null;
  }

  async health(): Promise<HealthStatus> {
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM mock_sharepoint_items").get()!.n;
    return {
      mode: "mock",
      simulated: true,
      ok: true,
      detail: `MOCK adapter - simulated SharePoint (${n} item(s) in the local mock store). No Microsoft 365 connection.`,
      checkedAt: iso(this.clock.now()),
    };
  }

  private toRemote(r: Record<string, unknown>): RemoteItem {
    const path = String(r.path);
    return {
      id: String(r.id),
      name: String(r.name),
      path,
      folder: path.split("/")[1] ?? "",
      webUrl: `${MOCK_URL_SCHEME}${this.rootFolder}/${path}`,
      eTag: String(r.etag),
      versionLabel: `${r.version}.0`,
      lastModified: String(r.last_modified),
      size: (r.content as Uint8Array | undefined)?.byteLength ?? 0,
      contentType: String(r.content_type),
    };
  }
}
