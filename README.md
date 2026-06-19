# hf-publish

A local stdio MCP server for the fine-tuner's **publish workflow** on Hugging Face Hub. The official HF MCP covers search and discovery — this fills the other side: inspect repos, upload checkpoints and adapters, and maintain model cards.

## Tools

| Tool | Description |
|---|---|
| `list_model_repos` | List your HF models with likes, downloads, and last modified date |
| `inspect_repo` | Check whether expected model files exist (config, tokenizer, weights) and return the model card. Use before uploading or editing. |
| `upload_model` | Upload a model or adapter directory to HF. Returns a `jobId` immediately — non-blocking. |
| `get_model_upload_status` | Poll a background upload by `jobId`. Shows current phase, current file, and elapsed time. |
| `update_model_card` | Patch a model card README. Supports surgical section edits, frontmatter merges, and full rewrites — without clobbering untouched content. |

## Auth

On startup the server checks for `HF_TOKEN` in your environment, then falls back to the HF CLI token at `~/.cache/huggingface/token`. If neither is found it launches `hf auth login` interactively — **this only works when running the server directly in a terminal**, not when launched by an MCP client over stdio (no TTY).

Recommended flow: run `bun run src/index.ts` once in a terminal to authenticate, then use it via your MCP client. Alternatively set `HF_TOKEN` directly in your client config.

The token needs **write** scope.

## Setup

**Requires [Bun](https://bun.sh)**

```bash
git clone https://github.com/codestrate/hf-publish-mcp
cd hf-publish-mcp
bun install
```

## MCP Client Config

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "hf-publish": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/hf-publish-mcp/src/index.ts"]
    }
  }
}
```

### VS Code (`.vscode/mcp.json`) — token via UI prompt

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
      "command": "bun",
      "args": ["run", "/absolute/path/to/hf-publish-mcp/src/index.ts"],
      "env": {
        "HF_TOKEN": "${input:hf-token}"
      }
    }
  }
}
```

### Generic stdio client

```json
{
  "command": "bun",
  "args": ["run", "/absolute/path/to/hf-publish-mcp/src/index.ts"],
  "env": {
    "HF_TOKEN": "hf_..."
  }
}
```

## Upload flow

`upload_model` is non-blocking — it creates the repo if absent, starts the upload in the background, and returns a `jobId` immediately. Poll with `get_model_upload_status`.

Upload jobs are persisted to `~/.hf_mcp/upload-jobs.json` so status survives server restarts. Interrupted jobs (server killed mid-upload) are marked as `Error` on next start.

Progress events are phase-level (`preuploading → uploadingLargeFiles → committing`) and file-level, powered by `uploadFilesWithProgress` from `@huggingface/hub`.

## Model card editing

`update_model_card` has two modes:

**Surgical (default):** Pass `frontmatter` and/or `sections`. Only the specified parts change — everything else is untouched byte-for-byte. Uses remark AST as a position map for section bounds, then splices the raw string directly. No formatting drift.

**Full rewrite:** Pass `content` with the complete README body. Still applies `frontmatter`/`removeFields` on top if provided.

## Stack

- TypeScript + Bun
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — stdio transport
- [`@huggingface/hub`](https://github.com/huggingface/huggingface.js/tree/main/packages/hub) — repo ops, uploads, file download
- `gray-matter` — YAML frontmatter round-tripping
- `remark` + `remark-gfm` — markdown AST for section position mapping
- `pino` — structured logging to stderr (stdout is reserved for MCP JSON-RPC)
