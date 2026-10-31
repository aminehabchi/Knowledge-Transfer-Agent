# Project status

_Last updated: 2026-10-31. Milestone 1 complete._

## Roadmap

| # | Milestone | Status |
|---|---|---|
| 1 | **Handover vertical slice**: identity & RBAC, projects/assignments, guided capture, review workflow, SharePoint publication, ingestion, grounded assistant, manager dashboard, audit | ✅ Done |
| 2 | **Onboarding & assessment**: 30-day plan generated from the approved handover (manager edits/activates), milestones/tasks/progress, question generation from sources with validation, practice quizzes, day-30 assessment with server-side scoring and answer-key protection | Next |
| 3 | **Day-30 reporting & notifications**: persistent scheduler, idempotent day-30 processing, manager report, Microsoft Graph `sendMail` adapter + outbox adapter, duplicate prevention, reschedule/cancel/manager-change handling | Planned |
| 4 | **Hardening & admin**: LLM-assisted interview (contradiction detection vs. documents), Office/PDF extraction, retention & deletion policies, admin role management UI, Graph certificate auth, PostgreSQL option, browser-level E2E (Playwright) | Planned |

## Completed in milestone 1

* **Identity**
  * Demo persona sign-in, refused in production.
  * Entra ID OIDC authorization-code + PKCE with JWKS verification.
  * Server-side sessions (hashed tokens) with CSRF protection and TTL.
* **Authorization**
  * Project-scoped roles (`manager`, `outgoing`, `incoming`) plus global `isManager` and `isAdmin` flags.
  * Non-members get 404.
  * Admin does not grant content access.
  * Denials are audited.
* **Handover capture**
  * Typed six-section schema.
  * Every list item carries a provenance label (`confirmed`, which needs a source, `reported`, `assumption` or `open_question`).
  * Completeness rules with focused follow-up questions, plus quality checks (ownerless tasks, undated critical tasks, decisions without rationale).
  * Autosave with optimistic concurrency.
  * Secret scanning rejects passwords, keys and tokens on save.
* **Workflow**
  * draft → submitted → changes_requested / approved / cancelled, as a pure, tested state machine.
  * Author attestation is required to submit.
  * The author cannot approve their own handover.
  * Each submission creates an immutable version.
  * Incoming employees see only the approved version.
* **SharePoint**
  * `DocumentRepository` interface with a Microsoft Graph adapter and a clearly labelled mock.
  * Deterministic, replace-on-conflict upload paths, so retries create no duplicates.
  * Metadata columns.
  * Throttling, transient error, token refresh and permission handling.
  * Publication status with a manager retry button.
* **Jobs**
  * Persistent queue in SQLite: leases, exponential backoff, `Retry-After`, dead-lettering, dedupe keys.
  * Recovers jobs after a crash or restart.
* **Retrieval**
  * Text extraction (md/txt/csv/json/html), with unsupported formats reported rather than guessed.
  * Heading-scoped chunking that never mixes provenance labels within a chunk.
  * FTS5/BM25 ranking.
  * Project and document-ACL filtering in SQL, applied before anything reaches a model.
  * Superseded handover versions excluded; stale-document flags.
  * Prompt-injection screening.
* **Assistant**
  * Provider interface with Claude (Anthropic SDK, structured JSON output, refusal fallback) and a local extractive provider.
  * The server enforces grounding:
    * invented citations are dropped
    * unsupported claims are removed
    * statement kinds are re-derived from sources
    * flagged passages are withheld with a warning
    * contacts come from the database, never the model
  * Per-user rate limit, persisted history, audit.
* **UI**
  * Role-aware home, capture wizard, manager review, manager dashboard (metrics from live data, filters, integration health), incoming workspace (approved handover, assistant with source links, source list), document viewer, admin audit and job health.
  * Light and dark themes, responsive, accessible labels and focus states.
* **Visual design (Medium-inspired)**
  * Reading-first layout: serif reading column (self-hosted Source Serif 4) for handovers, answers and documents, with a sans-serif interface.
  * Hairline dividers instead of boxed cards, pill buttons, green accent, underline tabs, feed-style home page, footnote-style citations.
  * UX practices: skip-to-content link, per-page browser titles, focus moved to the page on navigation, toasts after actions, inline confirmation before approving or cancelling, explanations next to disabled actions, friendly "not available to you" pages.
* **Presenter tools (demo mode only)**: floating demo script with live step tracking (`GET /api/demo/state`, which returns statuses only and is disabled outside demo mode), one-click persona switcher, "Insert example answer" for the deliberately blank fields, always-visible suggested questions. Light theme only.
* **Demo conversations**: `npm run seed` (or `npm run seed -- --chats` on an existing demo) adds scripted questions for Lina, Maya, Omar and Sam. The answers are produced by the real assistant under each persona's permissions.
* **Operations**
  * Env validation with production guards, structured logs with redaction, security headers/CSP, a static SPA server safe against path traversal, Dockerfile, seed and migrate scripts.

## Test results (2026-10-31)

* `npm test`: **107 passed, 0 failed** across 21 suites (unit, integration, security, e2e) in about 8 s.
* `npm run typecheck`: server and web clean. `vite build`: OK.
* Manual browser check (Chrome) of login, the capture wizard (autosave, secret rejection with inline error), the assistant (cited multi-step answer, injection warning), and the manager dashboard.
* The manual check found and fixed one bug: an effect returned the Promise that newer Chrome versions return from `scrollIntoView`, which crashed the page.
* Fixed: after switching demo personas, the app reopened the previous persona's page and showed "Handover not found". Sign-in and sign-out now go to the home page, and pages a user cannot access show a "not available to you" message with a link home.
* `docker build` succeeds. The container serves `/healthz` and the SPA in development mode, and refuses to start in production mode with demo settings, as intended.

## Integrations: real vs. simulated

| Integration | Implementation | Verified against |
|---|---|---|
| Entra ID sign-in | Real code | Locally signed JWTs (no tenant available) |
| SharePoint via Graph | Real code | Scripted fake Graph server (no tenant available) |
| SharePoint mock | Simulated, labelled in UI/API | Used by demo and tests |
| Claude (Anthropic) | Real code, typechecked against SDK 1.3.0 | **Not called**: no API key available |
| Extractive assistant | Real, non-generative | Tests |
| Email | Not implemented | - |

## Known limitations

* **No live Microsoft 365 or Anthropic verification yet.** The first live run should use a test site and test tenant.
* **Graph item ACLs:** group grants on uniquely-permissioned items are not expanded, so they fail closed. The app does not check SharePoint permissions per user at query time (on-behalf-of); it mirrors item ACLs at ingestion. ACL changes therefore apply on the next ingestion run. There is no periodic re-sync yet; managers can trigger one via `POST /api/projects/:id/reindex`.
* **Uploads over 4 MB** need a Graph upload session (not implemented). Handovers are small Markdown files.
* **Office/PDF documents** are listed as "format not supported" and are not indexed.
* **Contradiction detection** between handover and documents runs only with the Claude provider. The interview's follow-up questions are rule-based.
* **Single-node:** SQLite and the in-process rate limiter and job runner. Run one instance, or move to PostgreSQL and a shared limiter before scaling out.
* **Retention/deletion** policies and an admin UI for role assignment are not built. Roles are set in the DB or seed.
* **E2E tests** run against the HTTP API, not a real browser.

## Next steps (milestone 2)

1. Onboarding plan model: plan, milestones, tasks, resources. Generated from the approved handover with configurable day ranges, and editable/activatable by the manager.
2. Progress calculation and an incoming-employee roadmap view.
3. Question bank: generation from cited passages (LLM), with a validator (single correct answer, source required, duplicate detection) and manager review.
4. Attempts: server-side randomisation and scoring, answer key withheld until submission, topic-level results, remediation links.
5. Security tests for answer-key leakage and forged submissions.
