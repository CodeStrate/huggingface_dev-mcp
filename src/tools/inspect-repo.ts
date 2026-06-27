import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { downloadFile, fileExists, listFiles } from "@huggingface/hub";
import { getHFToken } from "../client";
import { logger } from "../logger";
import matter from "gray-matter";

const REQUIRED_FILES = [
  "config.json",
  "tokenizer_config.json",
  "tokenizer.json",
] as const;

const MODEL_WEIGHTS = [
  ".safetensors", // includes mlx too
  ".gguf",
  ".pt", // pytorch
  ".bin" //old format compatibility
]

export function registerInspectRepo(server: McpServer) {
  server.registerTool(
    "inspect_repo",
    {
      description:
        `Check whether expected model files (config, tokenizer, weights) exist in a repo and
        returns the model card (README).`,
      inputSchema: {
        repoId: z.string().describe("Owner/repo-name, e.g. mistralai/Mistral-7B-v0.1"),
        summaryOnly: z.boolean().default(false).describe("If true, return only frontmatter YAML data and first n chars of README."),
        summaryLength: z.number().default(500).describe("Summary Length (default: 500 chars)")
      },
    },
    async ({ repoId, summaryOnly, summaryLength }) => {
      logger.info({ repoId, summaryOnly }, "inspecting repository");
      try {
        const accessToken = getHFToken();
        const repo = { type: "model" as const, name: repoId }

        const [fileChecks, allFiles, readmeResponse] = await Promise.all([
          Promise.all(
            REQUIRED_FILES.map(async (path) => ({
              path,
              exists: await fileExists({ repo, path, accessToken }),
            })),
          ),
          (async () => {
            const files: string[] = [];
            for await (const entry of listFiles({repo, recursive: true, accessToken })) {
              if (entry.type === "file") files.push(entry.path);
            }
            return files;
          })(),
          downloadFile({repo, path: "README.md", accessToken})
        ]);

        const modelWeights = allFiles.filter((file) => MODEL_WEIGHTS.some((ext) => file.endsWith(ext)));
        const isGGUF: boolean = modelWeights.some((file) => file.endsWith(".gguf"));

        // handle readme

        let modelCard: {metadata: Record<string, unknown>; content: string} | null = null;
        if (readmeResponse){
          const rawContent = await readmeResponse.text();
          const {data, content} = matter(rawContent); // data = YAML, content = md
          modelCard = {
            metadata: data,
            content: summaryOnly ? content.trim().slice(0, summaryLength) : content
          }
        }

        const report = {
          repoId,
          required: Object.fromEntries(
            fileChecks.map(({ path, exists }) => [path, exists]),
          ),
          modelWeights: {
            count: modelWeights.length,
            files: modelWeights,
          },
          all_present: fileChecks.every(({ exists }) => exists) && modelWeights.length > 0,
          isGGUF,
          modelCard,
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(report, null, 2) },
          ],
        };
      } catch (error) {
        logger.error({ error, repoId }, "failed to inspect repo.");
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Failed to inspect ${repoId}: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
}
