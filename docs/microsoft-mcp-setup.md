# Microsoft (Agent 365 / Work IQ) MCP setup

How to connect this repo's token-estimate script to the Microsoft **Agent 365 /
Work IQ** MCP servers (e.g. `mcp_WordServer`, `mcp_MailTools`,
`mcp_CalendarTools`) hosted at `https://agent365.svc.cloud.microsoft`.

These servers are **not** public. Every request — including the `initialize`
handshake — requires a Microsoft Entra bearer token, **and** the tenant must be
provisioned and the target server approved on the Microsoft side. The token
alone is not enough; three separate backends must all say "yes":

| Backend | Checks | Failure you'd see |
| --- | --- | --- |
| Microsoft Entra ID | Is the caller a valid app/user with the right scope? | `401`, `invalid_client` |
| BAP (Power Platform) | Is the tenant onboarded? Is the server approved? | `500` `TenantNotFound` |
| Work IQ MCP server | Does the token carry the server's scope? | `403` scope not present |

Work through the parts in order. Parts A–B are **one-time admin setup**; Part C
onward is per-developer.

---

## Prerequisites

- A **Microsoft 365 Copilot license** on every user that will sign in to call
  these servers. Without it, the Work IQ servers won't return tools even after
  everything else is configured.
  <https://www.microsoft.com/microsoft-365-copilot/pricing/individuals>
- A **Global Administrator** (or equivalent: Application Administrator +
  Power Platform Administrator) for Parts A and B.
- **PowerShell 7** (`pwsh`) for the provisioning script. It is cross-platform —
  works on Linux/macOS/Windows. On Ubuntu: `sudo snap install powershell --classic`.
- Node `^24` and `pnpm` for running the estimate script.

---

## Part A — One-time tenant provisioning (admin)

This is what makes the Microsoft backends recognize your tenant. Skipping any of
these produces the `500 TenantNotFound` error.

### A.1 Provision the Agent 365 Tools service principal

The Work IQ platform is fronted by a fixed Microsoft app,
**Agent 365 Tools** (`appId ea9ffc3e-8a23-4a7d-836d-234d7c7565c1`) — this is the
`aud` your token must target. It must have a service principal in your tenant.

1. Download
   [`New-Agent365ToolsServicePrincipalProdPublic.ps1`](https://github.com/microsoft/Agent365-devTools/blob/main/scripts/cli/Auth/New-Agent365ToolsServicePrincipalProdPublic.ps1).
2. Open **PowerShell 7 as Administrator** and `cd` to the script directory.
3. Run it:
   ```powershell
   ./New-Agent365ToolsServicePrincipalProdPublic.ps1
   ```
   The script auto-installs `Microsoft.Graph.Applications` and
   `Microsoft.Graph.Authentication` if missing, then calls
   `Connect-MgGraph -Scopes "Application.ReadWrite.All"`.

   On a **headless Linux** box the default browser sign-in won't open. Sign in
   with device code first, in the same session, then run the script:
   ```powershell
   Set-PSRepository -Name PSGallery -InstallationPolicy Trusted   # if prompted
   Connect-MgGraph -Scopes "Application.ReadWrite.All" -UseDeviceAuthentication
   ./New-Agent365ToolsServicePrincipalProdPublic.ps1
   ```
4. **Verify** it exists:
   ```powershell
   Get-MgServicePrincipal -Filter "appId eq 'ea9ffc3e-8a23-4a7d-836d-234d7c7565c1'"
   ```
   If this returns an object, the Entra side is done.

> Note: this only provisions the **Entra** service principal. BAP (Power
> Platform) is a separate backend — see A.2.

### A.2 Provision a Power Platform environment (Dataverse)

The server validates "MCP server approval status" by calling **BAP**
(`api.bap.microsoft.com`). BAP only knows your tenant if it has a Power Platform
environment. Without one, BAP returns `TenantNotFound` and you get a `500`.

1. Go to the **[Power Platform admin center](https://admin.powerplatform.microsoft.com/)**
   → **Environments** → **+ New**.
2. Create an environment with **"Create a database for this environment" = Yes**
   (provisions Dataverse).
3. Requires a Power Platform / Dynamics 365 admin or Global Admin.

### A.3 Approve the MCP server in the Microsoft 365 admin center

Each server must be approved for the tenant before its tools are reachable.

1. Go to the **[Microsoft 365 admin center](https://admin.microsoft.com/)** →
   **Agents → Tools**.
2. Use the **Registry** / **Requests** tab to approve the server you want (e.g.
   the Word server) and grant the required Entra permissions.

> Approval moved out of the Agent 365 CLI into the admin center — do it here, not
> via `develop-mcp approve`.

---

## Part B — Entra app registration (admin)

This is the **client** app your script authenticates as. Its client ID goes in
`.env` as `MSFT_CLIENT_ID`.

1. **[Microsoft Entra admin center](https://entra.microsoft.com/)** →
   **App registrations** → select or **New registration**.
2. On **Overview**, note the **Application (client) ID** and
   **Directory (tenant) ID** → these become `MSFT_CLIENT_ID` and
   `MSFT_TENANT_ID`.

### B.1 API permissions

1. **API permissions** → **Add a permission** → add the **delegated** scope for
   each server you want. The scope name matches the server, e.g.:
   - Word → `McpServers.Word.All`
   - Mail → `McpServers.Mail.All`
   - Calendar → `McpServers.Calendar.All`
2. Click **Grant admin consent for &lt;tenant&gt;**. If your tenant blocks user
   consent, this admin consent is mandatory — otherwise the interactive sign-in
   in Part D fails at the consent step.

### B.2 Authentication — enable public-client (device-code) flow

The Work IQ servers require a **delegated user token** (app-only tokens are
rejected — see [Why delegated auth](#why-delegated-auth)). This repo uses the
**device-code** flow, which is a *public-client* flow.

1. **Authentication** → **Advanced settings** → **Allow public client flows** →
   **Yes** → **Save**.
   *(If this is `No`, device code fails immediately with `invalid_client` /
   AADSTS7000218, because Entra expects a client secret the public flow never
   sends.)*
2. Under **Mobile and desktop applications**, add redirect URI
   `http://localhost:8080/callback`.

### B.3 Client secret (optional)

Only needed if you also use the app-only (client-credentials) flow
(`getMicrosoftMcpToken`). The Work IQ servers **don't** accept it, but it's used
for token inspection/debugging. **Certificates & secrets → New client secret →**
copy the *value* into `MSFT_CLIENT_SECRET`.

---

## Part C — Local configuration

Copy `.env.example` to `.env` and fill in the values noted above:

```dotenv
MSFT_TENANT_ID=<Directory (tenant) ID>
MSFT_CLIENT_ID=<Application (client) ID>
MSFT_CLIENT_SECRET=<client secret value>   # optional; app-only/debug only
# MSFT_MCP_SCOPE=https://agent365.svc.cloud.microsoft/.default   # optional override
```

`.env` is loaded by `dotenvx` (see the `run-estimate` script in `package.json`).

---

## Part D — Run the estimate

```bash
pnpm run-estimate
```

For a Work IQ server the entry in `mcp-token-estimate.ts` uses the **device-code**
resolver with the server's delegated scope.

On the first run it prints a **URL + device code** to the terminal:

1. Open the URL in any browser.
2. Sign in as a **Copilot-licensed** user.
3. Consent to the requested scope (e.g. `McpServers.Word.All`).

The handshake then completes and the script prints the token estimate. MSAL
caches the token in memory for the run.

---

## Why delegated auth

Work IQ servers act on a **user's** data (their Word docs, mailbox, calendar), so
they require a **delegated** (user-context) token whose `scp` claim contains the
server scope, e.g. `McpServers.Word.All`.

An **app-only** (client-credentials) token authenticates the *app*, not a user —
it can never carry a delegated `scp`, and these servers don't expose the scopes
as application roles. So `getMicrosoftMcpToken` (client credentials) will always
get `403 "Scope 'McpServers.Word.All' is not present in the request."` for these
servers. Use `getMicrosoftMcpTokenDeviceCode` instead. See `msft-oauth.ts` for
both implementations.

---

## Troubleshooting

Errors surface in order as you fix each layer. Add response-body logging to
`fetchToolsHttp` (print `await res.text()` on non-OK responses) to see the exact
message instead of just the HTTP status.

| Symptom | Real cause | Fix |
| --- | --- | --- |
| `500` — `TenantNotFound` / "Error validating MCP server approval status" | Tenant not onboarded to BAP / Power Platform, or server not approved | Part A.2 (Power Platform environment) + A.3 (approve server) |
| `500` — `TenantNotFound` persists after A.1 | A.1 only fixes the Entra SP; BAP is separate | Do A.2 as well |
| `403` — `Scope 'McpServers.Word.All' is not present` | Using an app-only token; delegated scope missing | Switch to `getMicrosoftMcpTokenDeviceCode` with the explicit scope (Part D) |
| `invalid_client` / AADSTS7000218 at device-code start (before any browser) | "Allow public client flows" is disabled on the app registration | Part B.2 |
| Consent prompt blocked during sign-in | Tenant blocks user consent | Admin grants consent on the delegated permission (Part B.1) |
| `401 Unauthorized` | Missing/invalid token, wrong `aud`, or unlicensed user | Verify `MSFT_MCP_SCOPE` targets `agent365.svc.cloud.microsoft`, and the user has a Copilot license |
| "server not found" after auth succeeds | Wrong URL segment (`mcp_...`) | Confirm the identifier via `a365 develop list-available` |

### Inspecting a token

To decode what your token actually carries (audience, `idtyp`, `roles`, `scp`):

```js
const [, payload] = token.split(".")
console.log(JSON.parse(Buffer.from(payload, "base64url").toString()))
```

- `idtyp: "app"` + empty `scp` → app-only token → will 403 on Work IQ servers.
- `idtyp: "user"` + `scp` includes `McpServers.Word.All` → correct.

---

## Reference

- **Agent 365 Tools appId (token `aud`):** `ea9ffc3e-8a23-4a7d-836d-234d7c7565c1`
- **Server URL format:**
  `https://agent365.svc.cloud.microsoft/agents/tenants/{tenantId}/servers/{serverName}`
- **Scope format:** `https://agent365.svc.cloud.microsoft/{ServerScope}`
  (e.g. `McpServers.Word.All`)
- Work IQ MCP overview:
  <https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview>
- Set up service principal & tooling:
  <https://learn.microsoft.com/en-us/microsoft-agent-365/developer/tooling>
- Enterprise app for coding agents (Claude Code / VS Code / Copilot CLI):
  <https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview#set-up-work-iq-mcp-servers-for-coding-agents>
- Manage tools in the M365 admin center:
  <https://learn.microsoft.com/en-us/microsoft-365/admin/manage/manage-tools-for-agent>
- Troubleshooting guide:
  <https://learn.microsoft.com/en-us/microsoft-agent-365/developer/troubleshooting>
