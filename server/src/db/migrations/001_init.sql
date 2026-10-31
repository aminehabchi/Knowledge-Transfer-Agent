-- Identity ------------------------------------------------------------------
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  entra_oid     TEXT UNIQUE,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  is_manager    INTEGER NOT NULL DEFAULT 0,  -- may create projects and handover assignments
  is_active     INTEGER NOT NULL DEFAULT 1,
  is_synthetic  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Short-lived OIDC login state (state, nonce, PKCE verifier).
CREATE TABLE auth_requests (
  state          TEXT PRIMARY KEY,
  nonce          TEXT NOT NULL,
  code_verifier  TEXT NOT NULL,
  return_to      TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

-- Projects ------------------------------------------------------------------
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  client_name  TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL
);

CREATE TABLE project_members (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('manager','outgoing','incoming')),
  added_at    TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id, role)
);
CREATE INDEX project_members_user ON project_members(user_id);

-- Handovers -----------------------------------------------------------------
CREATE TABLE handovers (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(id),
  manager_id             TEXT NOT NULL REFERENCES users(id),
  outgoing_user_id       TEXT NOT NULL REFERENCES users(id),
  incoming_user_id       TEXT REFERENCES users(id),
  status                 TEXT NOT NULL CHECK (status IN ('draft','submitted','changes_requested','approved','cancelled')),
  content_json           TEXT NOT NULL,
  revision               INTEGER NOT NULL DEFAULT 0,
  current_version        INTEGER NOT NULL DEFAULT 0,
  approved_version       INTEGER,
  transfer_due_date      TEXT NOT NULL,
  onboarding_start_date  TEXT,
  author_attested_at     TEXT,
  submitted_at           TEXT,
  reviewed_at            TEXT,
  reviewed_by            TEXT REFERENCES users(id),
  review_comment         TEXT,
  approved_at            TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX handovers_project ON handovers(project_id);
-- At most one live handover per project & outgoing employee.
CREATE UNIQUE INDEX handovers_one_active
  ON handovers(project_id, outgoing_user_id) WHERE status NOT IN ('approved','cancelled');

CREATE TABLE handover_versions (
  handover_id   TEXT NOT NULL REFERENCES handovers(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  content_json  TEXT NOT NULL,
  submitted_by  TEXT NOT NULL REFERENCES users(id),
  submitted_at  TEXT NOT NULL,
  decision      TEXT CHECK (decision IN ('approved','changes_requested')),
  decided_by    TEXT REFERENCES users(id),
  decided_at    TEXT,
  PRIMARY KEY (handover_id, version)
);

CREATE TABLE handover_publications (
  handover_id      TEXT NOT NULL REFERENCES handovers(id),
  version          INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending','synced','failed')),
  adapter_mode     TEXT NOT NULL,
  remote_item_id   TEXT,
  remote_path      TEXT,
  web_url          TEXT,
  etag             TEXT,
  metadata_status  TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  synced_at        TEXT,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (handover_id, version)
);

-- Documents & retrieval -----------------------------------------------------
CREATE TABLE documents (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  adapter_mode      TEXT NOT NULL,
  remote_item_id    TEXT NOT NULL,
  name              TEXT NOT NULL,
  folder            TEXT NOT NULL,
  doc_type          TEXT NOT NULL,
  web_url           TEXT NOT NULL,
  etag              TEXT,
  version_label     TEXT,
  last_modified_at  TEXT,
  acl_json          TEXT,           -- NULL = all project members; else JSON array of lower-cased emails
  superseded        INTEGER NOT NULL DEFAULT 0,
  ingest_status     TEXT NOT NULL CHECK (ingest_status IN ('indexed','unsupported_format','error')),
  ingest_error      TEXT,
  flagged_chunks    INTEGER NOT NULL DEFAULT 0,
  indexed_at        TEXT NOT NULL,
  UNIQUE (adapter_mode, remote_item_id)
);
CREATE INDEX documents_project ON documents(project_id);

CREATE TABLE chunks (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  heading      TEXT NOT NULL,
  text         TEXT NOT NULL,
  provenance   TEXT,               -- for handover chunks: confirmed|reported|assumption|open_question
  flagged      INTEGER NOT NULL DEFAULT 0,
  flag_reason  TEXT
);
CREATE INDEX chunks_document ON chunks(document_id);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  chunk_id UNINDEXED,
  heading,
  text,
  tokenize = 'porter unicode61'
);

-- Assistant -----------------------------------------------------------------
CREATE TABLE assistant_messages (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  question     TEXT NOT NULL,
  answer_json  TEXT NOT NULL,
  provider     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX assistant_messages_user ON assistant_messages(project_id, user_id, created_at);

-- Jobs ----------------------------------------------------------------------
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','dead')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 6,
  run_at        TEXT NOT NULL,
  locked_until  TEXT,
  last_error    TEXT,
  dedupe_key    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX jobs_due ON jobs(status, run_at);
-- Only one queued/running job per dedupe key.
CREATE UNIQUE INDEX jobs_active_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');

-- Audit ---------------------------------------------------------------------
CREATE TABLE audit_events (
  id            TEXT PRIMARY KEY,
  occurred_at   TEXT NOT NULL,
  actor_id      TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  project_id    TEXT,
  outcome       TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','denied','failure')),
  details_json  TEXT
);
CREATE INDEX audit_events_time ON audit_events(occurred_at);
CREATE INDEX audit_events_project ON audit_events(project_id, occurred_at);

-- MOCK SharePoint store. Used ONLY by the clearly-labelled mock adapter in demo/test mode.
CREATE TABLE mock_sharepoint_items (
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  content        BLOB NOT NULL,
  content_type   TEXT NOT NULL,
  etag           TEXT NOT NULL,
  version        INTEGER NOT NULL,
  acl_json       TEXT,
  fields_json    TEXT,
  last_modified  TEXT NOT NULL
);
