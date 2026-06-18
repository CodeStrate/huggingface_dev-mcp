import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerInspectRepo } from "./tools/inspect-repo";
import { registerListModelRepos } from "./tools/list-model-repos";
import { registerUploadModel } from "./tools/upload-model";
import { registerGetModelUploadStatus } from "./tools/get-model-upload-status";
import { loadJobs } from "./utils/upload-job-store";
import { ensureAuthenticated } from "./client";

const server = new McpServer({
  name: "hf-mcp",
  version: "1.0.0",
});

registerInspectRepo(server);
registerListModelRepos(server);
registerUploadModel(server);
registerGetModelUploadStatus(server);

async function main() {
  await ensureAuthenticated();
  await loadJobs();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("hf-mcp started\n");
}

main().catch((error) => {
  process.stderr.write(`Fatal: ${error}\n`);
  process.exit(1);
});
