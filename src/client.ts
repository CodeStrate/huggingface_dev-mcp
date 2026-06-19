import { whoAmI } from "@huggingface/hub";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HF_CLI_TOKEN_PATH = join(homedir(), ".cache", "huggingface", "token");

export function getHFToken(): string {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error("HF_TOKEN is not set. Run the MCP server once standalone to authenticate.");
  return token;
}

export async function ensureAuthenticated(): Promise<void> {
  if (process.env.HF_TOKEN) return;

  try {
    const token = readFileSync(HF_CLI_TOKEN_PATH, "utf-8").trim();
    if (token) {
      process.env.HF_TOKEN = token;
      return;
    }
  } catch {}

  // Interactive fallback — src/dev only. Requires a real TTY (stdin inherited).
  // Not available when running as a published package via bunx from a headless MCP host
  // (Claude Desktop, Claude Code, Cursor, PiCode, OpenCode, etc.) — set HF_TOKEN in
  // your client's env config instead.
  process.stderr.write("No HF token found. Launching hf auth login...\n");
  const proc = Bun.spawn(["hf", "auth", "login"], { stdio: ["inherit", "inherit", "inherit"] });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    process.stderr.write("huggingface-cli login failed.\n");
    process.exit(1);
  }

  try {
    const token = readFileSync(HF_CLI_TOKEN_PATH, "utf-8").trim();
    if (token) {
      process.env.HF_TOKEN = token;
      return;
    }
  } catch {}

  process.stderr.write("Token not found after login. Set HF_TOKEN manually in your MCP config.\n");
  process.exit(1);
}

let _username: string | null = null;

export async function getHFUsername(): Promise<string> {
  if (_username) return _username;
  const info = await whoAmI({ accessToken: getHFToken() });
  _username = info.name;
  return _username;
}