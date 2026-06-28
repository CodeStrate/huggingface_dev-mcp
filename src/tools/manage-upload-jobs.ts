import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { uploadJobs } from "../types/upload-job";
import { logger } from "../logger";
import { persistJobs, listArchiveFiles, readArchiveJobs, rewriteArchiveFile, deleteArchiveFile } from "../utils/upload-job-store";

export function registerManageUploadJobs(server: McpServer){
    server.registerTool(
        "manage_upload_jobs",
        {
            description: 
            `Utility to list, delete or clean up upload jobs across active file or dated archives.
            Use list to browse, delete for a single job, delete-after/delete-before for dated batch deletion
            and clear to clean up the job persist directory.`,
            inputSchema:
            {
                action: z.enum(["list", "delete", "delete-after", "delete-before", "clear"]).describe("Action or operation to perform"),
                status: z.enum(["Running", "Pending", "Error", "Done"]).optional().describe("Filter Jobs by Status"),
                jobId: z.string().describe("Job ID to delete - single operation").optional(),
                date: z.string().optional().describe("ISO Date (YYYY-MM-DD) for cutoff - batch delete after/before")
            },
        },
        async ({ action, status, jobId, date }) => {
            try {
                switch (action) {
                    case "list": {
                        const activeJobs = [...uploadJobs.values()]
                            .filter(j => !status || j.jobStatus === status)
                            .map(j => ({
                                jobId: j.jobId,
                                status: j.jobStatus,
                                repoId: j.repoId,
                                startedAt: j.startedAt,
                                completedAt: j.completedAt,
                                error: j.error,
                                source: "active",
                            }));

                        const archives = await listArchiveFiles();
                        const archiveJobs = [];
                        for (const file of archives) {
                            for (const [, job] of await readArchiveJobs(file)) {
                                if (!status || job.jobStatus === status) {
                                    archiveJobs.push({
                                        jobId: job.jobId,
                                        status: job.jobStatus,
                                        repoId: job.repoId,
                                        startedAt: job.startedAt,
                                        completedAt: job.completedAt,
                                        error: job.error,
                                        source: file,
                                    });
                                }
                            }
                        }

                        const all = [...activeJobs, ...archiveJobs]
                            .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

                        return {
                            content: [{ type: "text" as const, text: JSON.stringify({ total: all.length, jobs: all }, null, 2) }],
                        };
                    }

                    case "delete": {
                        if (!jobId) return {
                            isError: true,
                            content: [{ type: "text" as const, text: "jobId is required for delete action." }],
                        };

                        if (uploadJobs.has(jobId)) {
                            uploadJobs.delete(jobId);
                            await persistJobs();
                            return { content: [{ type: "text" as const, text: `Deleted job ${jobId} from active file.` }] };
                        }

                        for (const file of await listArchiveFiles()) {
                            const entries = await readArchiveJobs(file);
                            const filtered = entries.filter(([id]) => id !== jobId);
                            if (filtered.length < entries.length) {
                                filtered.length === 0
                                    ? await deleteArchiveFile(file)
                                    : await rewriteArchiveFile(file, filtered);
                                return { content: [{ type: "text" as const, text: `Deleted job ${jobId} from ${file}.` }] };
                            }
                        }

                        return {
                            isError: true,
                            content: [{ type: "text" as const, text: `No job found with ID: ${jobId}` }],
                        };
                    }

                    case "delete-before":
                    case "delete-after": {
                        if (!date) return {
                            isError: true,
                            content: [{ type: "text" as const, text: `date is required for ${action}.` }],
                        };

                        const cutoff = new Date(date);
                        if (isNaN(cutoff.getTime())) return {
                            isError: true,
                            content: [{ type: "text" as const, text: `Invalid date: ${date}. Use YYYY-MM-DD format.` }],
                        };

                        const before = action === "delete-before";
                        let activeDeleted = 0;

                        for (const [id, job] of uploadJobs.entries()) {
                            if (!job.completedAt) continue;
                            if (status && job.jobStatus !== status) continue; // filters by status, allowing "delete all Error jobs before/after"
                            if (before ? job.completedAt < cutoff : job.completedAt > cutoff) {
                                uploadJobs.delete(id);
                                activeDeleted++;
                            }
                        }
                        if (activeDeleted > 0) await persistJobs();

                        let archivesAffected = 0;
                        for (const file of await listArchiveFiles()) {
                            const entries = await readArchiveJobs(file);
                            const survivingJobs = entries.filter(([, job]) => {
                                if (!job.completedAt) return true; // its ongoing/incomplete
                                if (status && job.jobStatus !== status) return true;  // same as active
                                return before ? !(job.completedAt < cutoff) : !(job.completedAt > cutoff); // inverse of active
                            })

                            if (survivingJobs.length === 0){ // archive doesn't have a incomplete job 
                                await deleteArchiveFile(file);
                                archivesAffected++;
                            }else if (survivingJobs.length < entries.length){
                                await rewriteArchiveFile(file, survivingJobs); // only keep active/incomplete jobs
                                archivesAffected++;
                            }
                        }

                        return {
                            content: [{
                                type: "text" as const,
                                text: JSON.stringify({
                                    message: `Deleted jobs ${before ? "before" : "after"} ${date}.`,
                                    activeJobsDeleted: activeDeleted,
                                    archivesAffected,
                                }, null, 2),
                            }],
                        };
                    }

                    case "clear": {
                        const archives = await listArchiveFiles();
                        for (const file of archives) await deleteArchiveFile(file);
                        return {
                            content: [{
                                type: "text" as const,
                                text: JSON.stringify({ message: `Cleared ${archives.length} archive file(s).`, deleted: archives }, null, 2),
                            }],
                        };
                    }
                }
            } catch (error) {
                logger.error({ error }, "manage_upload_jobs failed");
                return {
                    isError: true,
                    content: [{ type: "text" as const, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }],
                };
            }
        },
    );
}

