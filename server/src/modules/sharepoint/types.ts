export type AdapterMode = "graph" | "mock";

export const FOLDERS = {
  handover: "01-Handover",
  projectDocuments: "02-Project-Documents",
  onboarding: "03-Onboarding",
  reports: "04-Assessments-Reports",
} as const;
export type FolderKey = keyof typeof FOLDERS;

export interface RemoteItem {
  id: string;
  name: string;
  /** Path relative to the configured root folder, e.g. `PRJ-1/02-Project-Documents/runbook.md`. */
  path: string;
  folder: string;
  webUrl: string;
  eTag: string;
  versionLabel: string;
  lastModified: string;
  size: number;
  contentType: string;
}

/** `null` = inherits the project folder permissions (all project members). */
export type ItemAcl = string[] | null;

export interface UploadRequest {
  projectCode: string;
  folder: FolderKey;
  fileName: string;
  content: Uint8Array;
  contentType: string;
  /** Written to SharePoint list-item columns (see docs/SHAREPOINT.md for the column set). */
  metadata: Record<string, string | number>;
}

export interface UploadResult {
  item: RemoteItem;
  metadataStatus: "applied" | "skipped" | "failed";
  metadataError?: string;
}

export interface HealthStatus {
  mode: AdapterMode;
  simulated: boolean;
  ok: boolean;
  detail: string;
  checkedAt: string;
}

/**
 * Authoritative document store. Implementations: Microsoft Graph (production) and a
 * clearly-labelled mock (demo/test only; refused in production by config validation).
 */
export interface DocumentRepository {
  readonly mode: AdapterMode;
  readonly simulated: boolean;
  /** Idempotent: uploading to the same folder/file name replaces the content (new SharePoint version). */
  upload(req: UploadRequest): Promise<UploadResult>;
  listProjectItems(projectCode: string): Promise<RemoteItem[]>;
  download(itemId: string): Promise<Uint8Array>;
  getAcl(itemId: string): Promise<ItemAcl>;
  health(): Promise<HealthStatus>;
}

/** Integration failures; `retryable` decides whether the job queue retries. */
export class IntegrationError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(message: string, opts: { retryable: boolean; status?: number; retryAfterMs?: number }) {
    super(message);
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}
