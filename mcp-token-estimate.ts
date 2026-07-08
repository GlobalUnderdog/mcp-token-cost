/**
 * Estimate how many tokens each MCP server's tool definitions would consume if
 * loaded into a model's context.
 *
 * Supports two transports:
 *   - Remote "Streamable HTTP": a URL string entry.
 *       1. POST `initialize`            -> capture Mcp-Session-Id + protocol version
 *       2. POST `notifications/initialized`
 *       3. POST `tools/list`
 *     Most public servers do NOT require auth for `tools/list`, but they DO
 *     require a proper handshake and `Accept: application/json,
 *     text/event-stream` (many reply with an SSE stream, not plain JSON).
 *
 *   - Local "stdio": a { command, args, env } entry. The server is spawned as a
 *     child process and JSON-RPC messages are exchanged as newline-delimited
 *     JSON over stdin/stdout (same initialize -> initialized -> tools/list flow).
 *
 * Run: pnpm tsx scripts/mcp-token-estimate.ts
 */

import { spawn } from "node:child_process"

import {  getMicrosoftMcpTokenDeviceCode,} from "./msft-oauth.ts"

type StdioSpec = {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

type RemoteSpec = {
  name: string
  remote: string
  headers?: Record<string, string>
  /**
   * Optional async auth resolver, invoked once before the handshake. Returns
   * extra headers (e.g. `Authorization`) merged into every request for this
   * server. Kept lazy so servers that don't need auth never trigger a sign-in.
   */
  auth?: () => Promise<Record<string, string>>
}

type ServerSpec = StdioSpec | RemoteSpec

function microsoftMcpServer(
  name: string,
  serverId: string,
): RemoteSpec {
  return {
    name,
    remote: `https://agent365.svc.cloud.microsoft/agents/tenants/${process.env.MSFT_TENANT_ID}/servers/${serverId}`,
    auth: async () => ({
      Authorization: `Bearer ${await getMicrosoftMcpTokenDeviceCode()}`,
    }),
  }
}

// Hardcoded list of MCP servers to prospect. Edit freely.
const SERVERS: ServerSpec[] = [
  // Remote (Streamable HTTP)
  // Google
  { name: "Gmail", remote: "https://gmailmcp.googleapis.com/mcp/v1" },
  { name: "Google Drive", remote: "https://drivemcp.googleapis.com/mcp/v1" },
  { name: "Google Calendar", remote: "https://calendarmcp.googleapis.com/mcp/v1" },
  { name: "Google People API", remote: "https://people.googleapis.com/mcp/v1" },
  { name: "Google Chat", remote: "https://chatmcp.googleapis.com/mcp/v1" },

  // Box (Requires Auth)
  // "https://mcp.box.com",

  // Dropbox (No official MCP)

  // Slack (Requires Auth)
  // "https://mcp.slack.com/mcp",

  // Canva (Requires Auth)
  // "https://mcp.canva.com/mcp",

  // Todoist (Requires Auth)
  // "https://ai.todoist.net/mcp",

  // HubSpot (Requires Auth)
  // "https://mcp.hubspot.com",

  // GitHub (Requires Auth)
  // "https://api.githubcopilot.com/mcp",

  // Snowflake (No official MCP)

  // Postgres (No official MCP)

  // Local (stdio)
  // AWS
  {
    name: "AWS",
    command: "uvx",
    args: [
      "mcp-proxy-for-aws==1.6.0",
      "https://aws-mcp.us-east-1.api.aws/mcp",
      "--metadata",
      "AWS_REGION=us-west-2",
    ],
  },

  // Salesforce
  {
    name: "Salesforce",
    command: "npx",
    args: [
      "-y",
      "@salesforce/mcp",
      "--orgs",
      "DEFAULT_TARGET_ORG",
      "--toolsets",
      "orgs,metadata,data,users",
      "--tools",
      "run_apex_test",
      "--allow-non-ga-tools",
    ],
  },

  // Google Cloud
  {
    name: "Google Cloud",
    command: "npx",
    args: ["-y", "@google-cloud/gcloud-mcp"],
  },

  // Azure
  {
    name: "Azure",
    command: "npx",
    args: ["-y", "@azure/mcp@latest", "server", "start"],
  },

  // Redshift (local uvx)
  {
    name: "Redshift",
    command: "uvx",
    args: ["awslabs.redshift-mcp-server@latest"],
  },

  // Microsoft agent365 MCPs require {tenantId} in the URL and a delegated
  // McpServers.<Service>.All scope in the access token.
  microsoftMcpServer("Microsoft Word", "mcp_WordServer", ),
  microsoftMcpServer("Microsoft OneDrive","mcp_OneDriveRemoteServer"),
  microsoftMcpServer("Microsoft SharePoint","mcp_SharePointRemoteServer"),
  microsoftMcpServer("Microsoft Teams", "mcp_TeamsServer"),
  microsoftMcpServer("Microsoft 365 User", "mcp_MeServer"),
  microsoftMcpServer("Microsoft 365 Calendar", "mcp_CalendarTools"),

  // MongoDB
  {
    name: "MongoDB",
    command: "npx",
    args: ["-y", "mongodb-mcp-server@latest", "--readOnly"],
    env: {
      MDB_MCP_CONNECTION_STRING: "mongodb://localhost:27017/myDatabase",
    },
  },

  // Grep (grep.app) — public GitHub code search over 1M+ repos
  { name: "Grep", remote: "https://mcp.grep.app" },

  // Context7 — library documentation via MCP
  { name: "Context7", remote: "https://mcp.context7.com/mcp" },

  // Serena — IDE-grade code intelligence MCP server (requires uv)
  {
    name: "Serena",
    command: "uvx",
    args: [
      "--from",
      "git+https://github.com/oraios/serena",
      "serena",
      "start-mcp-server",
    ],
  },

  // BigQuery — remote HTTP, tools/list is public
  { name: "BigQuery", remote: "https://bigquery.googleapis.com/mcp" },
]

const PROTOCOL_VERSION = "2025-06-18"
const REQUEST_TIMEOUT_MS = 30_000

type Tool = {
  name: string
  description?: string
  inputSchema?: unknown
}

function isStdio(spec: ServerSpec): spec is StdioSpec {
  return "command" in spec
}

/**
 * Cheap, dependency-free token estimate. Tool definitions are serialized as
 * JSON into the model prompt, and ~4 chars/token is the standard heuristic for
 * English + JSON. Good enough for prospecting/relative comparison.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const initializeParams = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "mcp-token-estimator", version: "1.0.0" },
}

/** Collect all tools from `tools/list`, following `nextCursor` pagination. */
async function collectTools(
  listTools: (cursor: string | undefined) => Promise<any>,
): Promise<Tool[]> {
  const tools: Tool[] = []
  let cursor: string | undefined
  do {
    const result = await listTools(cursor)
    if (result?.error) throw new Error(`tools/list error: ${result.error.message}`)
    tools.push(...(result?.result?.tools ?? []))
    cursor = result?.result?.nextCursor
  } while (cursor)
  return tools
}

// ---------------------------------------------------------------------------
// Remote: Streamable HTTP
// ---------------------------------------------------------------------------

/** Parse a response body that may be plain JSON or an SSE stream. */
async function parseRpcResponse(res: Response): Promise<any> {
  const contentType = res.headers.get("content-type") ?? ""
  const body = await res.text()

  if (!contentType.includes("text/event-stream")) {
    return body.trim() ? JSON.parse(body) : null
  }

  // SSE: gather `data:` payloads, return the last JSON-RPC message that has a
  // result/error (the response to our request, not intermediate notifications).
  let last: any = null
  for (const block of body.split(/\n\n/)) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("")
    if (!data) continue
    try {
      const msg = JSON.parse(data)
      if (msg.result !== undefined || msg.error !== undefined) last = msg
    } catch {
      // ignore keep-alives / non-JSON frames
    }
  }
  return last
}

async function httpRpc(
  spec: RemoteSpec,
  method: string,
  params: unknown,
  id: number | null,
  sessionId?: string,
): Promise<{ res: Response; body: any }> {
  const headers: Record<string, string> = {
    ...spec.headers,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
  }
  if (sessionId) headers["mcp-session-id"] = sessionId

  const payload: Record<string, unknown> = { jsonrpc: "2.0", method }
  if (id !== null) payload.id = id
  if (params !== undefined) payload.params = params

  const res = await fetch(spec.remote, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })
  const body = id === null ? null : await parseRpcResponse(res)
  return { res, body }
}

async function fetchToolsHttp(spec: RemoteSpec): Promise<Tool[]> {
  // Resolve auth once (e.g. acquire an OAuth token) and fold it into headers so
  // every request in the handshake carries it.
  if (spec.auth) {
    const authHeaders = await spec.auth()
    spec = { ...spec, headers: { ...spec.headers, ...authHeaders } }
  }

  const init = await httpRpc(spec, "initialize", initializeParams, 1)
  if (!init.res.ok) {
    throw new Error(`initialize failed: HTTP ${init.res.status} ${init.res.statusText}`)
  }
  if (init.body?.error) {
    throw new Error(
      `initialize error: ${init.body.error.message ?? JSON.stringify(init.body.error)}`,
    )
  }

  const sessionId = init.res.headers.get("mcp-session-id") ?? undefined

  await httpRpc(spec, "notifications/initialized", {}, null, sessionId).catch(() => {})

  let id = 2
  return collectTools(async (cursor) => {
    const { res, body } = await httpRpc(
      spec,
      "tools/list",
      cursor ? { cursor } : {},
      id++,
      sessionId,
    )
    if (!res.ok) throw new Error(`tools/list failed: HTTP ${res.status}`)
    return body
  })
}

// ---------------------------------------------------------------------------
// Local: stdio
// ---------------------------------------------------------------------------

async function fetchToolsStdio(spec: StdioSpec): Promise<Tool[]> {
  const child = spawn(spec.command, spec.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...spec.env },
  })

  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  let stderr = ""
  let buffer = ""
  let fatal: Error | null = null

  const rejectAll = (err: Error) => {
    fatal = err
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }

  child.on("error", (err) => rejectAll(err)) // e.g. ENOENT: command not installed
  child.on("exit", (code) => {
    if (pending.size) {
      rejectAll(new Error(`server exited (code ${code})${stderr ? `: ${stderr.trim()}` : ""}`))
    }
  })
  child.stderr.on("data", (c) => {
    stderr += c.toString()
  })
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString()
    let nl: number
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue // ignore non-JSON log lines on stdout
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)!.resolve(msg)
        pending.delete(msg.id)
      }
    }
  })

  const notify = (method: string) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`)

  const request = (id: number, method: string, params: unknown): Promise<any> => {
    if (fatal) return Promise.reject(fatal)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms`)),
        REQUEST_TIMEOUT_MS,
      )
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  }

  try {
    const init = await request(1, "initialize", initializeParams)
    if (init?.error) {
      throw new Error(`initialize error: ${init.error.message ?? JSON.stringify(init.error)}`)
    }
    notify("notifications/initialized")

    let id = 2
    return await collectTools((cursor) => request(id++, "tools/list", cursor ? { cursor } : {}))
  } finally {
    child.kill("SIGTERM")
  }
}

// ---------------------------------------------------------------------------

function fetchTools(spec: ServerSpec): Promise<Tool[]> {
  return isStdio(spec) ? fetchToolsStdio(spec) : fetchToolsHttp(spec)
}

async function main() {
  const rows: Array<Record<string, unknown>> = []

  for (const spec of SERVERS) {
    const server = spec.name
    try {
      const tools = await fetchTools(spec)
      const serialized = JSON.stringify(tools)
      const totalTokens = estimateTokens(serialized)
      rows.push({
        server,
        transport: isStdio(spec) ? "stdio" : "http",
        tools: tools.length,
        estTokens: totalTokens,
        avgTokensPerTool: tools.length ? Math.round(totalTokens / tools.length) : 0,
        bytes: serialized.length,
      })
    } catch (err) {
      console.error(err)
      rows.push({
        server,
        transport: isStdio(spec) ? "stdio" : "http",
        tools: "—",
        estTokens: "—",
        avgTokensPerTool: "—",
        bytes: `ERROR: ${(err as Error).message}`,
      })
    }
  }

  console.table(rows)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
