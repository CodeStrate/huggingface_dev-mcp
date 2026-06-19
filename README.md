<div align="center">
  <img width="1280" height="720" alt="hf-publish banner" src="https://github.com/user-attachments/assets/17d41de5-1343-4abf-96f9-68bfc95875af" />
  <h1>HF Publish</h1>
  <p>A local stdio MCP server for the fine-tuner's publish workflow on Hugging Face Hub.</p>
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
| `update_model_card` | Patch a model card README via surgical section edits, frontmatter merges, or full rewrite |

## Getting Started

**Requires [Bun](https://bun.sh)**

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

**Recommended:** run `bun run src/index.ts` once in a terminal to authenticate via the CLI, then use it from your MCP client. Alternatively, set `HF_TOKEN` directly in your client config.

The token requires **write** scope.

## Client Config

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

### VS Code (`.vscode/mcp.json`)

Prompts for the token via the VS Code secrets UI — nothing stored in plaintext.

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

## How It Works

### Upload

`upload_model` is non-blocking. It creates the repo if absent, starts the upload in the background, and returns a `jobId` immediately. Poll with `get_model_upload_status`.

Jobs persist to `~/.hf_mcp/upload-jobs.json` — status survives server restarts. Jobs interrupted mid-upload are marked `Error` on next start rather than left in a stale `Running` state.

Progress is phase-level (`preuploading → uploadingLargeFiles → committing`) and file-level, powered by `uploadFilesWithProgress` from `@huggingface/hub`.

### Model Card Editing

`update_model_card` operates in two modes:

**Surgical** — pass `frontmatter` and/or `sections`. Only the specified parts change; everything else is returned byte-for-byte. The remark AST is used purely as a position map to locate section boundaries, then the raw string is spliced directly. No formatting drift.

**Full rewrite** — pass `content` with the complete README body. `frontmatter` and `removeFields` are still applied on top if provided.

## Stack

- TypeScript + Bun
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — stdio transport
- [`@huggingface/hub`](https://github.com/huggingface/huggingface.js/tree/main/packages/hub) — repo ops, uploads, file download
- `gray-matter` — YAML frontmatter round-tripping
- `remark` + `remark-gfm` — markdown AST for section position mapping
- `pino` — structured logging to stderr (stdout reserved for MCP JSON-RPC)
