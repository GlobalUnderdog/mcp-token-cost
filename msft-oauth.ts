/**
 * Microsoft Entra ID (Azure AD) OAuth for the agent365 / Microsoft 365 MCP
 * servers.
 *
 * These servers sit behind Entra ID and require a Bearer access token on every
 * request — including the `initialize` handshake and `tools/list`. This module
 * acquires that token with the official MSAL library (`@azure/msal-node`).
 *
 * Default flow: **client credentials (app-only)**.
 *   No interactive sign-in — the app authenticates as itself using a client
 *   secret. Ideal for a headless estimate script. Works for `tools/list`
 *   provided the server accepts app-only tokens; if it instead demands a
 *   delegated (user-context) token you'll get a 401 and should switch to the
 *   device-code flow below (see `getMicrosoftMcpTokenDeviceCode`).
 *
 * Entra setup (admin console):
 *   1. App registration -> note the Application (client) ID.
 *   2. Certificates & secrets -> new client secret.
 *   3. API permissions -> add the *application* permission for the target
 *      resource (the agent365 / Microsoft 365 API) -> **Grant admin consent**.
 *
 * Required env (see .env.example):
 *   MSFT_TENANT_ID     - directory (tenant) ID
 *   MSFT_CLIENT_ID     - application (client) ID
 *   MSFT_CLIENT_SECRET - client secret value
 *   MSFT_MCP_SCOPE     - optional; resource "/.default" scope (has a default)
 */

import {
  ConfidentialClientApplication,
  PublicClientApplication,
  LogLevel,
  type Configuration,
} from "@azure/msal-node"

/**
 * The `<resource>/.default` scope for the agent365 MCP resource. Override via
 * MSFT_MCP_SCOPE if your tenant exposes the resource under a different app ID
 * URI (e.g. a GUID like "api://<guid>/.default").
 */
const DEFAULT_SCOPE = "https://agent365.svc.cloud.microsoft/.default"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`)
  return value
}

function authority(): string {
  return `https://login.microsoftonline.com/${requireEnv("MSFT_TENANT_ID")}`
}

function scopes(): string[] {
  return [process.env.MSFT_MCP_SCOPE || DEFAULT_SCOPE]
}

const loggerOptions = {
  loggerCallback: (_level: LogLevel, message: string) => {
    if (process.env.MSAL_DEBUG) console.error(message)
  },
  piiLoggingEnabled: false,
  logLevel: LogLevel.Warning,
}

// ---------------------------------------------------------------------------
// Client credentials (app-only) — default
// ---------------------------------------------------------------------------

let cca: ConfidentialClientApplication | undefined

function confidentialClient(): ConfidentialClientApplication {
  if (!cca) {
    const config: Configuration = {
      auth: {
        clientId: requireEnv("MSFT_CLIENT_ID"),
        authority: authority(),
        clientSecret: requireEnv("MSFT_CLIENT_SECRET"),
      },
      system: { loggerOptions },
    }
    cca = new ConfidentialClientApplication(config)
  }
  return cca
}

/**
 * Acquire an app-only access token. MSAL caches the token in-memory and returns
 * the cached value until it nears expiry, so this is cheap to call repeatedly.
 */
export async function getMicrosoftMcpToken(): Promise<string> {
  const result = await confidentialClient().acquireTokenByClientCredential({
    scopes: scopes(),
  })
  if (!result?.accessToken) {
    throw new Error("MSAL returned no access token for client-credentials request")
  }
  return result.accessToken
}

// ---------------------------------------------------------------------------
// Device code (delegated / user-context) — fallback
// ---------------------------------------------------------------------------

let pca: PublicClientApplication | undefined

function publicClient(): PublicClientApplication {
  if (!pca) {
    pca = new PublicClientApplication({
      auth: {
        clientId: requireEnv("MSFT_CLIENT_ID"),
        authority: authority(),
      },
      system: { loggerOptions },
    })
  }
  return pca
}

/**
 * Fallback for servers that reject app-only tokens: prints a URL + code to the
 * terminal for the user to approve in any browser, then returns a delegated
 * token. Use *delegated* scopes here (e.g. the resource's user-scoped
 * permission), not "/.default". Requires "Allow public client flows" enabled on
 * the app registration.
 *
 * Pass `scopeOverride` to request a specific delegated scope (e.g.
 * `https://agent365.svc.cloud.microsoft/McpServers.Word.All`). This also
 * triggers interactive consent for exactly that scope on first sign-in.
 */
export async function getMicrosoftMcpTokenDeviceCode(
  scopeOverride?: string[],
): Promise<string> {
  const result = await publicClient().acquireTokenByDeviceCode({
    scopes: scopeOverride ?? scopes(),
    deviceCodeCallback: (response) => console.error(response.message),
  })
  if (!result?.accessToken) {
    throw new Error("MSAL returned no access token for device-code request")
  }
  return result.accessToken
}
