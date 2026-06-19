import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "../logger";
import { getHFToken } from "../client";
import { createRepo, uploadFilesWithProgress } from "@huggingface/hub";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { uploadJobs, type UploadJob } from "../types/upload-job";
import { persistJobs } from "../utils/upload-job-store";


async function collectFilesForUpload(directory:string): Promise<{path: string; content: Blob}[]> {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true});
    return Promise.all(entries
    .filter(entry => entry.isFile() && !entry.name.startsWith("."))
    .map(async entry => {
        const absolutePath = join(entry.parentPath, entry.name)
        return {path: relative(directory, absolutePath), content: new Blob([await readFile(absolutePath)])}
    }))
}


async function runUpload(
    job: UploadJob,
    files: { path: string; content: Blob }[],
    repo: { type: "model" | "dataset" | "space"; name: string },
    commitMessage: string,
    accessToken: string
) {
    job.jobStatus = "Running";
    try {
        const gen = uploadFilesWithProgress({ repo, files, commitTitle: commitMessage, accessToken });
        for await (const event of gen) {
            if (event.event === "phase") {
                job.phase = event.phase;
                logger.info(`[${job.jobId}] phase: ${event.phase}`);
            } else if (event.event === "fileProgress" && event.state === "uploading") {
                job.currentFile = event.path;
            }
        }
        job.jobStatus = "Done";
        job.completedAt = new Date();
        logger.info(`[${job.jobId}] upload complete`);
        await persistJobs();
    } catch (error) {
        job.jobStatus = "Error";
        job.error = error instanceof Error ? error.message : String(error);
        job.completedAt = new Date();
        logger.error({ error }, `[${job.jobId}] upload failed`);
        await persistJobs();
    }
}

export function registerUploadModel(server: McpServer) {
    server.registerTool(
        "upload_model",
        {
            description: "Upload a model or adapter directory to HuggingFace. Returns a jobId immediately — use get_model_upload_status to track progress.",
            inputSchema: {
                repoId: z.string().describe("Owner/repo-name, e.g. google/gemma-4-12B, created if absent."),
                localDir: z.string().describe("Absolute path to the model/checkpoint/adapter directory."),
                repoType: z.enum(["model", "dataset", "space"]).default("model").describe("The type of repository: model (default), dataset, space"),
                visibility: z.enum(["public", "private", "protected"]).default("public").describe("Repository visibility"),
                commitMessage: z.string().default("Upload model files").describe("Commit message"),
            },
        },
        async (input) => {
            try {
                const accessToken = getHFToken();
                const repo = { type: input.repoType, name: input.repoId };

                let repoUrl: string;
                try {
                    ({ repoUrl } = await createRepo({ repo, visibility: input.visibility, accessToken }));
                } catch (e: any) {
                if (e?.statusCode === 409 || e?.message?.includes("already exists")) {
                    repoUrl = `https://huggingface.co/${input.repoId}`;
                    } else throw e;
                }
                // guard added for bad dir
                const dirStat = await stat(input.localDir).catch(() => null);
                if(!dirStat?.isDirectory()){
                    return {
                        isError: true,
                        content: [{type: "text" as const, text: `Directory specified not found: ${input.localDir}`}]
                    }
                }

                const files = await collectFilesForUpload(input.localDir);
                if (files.length === 0) {
                    return {
                        isError: true,
                        content: [{ type: "text" as const, text: `No files found in ${input.localDir} (hidden files are excluded).` }],
                    };
                }

                const jobId = crypto.randomUUID();
                const job: UploadJob = {
                    jobId,
                    jobStatus: "Pending",
                    repoId: input.repoId,
                    repoUrl,
                    currentFile: "",
                    startedAt: new Date(),
                };
                uploadJobs.set(jobId, job);
                await persistJobs()

                runUpload(job, files, repo, input.commitMessage, accessToken).catch(() => {});

                return {
                    content: [{
                        type: "text" as const,
                        text: JSON.stringify({ jobId, repoUrl, message: "Upload started. Use get_model_upload_status to track progress." }, null, 2),
                    }],
                };
            } catch (error) {
                logger.error({ error }, `Failed to start upload for ${input.repoId}`);
                return {
                    isError: true,
                    content: [{ type: "text" as const, text: `Failed to start upload: ${error instanceof Error ? error.message : String(error)}` }],
                };
            }
        }
    );
}