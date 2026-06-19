import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { uploadJobs, type UploadJob } from "../types/upload-job";
import { logger } from "../logger";

export const HF_MCP_DIR = process.env.HF_MCP_DIR ?? join(homedir(), ".hf_mcp");
export const JOBS_FILE = join(HF_MCP_DIR, "upload-jobs.json");
const ARCHIVE_PATTERN = /^upload-jobs\.(\d{4}-\d{2}-\d{2})\.json$/;
const MAX_ACTIVE_COMPLETED = Number(process.env.HF_MCP_MAX_COMPLETED_JOBS ?? 50);

export function hydrateJob(job: UploadJob): UploadJob {
    return {
        ...job,
        startedAt: new Date(job.startedAt),
        completedAt: job.completedAt ? new Date(job.completedAt) : undefined,
    };
}

async function appendToArchive(entries: [string, UploadJob][]): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    const archiveFile = join(HF_MCP_DIR, `upload-jobs.${date}.json`);
    let existing: [string, UploadJob][] = [];
    try {
        existing = JSON.parse(await readFile(archiveFile, "utf-8"));
    } catch {}
    const merged = new Map([...existing, ...entries]);
    await writeFile(archiveFile, JSON.stringify([...merged.entries()], null, 2));
}

export async function persistJobs(): Promise<void> {
    try {
        await mkdir(HF_MCP_DIR, { recursive: true });

        const active = [...uploadJobs.entries()].filter(([, j]) => j.jobStatus === "Pending" || j.jobStatus === "Running");
        const completed = [...uploadJobs.entries()].filter(([, j]) => j.jobStatus === "Done" || j.jobStatus === "Error");

        if (completed.length > MAX_ACTIVE_COMPLETED) {
            completed.sort((a, b) => (a[1].completedAt?.getTime() ?? 0) - (b[1].completedAt?.getTime() ?? 0));
            const overflow = completed.slice(0, completed.length - MAX_ACTIVE_COMPLETED);
            const keep = completed.slice(completed.length - MAX_ACTIVE_COMPLETED);
            await appendToArchive(overflow);
            for (const [id] of overflow) uploadJobs.delete(id);
            await writeFile(JOBS_FILE, JSON.stringify([...active, ...keep], null, 2));
        } else {
            await writeFile(JOBS_FILE, JSON.stringify([...uploadJobs.entries()], null, 2));
        }
    } catch (error) {
        logger.error({ error }, "Unable to persist jobs.");
    }
}

export async function loadJobs(): Promise<void> {
    try {
        const entries = JSON.parse(await readFile(JOBS_FILE, "utf-8")) as [string, UploadJob][];
        for (const [id, job] of entries) {
            uploadJobs.set(id, hydrateJob(job));
        }
        let hadStale = false;
        for (const job of uploadJobs.values()) {
            if (job.jobStatus === "Running" || job.jobStatus === "Pending") {
                job.jobStatus = "Error";
                job.error = "Upload interrupted — server restarted";
                job.completedAt = new Date();
                hadStale = true;
            }
        }
        if (hadStale) await persistJobs();
    } catch (error: any) {
        if (error?.code !== "ENOENT") {
            logger.error({ error }, "Failed to load jobs from disk.");
        }
    }
}

export async function listArchiveFiles(): Promise<string[]> {
    try {
        const files = await readdir(HF_MCP_DIR);
        return files.filter(f => ARCHIVE_PATTERN.test(f)).sort();
    } catch {
        return [];
    }
}

export async function readArchiveJobs(filename: string): Promise<[string, UploadJob][]> {
    try {
        const entries = JSON.parse(await readFile(join(HF_MCP_DIR, filename), "utf-8")) as [string, UploadJob][];
        return entries.map(([id, job]) => [id, hydrateJob(job)]);
    } catch {
        return [];
    }
}

export async function rewriteArchiveFile(filename: string, entries: [string, UploadJob][]): Promise<void> {
    await writeFile(join(HF_MCP_DIR, filename), JSON.stringify(entries, null, 2));
}

export async function deleteArchiveFile(filename: string): Promise<void> {
    await unlink(join(HF_MCP_DIR, filename));
}
