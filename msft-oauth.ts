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

import { readFile, writeFile } from "node:fs/promises"

import {
  PublicClientApplication,
  LogLevel,
} from "@azure/msal-node"

/**
 * Request all scopes at once to reduce the number of required sign-ins
 */
const MCP_SCOPES = [
  // Word
  "https://agent365.svc.cloud.microsoft/McpServers.Word.All",
  // One Drive
  "https://agent365.svc.cloud.microsoft/McpServers.OneDrive.All",
  // SharePoint
  "https://agent365.svc.cloud.microsoft/McpServers.SharePoint.All",
  // Teams
  "https://agent365.svc.cloud.microsoft/McpServers.Teams.All",
  // M365 User
  "https://agent365.svc.cloud.microsoft/McpServers.Me.All",
  // Calendar
  "https://agent365.svc.cloud.microsoft/McpServers.Calendar.All",
]
const TOKEN_CACHE_FILE = ".msft-token-cache.json"
const TOKEN_EXPIRY_SKEW_MS = 5 * 60_000

type CachedMicrosoftToken = {
  accessToken: string
  expiresAt: number
}

type MicrosoftTokenCache = Record<string, CachedMicrosoftToken>

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`)
  return value
}

function authority(): string {
  return `https://login.microsoftonline.com/${requireEnv("MSFT_TENANT_ID")}`
}

function tokenCacheKey(scopeList: string[]): string {
  return [
    requireEnv("MSFT_TENANT_ID"),
    requireEnv("MSFT_CLIENT_ID"),
    ...scopeList.slice().sort(),
  ].join("|")
}

async function readTokenCache(): Promise<MicrosoftTokenCache> {
  try {
    const parsed = JSON.parse(await readFile(TOKEN_CACHE_FILE, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as MicrosoftTokenCache
  } catch {
    return {}
  }
}

async function writeTokenCache(cache: MicrosoftTokenCache): Promise<void> {
  await writeFile(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 })
}

const loggerOptions = {
  loggerCallback: (_level: LogLevel, message: string) => {
    if (process.env.MSAL_DEBUG) console.error(message)
  },
  piiLoggingEnabled: false,
  logLevel: LogLevel.Warning,
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
 * Work IQ servers need a *delegated* user token carrying the server's scope
 * (app-only tokens are rejected with 403 "Scope 'McpServers.Word.All' is
 * not present"). Device-code prints a URL+code to approve in a browser.
 *
 * This also triggers interactive consent for exactly that scope on first sign-in.
 */
export async function getMicrosoftMcpTokenDeviceCode(
  scopes: string[] = MCP_SCOPES,
): Promise<string> {
  const requestedScopes = scopes
  const cache = await readTokenCache()
  const cacheKey = tokenCacheKey(requestedScopes)
  const cached = cache[cacheKey]
  if (cached && cached.expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS) {
    return cached.accessToken
  }

  const result = await publicClient().acquireTokenByDeviceCode({
    scopes: requestedScopes,
    deviceCodeCallback: (response) => console.error(response.message),
  })
  if (!result?.accessToken) {
    throw new Error("MSAL returned no access token for device-code request")
  }

  cache[cacheKey] = {
    accessToken: result.accessToken,
    expiresAt: result.expiresOn?.getTime() ?? Date.now() + 50 * 60_000,
  }
  await writeTokenCache(cache)

  return result.accessToken
}
