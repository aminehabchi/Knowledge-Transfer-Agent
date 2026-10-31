# Microsoft 365 setup: Entra ID, Graph and SharePoint

This guide activates the production integrations. Until it is done, the app runs in demo mode:
synthetic personas instead of Entra ID, and the **mock** SharePoint adapter instead of Graph.
`NODE_ENV=production` refuses to start in either demo mode.

Two app registrations keep sign-in and document access separate and least-privileged.

## 1. Sign-in app (`AUTH_MODE=entra`)

1. Entra admin center → **App registrations → New registration**
   * Name: `Knowledge Transfer Agent - Web`
   * Supported account types: *Accounts in this organizational directory only*
   * Redirect URI (Web): `https://<your-host>/api/auth/callback`
2. **Certificates & secrets** → new client secret. Store it in your secret manager and inject it
   as `ENTRA_CLIENT_SECRET`. Do not commit it.
3. **API permissions**: Microsoft Graph delegated `openid`, `profile`, `email` (defaults). No admin
   consent is needed for these.
4. **Token configuration** → add optional claim `email` to the ID token.
5. Set `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_REDIRECT_URI`.

The server runs the authorization-code flow with PKCE, verifies the ID token signature against the
tenant JWKS, and checks issuer, audience, expiry, nonce and tenant (`server/src/modules/identity/entra.ts`).
Users are matched by Entra object id, or by email the first time. Unknown users are refused unless
`ENTRA_AUTO_PROVISION=true`, which creates them without manager or admin rights.

## 2. Document app (`SHAREPOINT_MODE=graph`)

1. New registration `Knowledge Transfer Agent - SharePoint` (no redirect URI).
2. **API permissions → Microsoft Graph → Application permissions → `Sites.Selected`**, then
   **Grant admin consent**. `Sites.Selected` grants access to nothing until step 3.
3. Grant the app `write` on the one knowledge-transfer site only, for example with Microsoft Graph
   (run by a SharePoint admin):

   ```http
   POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
   Content-Type: application/json

   {
     "roles": ["write"],
     "grantedToIdentities": [{ "application": { "id": "<sharepoint-app-client-id>", "displayName": "Knowledge Transfer Agent - SharePoint" } }]
   }
   ```

4. Create a client secret (or, preferably, a certificate; certificate auth is not implemented yet)
   and inject `GRAPH_CLIENT_SECRET`.
5. Find the IDs:
   * `GET https://graph.microsoft.com/v1.0/sites/{hostname}:/sites/{site-path}` → `SHAREPOINT_SITE_ID`
   * `GET https://graph.microsoft.com/v1.0/sites/{site-id}/drives` → the document library's `id` → `SHAREPOINT_DRIVE_ID`

| Permission | Type | Why |
|---|---|---|
| `Sites.Selected` (+ site-level `write` grant) | Application | Upload approved handovers, list, download and read permissions of project documents on one site |
| `openid`, `profile`, `email` | Delegated | Sign-in |

Nothing else is requested. In particular the app does not use `Sites.ReadWrite.All` or `Mail.Send` yet.

## 3. SharePoint library layout

Create (or let the app create on first upload) this structure in the library:

```text
KnowledgeTransfer/                 (SHAREPOINT_ROOT_FOLDER)
  <PROJECT_CODE>/
    01-Handover/                   approved handovers, written by the app
    02-Project-Documents/          authored by the team: runbooks, architecture, requirements
    03-Onboarding/                 reserved (onboarding plans, later milestone)
    04-Assessments-Reports/        reserved (day-30 reports, later milestone)
```

**Permissions:** break inheritance on each `<PROJECT_CODE>` folder and grant only that project's
team. Documents that need tighter access (e.g. commercial terms) should get **unique permissions
naming individual users**. The indexer reads each item's permissions. Inherited means all project
members in the app; unique means only the listed users. Group grants on unique-permission items
are not expanded (`Sites.Selected` cannot read group membership), so those items are visible only
to explicitly listed users. This fails closed.

### Optional metadata columns

When `SHAREPOINT_SET_METADATA=true`, uploads set these library columns. Create them as
*Single line of text* (or *Number* for `KtaVersion`):

`KtaProjectCode`, `KtaDocType`, `KtaApprovalStatus`, `KtaVersion`, `KtaApprovedAt`, `KtaApprovedBy`

If the columns are missing, the document is still uploaded and the manager UI shows
"metadata could not be set".

## 4. Behaviour you can rely on

* Uploads go to a deterministic path with `@microsoft.graph.conflictBehavior=replace`, so a retry
  creates a new SharePoint version, never a duplicate file.
* 429/503/504 honour `Retry-After` (up to 30 s inline, longer waits go back to the job queue);
  5xx and network errors retry with backoff; 401 refreshes the token once; 403 is reported as a
  permanent permission problem and the publication is marked **failed** (managers can retry).
* Access tokens are cached in memory and never logged or included in error messages.

## 5. Verify

1. Set the variables, start the server, open **Manager dashboard → Integrations**. It should read
   *Connected to document library "…"*.
2. Approve a handover; its publication chip should turn *Published to SharePoint*, with a link
   that opens the real file.

This has been tested against a scripted fake of Graph (`server/test/integration/graph-adapter.test.ts`),
**not yet against a live tenant**. The first live run should happen on a test site.
