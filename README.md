# MCP Token Cost

Estimate how many tokens each MCP server's tool definitions would consume if loaded into a model's context. This helps with context-window budgeting when choosing which MCP servers to include in a session.

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

| Server | Transport | Tools | Est. Tokens | Avg Tokens/Tool | Bytes |
|---|---|---|---|---|---|
| Google Drive | HTTP | 8 | 5,669 | 709 | 22,674 |
| Google Calendar | HTTP | 8 | 17,847 | 2,231 | 71,388 |
| Google People API | HTTP | 3 | 1,119 | 373 | 4,475 |
| Google Chat | HTTP | 4 | 4,951 | 1,238 | 19,801 |
| AWS | stdio | 9 | 5,200 | 578 | 20,798 |
| Salesforce | stdio | 12 | 5,863 | 489 | 23,451 |
| Google Cloud | stdio | 1 | 539 | 539 | 2,153 |
| Azure | stdio | 66 | 20,500 | 311 | 81,999 |
| MongoDB | stdio | 16 | 4,530 | 283 | 18,119 |
| Grep | HTTP | 1 | 741 | 741 | 2,964 |
| Context7 | HTTP | 2 | 1,229 | 615 | 4,916 |
| Serena | stdio | 29 | 9,339 | 322 | 37,355 |

### Key observations

- **Azure** is the heaviest by far: 66 tools, ~20.5K tokens, 82KB serialized — roughly 15% of a 128K context window consumed by tool definitions alone.
- **Serena** is the second-heaviest by bytes: 29 tools, ~9.3K tokens, 37KB — roughly 7% of a 128K window. It uses the context-aware `ide-assistant` context (fewer tools than `desktop-app`) since the script doesn't pass `--context`.
- **Google Cloud** and **Grep** are the lightest: a single tool each, ~0.5K and ~0.7K tokens respectively.
- **Google Calendar** has dense input schemas: only 8 tools but averaging 2,231 tokens each (second-highest total).
- **Context7** is lightweight at 2 tools and ~1.2K tokens, despite fetching potentially large documentation payloads at runtime.
- **Grep** (from [Vercel's blog post](https://vercel.com/blog/grep-a-million-github-repositories-via-mcp)) exposes a single code-search tool, adding only ~741 tokens of schema overhead for access to 1M+ GitHub repositories.
- Most stdio servers stay under 6K tokens total, with Azure and Serena being the exceptions.

## Usage

```bash
# Node 24+ (strip-types built-in)
node --experimental-strip-types mcp-token-estimate.ts

# or via tsx
pnpm tsx mcp-token-estimate.ts
```

Edit the `SERVERS` array at the top of `mcp-token-estimate.ts` to add or remove servers to prospect.
