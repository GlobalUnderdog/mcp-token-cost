# MCP Token Cost
 
Estimate how many tokens each MCP server's tool definitions would consume if loaded into a model's context. This helps with context-window budgeting when choosing which MCP servers to include in a session.
 
Currently probes **Google Workspace** (Gmail, Drive, Calendar, Chat, People API), **BigQuery**, **Redshift**, plus a mix of popular stdio and HTTP servers.
## How It Works

Each MCP server exposes a `tools/list` RPC method that returns its tool definitions — names, descriptions, and input schemas. When a model loads a server, these definitions are serialized into the prompt as JSON and counted against the context window.

This script:

1. **Connects** to each server via its configured transport
2. **Performs the standard MCP handshake** — `initialize` → `notifications/initialized` → `tools/list`
3. **Collects all tools** (following `nextCursor` pagination if present)
4. **Serializes the tool list to JSON** and estimates token count using the standard heuristic (~4 characters per token)
5. **Prints a results table** with server name, transport, tool count, estimated tokens, and serialized byte size

## Supported Transports

### Remote "Streamable HTTP" (`fetch`)

Servers configured as a URL string:

1. POST `initialize` (captures `Mcp-Session-Id` + protocol version)
2. POST `notifications/initialized`
3. POST `tools/list` (with session cookie)

The handler accepts both plain JSON responses and SSE streams (`text/event-stream` content type). For SSE it collects `data:` frames and returns the last JSON-RPC message containing a `result` or `error`.

No auth is attempted — most public servers do not require it for `tools/list`.

### Local "stdio" (`child_process.spawn`)

Servers configured as `{ command, args, env }`:

1. Spawns the command as a child process with piped stdin/stdout
2. Exchanges newline-delimited JSON-RPC messages over stdio
3. Same `initialize` → `notifications/initialized` → `tools/list` flow
4. Kills the child process with `SIGTERM` after collecting results

Stderr output is captured and reported on unexpected exit. A 30-second per-request timeout prevents hung servers.

## Token Estimation

Uses the standard heuristic of **1 token ≈ 4 characters** (English prose + JSON). This is a rough estimate sufficient for prospecting and relative comparison. Actual token counts vary by model tokenizer.

    estimateTokens(text) = Math.ceil(text.length / 4)


## Results

Run: `node --experimental-strip-types mcp-token-estimate.ts`

 | Server | Category | Transport | Tools | Est. Tokens | Avg Tokens/Tool | Bytes |
 |---|---|---|---|---|---|---|
 | Gmail | Google Workspace | HTTP | 13 | 10,733 | 826 | 42,929 |
 | Google Drive | Google Workspace | HTTP | 8 | 5,669 | 709 | 22,674 |
 | Google Calendar | Google Workspace | HTTP | 8 | 17,851 | 2,231 | 71,402 |
 | Google People API | Google Workspace | HTTP | 3 | 1,119 | 373 | 4,475 |
 | Google Chat | Google Workspace | HTTP | 4 | 4,951 | 1,238 | 19,801 |
 | BigQuery | Database | HTTP | 6 | 32,914 | 5,486 | 131,655 |
 | AWS | Cloud | stdio | 9 | 5,200 | 578 | 20,798 |
 | Redshift | Database | stdio | 6 | 6,694 | 1,116 | 26,775 |
 | Salesforce | CRM | stdio | 12 | 5,863 | 489 | 23,451 |
 | Google Cloud | Cloud | stdio | 1 | 539 | 539 | 2,153 |
 | Azure | Cloud | stdio | 66 | 20,500 | 311 | 81,999 |
 | MongoDB | Database | stdio | 16 | 4,530 | 283 | 18,119 |
 | Grep | Developer Tools | HTTP | 1 | 741 | 741 | 2,964 |
 | Context7 | Developer Tools | HTTP | 2 | 1,229 | 615 | 4,916 |
 | Serena | Developer Tools | stdio | 29 | 9,339 | 322 | 37,355 |

### Key observations

- **BigQuery** is the heaviest by far: only 6 tools but 32.9K tokens and 132KB serialized — ~26% of a 128K window. Its `execute_sql` / `execute_sql_readonly` tools carry enormous input schemas, averaging 5,486 tokens per tool.
- **Azure** is second by both tokens (20.5K) and bytes (82KB): 66 tools averaging 311 tokens each. Roughly 15% of a 128K context window.
- **Serena** is third by bytes: 29 tools, ~9.3K tokens, 37KB — roughly 7% of a 128K window. Uses the context-aware `ide-assistant` context (fewer tools than `desktop-app`) since the script doesn't pass `--context`.
- **Google Cloud** and **Grep** are the lightest: a single tool each, ~0.5K and ~0.7K tokens respectively.
- **Google Calendar** has dense input schemas: only 8 tools but averaging 2,231 tokens each.
- **Redshift** is right-sized: 6 tools at 6.7K tokens total, 1,116 avg — comparable to Salesforce (12 tools, 5.9K).
- **Context7** is lightweight at 2 tools and ~1.2K tokens, despite fetching potentially large documentation payloads at runtime.
- **Gmail** exposes 13 tools (more than the 10 on the page — live `tools/list` reveals `list_drafts`, `label_thread`, `unlabel_thread`), ~10.7K tokens and 43KB.
- **Grep** (from [Vercel's blog post](https://vercel.com/blog/grep-a-million-github-repositories-via-mcp)) adds only ~741 tokens for access to 1M+ GitHub repositories.
- Most stdio servers stay under 6K tokens total, with Azure and Serena being the exceptions.

## Usage

```bash
# Node 24+ (strip-types built-in)
node --experimental-strip-types mcp-token-estimate.ts

# or via tsx
pnpm tsx mcp-token-estimate.ts
```

Edit the `SERVERS` array at the top of `mcp-token-estimate.ts` to add or remove servers to prospect.
