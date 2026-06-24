<div align="center">
  <img width="1280" height="720" alt="hf-publish banner" src="https://github.com/user-attachments/assets/17d41de5-1343-4abf-96f9-68bfc95875af" />
  <h1>HF Publish</h1>
  <p>A local stdio MCP server for the fine-tuner's publish workflow on Hugging Face Hub.</p>

  [![npm version](https://img.shields.io/npm/v/hf-publish-mcp?color=cb3837&logo=npm)](https://www.npmjs.com/package/hf-publish-mcp)
  [![npm downloads](https://img.shields.io/npm/dm/hf-publish-mcp?color=cb3837&logo=npm)](https://www.npmjs.com/package/hf-publish-mcp)
  [![license](https://img.shields.io/npm/l/hf-publish-mcp)](LICENSE)
  [![bun](https://img.shields.io/badge/runtime-bun-f9f1e1?logo=bun&logoColor=black)](https://bun.sh)
  [![MCP](https://img.shields.io/badge/transport-stdio-6366f1)](https://modelcontextprotocol.io)
</div>

---

The [official HF MCP](https://huggingface.co/docs/hub/en/agents-mcp) covers search and discovery. This fills the other side — inspect repos, upload checkpoints and adapters, and maintain model cards without leaving your agent.

[Tools](#tools) · [Getting Started](#getting-started) · [Auth](#auth) · [Client Config](#client-config) · [How It Works](#how-it-works) · [Stack](#stack)

## Tools

| Tool | Description |
|---|---|
| `list_model_repos` | List your HF models with likes, downloads, and last modified date |
| `inspect_repo` | Verify expected files exist (config, tokenizer, weights) and return the model card |
| `upload_model` | Upload a model or adapter directory to HF. Non-blocking — returns a `jobId` immediately |
| `get_model_upload_status` | Poll a background upload by `jobId`. Shows phase, current file, and elapsed time |
| `update_model_card` | Patch a model card README via surgical section edits, frontmatter merges, or full rewrite (dry run support: review changes before agent commits) |
| `manage_upload_jobs` | List, delete, or batch-clean upload job history across active and dated archive files |

## Getting Started

**Requires [Bun](https://bun.sh)**

No install needed — run directly with `bunx`:

```bash
bunx hf-publish-mcp
```

Or clone for local development:

```bash
git clone https://github.com/CodeStrate/hf-publish-mcp
cd hf-publish-mcp
bun install
```

## Auth

On startup the server resolves your HF token in order:

1. `HF_TOKEN` environment variable
2. HF CLI token at `~/.cache/huggingface/token`
3. Interactive `hf auth login` — **only works when running in a terminal**, not via an MCP client

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

### VS Code (`.vscode/mcp.json`) — token via secrets UI

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

Jobs persist to `~/.hf_mcp/upload-jobs.json` — status survives server restarts. Jobs interrupted mid-upload are marked `Error` on next start rather than left in a stale `Running` state. Completed jobs are archived to dated files once the active file exceeds the limit.

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
