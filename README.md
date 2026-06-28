<div align="center">
  <img width="1280" height="720" alt="hf-publish banner" src="https://github.com/user-attachments/assets/17d41de5-1343-4abf-96f9-68bfc95875af" />
  <h1>HF Publish</h1>
  <p>A local stdio MCP server for managing your own models on Hugging Face Hub.</p>

  [![npm version](https://img.shields.io/npm/v/hf-publish-mcp?color=cb3837&logo=npm)](https://www.npmjs.com/package/hf-publish-mcp)
  [![npm downloads](https://img.shields.io/npm/dm/hf-publish-mcp?color=cb3837&logo=npm)](https://www.npmjs.com/package/hf-publish-mcp)
  [![license](https://img.shields.io/npm/l/hf-publish-mcp)](LICENSE)
  [![bun](https://img.shields.io/badge/runtime-bun-f9f1e1?logo=bun&logoColor=black)](https://bun.sh)
  [![MCP](https://img.shields.io/badge/transport-stdio-6366f1)](https://modelcontextprotocol.io)
  [![GitHub stars](https://img.shields.io/github/stars/CodeStrate/hf-publish-mcp?style=flat&color=yellow)](https://github.com/CodeStrate/hf-publish-mcp/stargazers)
</div>

---

Intended for fine-tuners and researchers who publish models to HF Hub. This is not a general-purpose Hub CLI wrapper - it is scoped to **your own repos**: uploading checkpoints and adapters, inspecting file completeness, and maintaining model cards. For browsing and discovering other people's models, use the [official HF MCP](https://huggingface.co/docs/hub/en/agents-mcp) instead.

[Tools](#tools) · [Getting Started](#getting-started) · [Auth](#auth) · [Client Config](#client-config) · [How It Works](#how-it-works) · [Stack](#stack) · [Development](#development) · [Contributing](#contributing)

## vs Official HF MCP

The [official HF MCP](https://huggingface.co/docs/hub/en/agents-mcp) and this server are complementary, not overlapping.

| | [Official HF MCP](https://huggingface.co/docs/hub/en/agents-mcp) | hf-publish-mcp |
|---|---|---|
| Transport | Remote HTTP/SSE | Local stdio |
| Auth | HF account (OAuth via settings) | Write-scoped token |
| Search models, datasets, spaces, papers | Yes | No |
| Search HF documentation | Yes | No |
| Run Gradio Space tools | Yes | No |
| Run jobs on HF infrastructure | Yes | No |
| Repo details + README (read) | Yes | Yes (`inspect_repo`) |
| Upload local model/adapter files | No | Yes |
| Edit model cards | No | Yes |
| Track background upload jobs | No | Yes |

The overlap is `inspect_repo` vs the official "Hub Repository Details" tool - both return repo metadata and the README. Everything else is distinct: the official MCP is for exploring the Hub, this one is for pushing to it.

## Tools

| Tool | Description |
|---|---|
| `list_model_repos` | List your HF models with likes, downloads, and last modified date |
| `inspect_repo` | Verify expected files exist (config, tokenizer, weights) and return the model card |
| `upload_model` | Upload a model or adapter directory to HF. Non-blocking - returns a `jobId` immediately |
| `get_model_upload_status` | Poll a background upload by `jobId`. Shows phase, current file, and elapsed time |
| `update_model_card` | Patch a model card README via surgical section edits, frontmatter merges, or full rewrite (dry run support: review changes before agent commits) |
| `manage_upload_jobs` | List, delete, or batch-clean upload job history across active and dated archive files |

## Getting Started

**Requires [Bun](https://bun.sh)**

No install needed - run directly with `bunx`:

```bash
bunx hf-publish-mcp
```

Or clone for local development..

## Development


```bash
git clone https://github.com/CodeStrate/hf-publish-mcp

cd hf-publish-mcp
bun install
bun run dev        # watch mode - restarts on file changes
```

To build from source:

```bash
bun run build      # compiles to dist/index.js
```

Then point your MCP client at the local build:

```json
{
  "command": "bun",
  "args": ["/absolute/path/to/hf-publish-mcp/dist/index.js"],
  "env": { "HF_TOKEN": "hf_..." }
}
```

Logs go to stderr (structured JSON via pino). To read them while developing:

```bash
HF_TOKEN=hf_... bun run dev 2>&1 | bunx pino-pretty
```

## Auth

On startup the server resolves your HF token in order:

1. `HF_TOKEN` environment variable
2. HF CLI token at `~/.cache/huggingface/token`
If neither is present the server exits immediately with an error message rather than hanging.

The token requires **write** scope.

## Client Config

### Claude Desktop

```json
{
  "mcpServers": {
    "hf-publish": {
      "command": "bunx",
      "args": ["hf-publish-mcp"],
      "env": {
        "HF_TOKEN": "hf_..."
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add hf-publish -- bunx hf-publish-mcp
```

### VS Code (`.vscode/mcp.json`) - token via secrets UI

```json
{
  "inputs": [
    {
      "id": "hf-token",
      "type": "promptString",
      "description": "HuggingFace write-scoped token",
      "password": true
    }
  ],
  "servers": {
    "hf-publish": {
      "type": "stdio",
      "command": "bunx",
      "args": ["hf-publish-mcp"],
      "env": {
        "HF_TOKEN": "${input:hf-token}"
      }
    }
  }
}
```

### Generic stdio client (Cursor, PiCode, OpenCode, etc.)

```json
{
  "command": "bunx",
  "args": ["hf-publish-mcp"],
  "env": {
    "HF_TOKEN": "hf_..."
  }
}
```

## How It Works

### Upload

`upload_model` is non-blocking. It creates the repo if absent, starts the upload in the background, and returns a `jobId` immediately. Poll with `get_model_upload_status`.

Jobs persist to `~/.hf_mcp/upload-jobs.json` - status survives server restarts. Jobs interrupted mid-upload are marked `Error` on next start rather than left in a stale `Running` state. Completed jobs are archived to dated files once the active file exceeds the limit.

Progress is phase-level (`preuploading → uploadingLargeFiles → committing`) and file-level, powered by `uploadFilesWithProgress` from `@huggingface/hub`.

### Model Card Editing

`update_model_card` operates in two modes:

**Surgical** - pass `frontmatter` and/or `sections`. Only the specified parts change; everything else is returned byte-for-byte. The remark AST is used purely as a position map to locate section boundaries, then the raw string is spliced directly. No formatting drift.

**Full rewrite** - pass `content` with the complete README body. `frontmatter` and `removeFields` are still applied on top if provided.

**Dry Run Support** - A `dryRun` flag for when you would like to review changes before you'd want the agent to commit the changes. Allowing for manual adjustments in case something isn't right.

## Stack

- TypeScript + Bun
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) - MCP SDK + stdio transport
- [`@huggingface/hub`](https://github.com/huggingface/huggingface.js/tree/main/packages/hub) - repo ops, uploads, file download
- `gray-matter` - YAML frontmatter round-tripping
- `remark` + `remark-gfm` - markdown AST for section position mapping
- `pino` - structured logging to stderr (stdout reserved for MCP JSON-RPC)
- `diff` - reviewing model card changes in a diff before committing (through a dry run option)

## Contributing

PRs welcome. A few guidelines:

- **One concern per PR** - keep diffs reviewable
- Open an issue first for anything beyond a bug fix or small improvement
- `update_model_card` is the most sensitive tool - changes there should be tested against a real card; `dryRun: true` exists for this
- `trigger_gguf_quant` is experimental and currently deferred - the Gradio Space requires browser OAuth that can't be satisfied headlessly; skip unless you have a concrete solution

Bug reports: open an issue with the tool name, inputs (redact your token), and the error message or unexpected output.
