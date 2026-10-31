# Architecture

## 1. Starting point

The repository was empty when work began (2026-10-31). There was no existing code, framework,
database, or deployment target to reuse, so the architecture below is a greenfield proposal.
Toolchain available locally: Node 24, npm 11, Python 3.13, Docker 29. No Microsoft 365 tenant,
Entra app registration, or LLM API credentials were available during development.

## 2. Shape: modular monolith

One deployable Node.js service (`server/`) plus a React single-page app (`web/`) that the
server serves in production. Modules own their tables and expose services; HTTP routes are thin
adapters. No module reaches into another module's tables except through its service.

```text
server/src
  config.ts                 env parsing (zod), mode guards (demo vs production)
  db/                       node:sqlite connection, SQL migrations
  lib/                      errors, ids, secret scanning, rate limiting, http helpers
  modules/
    identity/               users, sessions, demo login, Entra ID OIDC, authorization policy
    audit/                  append-only audit events
    projects/               projects, memberships (project-scoped roles)
    handover/               content schema, completeness, workflow state machine, rendering
    sharepoint/             DocumentRepository interface, Graph adapter, MOCK adapter
    jobs/                   persistent job queue + runner (retries, leases, backoff)
    retrieval/              text extraction, chunking, FTS5 index, ACL-filtered search,
                            prompt-injection screening
    assistant/              LLM provider interface, Anthropic provider, extractive provider,
                            grounding/citation enforcement
    (later) onboarding/, assessment/, reporting/, notifications/, admin/
```

### Key decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Runtime | Node 24, TypeScript via native type stripping | No build step for the server; one language end-to-end |
| HTTP | Fastify 5 | Mature, fast, built-in structured logging (pino) with redaction |
| Validation | Zod 4 | Typed schemas shared by validation and inference |
| Database | Built-in `node:sqlite` (SQLite 3.53, WAL) with SQL migrations | Zero native deps, persistent, FTS5 available for retrieval. Repositories isolate SQL so a move to PostgreSQL is a contained change (see "Known limitations") |
| Retrieval | SQLite FTS5 / BM25 with SQL-side ACL filtering | Works offline, deterministic, testable. Embedding search is a later enhancement behind the same `search()` contract |
| Background work | Persistent `jobs` table with leases, retries, exponential backoff, dedupe keys | Survives restarts; no reliance on in-memory timers for correctness |
| LLM | `LlmProvider` interface; `anthropic` (Claude Opus 5.5) and `extractive` (local, non-generative, clearly labeled) | Provider is replaceable; demo works without credentials and never pretends to be an LLM |
| SharePoint | `DocumentRepository` interface; `graph` adapter (Microsoft Graph) and `mock` adapter (clearly labeled) | Real integration code path exists and is tested against a fake Graph server; mock is refused in production |
| Auth | `demo` (synthetic user picker) or `entra` (OIDC auth-code + PKCE, id_token verified with JWKS) | Demo is refused when `NODE_ENV=production` |
| Tests | `node:test` | No extra test dependency |

## 3. Security model

* **Authentication**: server-side sessions (random 256-bit token, only its SHA-256 stored),
  `HttpOnly` + `SameSite=Lax` cookie (`Secure` in production). Every mutating request must carry
  the session's CSRF token in `x-csrf-token`.
* **Authorization** lives in `modules/identity/policy.ts` and is called by services, not UI.
  Roles are **project-scoped** (`manager`, `outgoing`, `incoming`) via `project_members`;
  `admin` is global but grants configuration/audit access only, *not* project content.
* **Document ACLs**: each indexed document carries the principals allowed to read it
  (`NULL` = all members of the project). Retrieval filters by project *and* ACL in SQL before
  any passage reaches the model.
* **Prompt injection**: retrieved text is wrapped as untrusted data; instruction-like passages
  are withheld and surfaced as warnings; the model has no tools; model output is validated
  against a schema and every citation must reference a passage that was actually retrieved for
  that user, otherwise the claim is dropped.
* **Secrets**: handover content is scanned for credentials/keys/connection strings on every
  save and rejected (422) with the offending field paths. Logs redact cookies, authorization
  headers, and tokens.

## 4. Handover lifecycle

```text
draft ──submit(outgoing, complete + author attestation)──▶ submitted
changes_requested ──submit──▶ submitted
submitted ──approve(manager ≠ author)──▶ approved ──▶ [job] publish to SharePoint ──▶ [job] ingest
submitted ──request_changes(manager, comment)──▶ changes_requested
draft | changes_requested | submitted ──cancel(manager)──▶ cancelled
```

Each submit snapshots the content into `handover_versions`. The approved version is immutable
and is what incoming employees read and what is published to SharePoint at a deterministic path
(`<root>/<PROJECT>/01-Handover/<PROJECT>-handover-v<N>.md`, `conflictBehavior=replace`), so
retries never create duplicates.

Every content item carries a provenance label: `confirmed` (requires a source reference),
`reported` (outgoing employee statement), `assumption`, or `open_question`.

## 5. SharePoint folder layout

```text
<SHAREPOINT_ROOT_FOLDER>/<PROJECT_CODE>/
  01-Handover/                approved handover documents (versioned by file name + SharePoint versions)
  02-Project-Documents/       architecture, runbooks, requirements (authored in SharePoint)
  03-Onboarding/              onboarding plans (later milestone)
  04-Assessments-Reports/     day-30 reports (later milestone)
```

## 6. Known limitations of the chosen stack

* SQLite is single-node. Horizontal scaling requires PostgreSQL (planned migration path:
  repositories already isolate SQL; FTS5 → `tsvector` or a vector store).
* `node:sqlite` is still flagged as release-candidate in Node 24; it is pinned via `engines`.
* The in-process rate limiter is per instance.
