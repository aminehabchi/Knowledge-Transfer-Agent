import { GraphClient } from "./graph-client.ts";
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

interface DriveItem {
  id: string;
  name: string;
  webUrl: string;
  eTag: string;
  lastModifiedDateTime: string;
  size: number;
  file?: { mimeType: string };
  folder?: unknown;
}

interface Permission {
  inheritedFrom?: unknown;
  grantedToV2?: { user?: { email?: string }; siteUser?: { email?: string; loginName?: string } };
  grantedToIdentitiesV2?: { user?: { email?: string }; siteUser?: { email?: string } }[];
}

export interface GraphAdapterConfig {
  siteId: string;
  driveId: string;
  rootFolder: string;
  setMetadata: boolean;
}

const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/**
 * SharePoint document library access through Microsoft Graph.
 *
 * Required application permission: `Sites.Selected`, with this app granted `write` on the single
 * configured site (see docs/SHAREPOINT.md). Item-level unique permissions are read via
 * `/permissions` and enforced by the application's retrieval filter.
 */
export class GraphDocumentRepository implements DocumentRepository {
  readonly mode = "graph" as const;
  readonly simulated = false;
  private readonly client: GraphClient;
  private readonly cfg: GraphAdapterConfig;

  constructor(client: GraphClient, cfg: GraphAdapterConfig) {
    this.client = client;
    this.cfg = cfg;
  }

  private get drive() {
    return `/drives/${encodeURIComponent(this.cfg.driveId)}`;
  }

  private relPath(projectCode: string, folder: string, name?: string) {
    return [this.cfg.rootFolder, projectCode, folder, name].filter(Boolean).join("/");
  }

  async upload(req: UploadRequest): Promise<UploadResult> {
    if (req.content.byteLength > SIMPLE_UPLOAD_LIMIT) {
      throw new IntegrationError("Files over 4 MB require an upload session, which is not implemented yet", { retryable: false });
    }
    const folder = FOLDERS[req.folder];
    const path = this.relPath(req.projectCode, folder, req.fileName);
    // conflictBehavior=replace makes retries idempotent: the same path gets a new version, never a duplicate.
    const res = await this.client.request("PUT", `${this.drive}/root:/${encodePath(path)}:/content?@microsoft.graph.conflictBehavior=replace`, {
      body: req.content,
      headers: { "content-type": req.contentType },
    });
    const uploaded = (await res.json()) as DriveItem;
    const remote = this.toRemote(uploaded, `${req.projectCode}/${folder}/${req.fileName}`, folder);

    if (!this.cfg.setMetadata) return { item: remote, metadataStatus: "skipped" };
    try {
      await this.client.json("PATCH", `${this.drive}/items/${encodeURIComponent(uploaded.id)}/listItem/fields`, req.metadata);
      return { item: remote, metadataStatus: "applied" };
    } catch (err) {
      // Missing custom columns must not lose the document itself; the status is surfaced to managers.
      return { item: remote, metadataStatus: "failed", metadataError: err instanceof Error ? err.message : "unknown" };
    }
  }

  async listProjectItems(projectCode: string): Promise<RemoteItem[]> {
    const out: RemoteItem[] = [];
    for (const folder of Object.values(FOLDERS)) {
      let next: string | undefined =
        `${this.drive}/root:/${encodePath(this.relPath(projectCode, folder))}:/children?$select=id,name,webUrl,eTag,lastModifiedDateTime,size,file,folder&$top=200`;
      while (next) {
        let page: { value: DriveItem[]; "@odata.nextLink"?: string };
        try {
          page = await this.client.json("GET", next);
        } catch (err) {
          if (err instanceof IntegrationError && err.status === 404) break; // folder not created yet
          throw err;
        }
        for (const it of page.value) if (it.file) out.push(this.toRemote(it, `${projectCode}/${folder}/${it.name}`, folder));
        next = page["@odata.nextLink"];
      }
    }
    return out;
  }

  async download(itemId: string): Promise<Uint8Array> {
    const res = await this.client.request("GET", `${this.drive}/items/${encodeURIComponent(itemId)}/content`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async getAcl(itemId: string): Promise<ItemAcl> {
    const { value } = await this.client.json<{ value: Permission[] }>("GET", `${this.drive}/items/${encodeURIComponent(itemId)}/permissions`);
    const unique = value.filter((p) => !p.inheritedFrom);
    if (unique.length === 0) return null;
    // Unique permissions: only explicitly named users are allowed. Group grants cannot be expanded
    // with Sites.Selected, so they are conservatively not honoured (documented limitation).
    const emails = new Set<string>();
    for (const p of unique) {
      for (const g of [p.grantedToV2, ...(p.grantedToIdentitiesV2 ?? [])]) {
        const email = g?.user?.email ?? g?.siteUser?.email;
        if (email) emails.add(email.toLowerCase());
      }
    }
    return [...emails];
  }

  async health(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    try {
      const d = await this.client.json<{ name: string }>("GET", `${this.drive}?$select=id,name`);
      return { mode: "graph", simulated: false, ok: true, detail: `Connected to document library "${d.name}"`, checkedAt };
    } catch (err) {
      return { mode: "graph", simulated: false, ok: false, detail: err instanceof Error ? err.message : "unknown error", checkedAt };
    }
  }

  private toRemote(it: DriveItem, path: string, folder: string): RemoteItem {
    return {
      id: it.id,
      name: it.name,
      path,
      folder,
      webUrl: it.webUrl,
      eTag: it.eTag,
      versionLabel: it.eTag,
      lastModified: it.lastModifiedDateTime,
      size: it.size,
      contentType: it.file?.mimeType ?? "application/octet-stream",
    };
  }
}
