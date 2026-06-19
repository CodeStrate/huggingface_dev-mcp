import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { downloadFile, uploadFiles } from "@huggingface/hub";
import { getHFToken } from "../client";
import { logger } from "../logger";
import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, Heading } from "mdast";

function extractHeadingText(node: Heading): string {
    return node.children
        .map(c => ("value" in c ? (c as any).value : ""))
        .join("")
        .trim();
}

function parseHeading(heading: string): { depth: number; text: string } {
    let depth = 0;
    while (depth < heading.length && heading[depth] === "#") depth++;
    const text = heading.slice(depth).trimStart();
    return depth > 0 ? { depth, text } : { depth: 2, text: heading.trim() };
}

function buildProcessor() {
    return unified().use(remarkParse).use(remarkGfm);
}

function findSectionBounds(tree: Root, targetDepth: number, targetText: string): [number, number] | null {
    let headingIndex = -1;
    for (let i = 0; i < tree.children.length; i++) {
        const node = tree.children[i];
        if (!node) continue;
        if (node.type === "heading" && (node as Heading).depth === targetDepth) {
            if (extractHeadingText(node as Heading).toLowerCase() === targetText.toLowerCase()) {
                headingIndex = i;
                break;
            }
        }
    }
    if (headingIndex === -1) return null;

    let endIndex = tree.children.length;
    for (let i = headingIndex + 1; i < tree.children.length; i++) {
        const node = tree.children[i];
        if (!node) continue;
        if (node.type === "heading" && (node as Heading).depth <= targetDepth) {
            endIndex = i;
            break;
        }
    }
    return [headingIndex, endIndex];
}

function sectionOffsets(content: string, bounds: [number, number], tree: Root): [number, number] {
    const [startIdx, endIdx] = bounds;
    const startOffset = tree.children[startIdx]!.position!.start.offset!;
    const endOffset = endIdx < tree.children.length
        ? tree.children[endIdx]!.position!.start.offset!
        : content.length;
    return [startOffset, endOffset];
}

function upsertSection(content: string, heading: string, body: string): string {
    const { depth, text } = parseHeading(heading);
    const tree = buildProcessor().parse(content) as Root;
    const bounds = findSectionBounds(tree, depth, text);
    const newSection = `${heading}\n\n${body.trimEnd()}`;

    if (!bounds) {
        const trimmed = content.trimEnd();
        return (trimmed ? trimmed + '\n\n' : '') + newSection + '\n';
    }

    const [startOffset, endOffset] = sectionOffsets(content, bounds, tree);
    const before = content.slice(0, startOffset).trimEnd();
    const after = content.slice(endOffset).trimStart();
    return (before ? before + '\n\n' : '') + newSection + (after ? '\n\n' + after : '\n');
}

function removeSection(content: string, heading: string): string {
    const { depth, text } = parseHeading(heading);
    const tree = buildProcessor().parse(content) as Root;
    const bounds = findSectionBounds(tree, depth, text);

    if (!bounds) return content;

    const [startOffset, endOffset] = sectionOffsets(content, bounds, tree);
    const before = content.slice(0, startOffset).trimEnd();
    const after = content.slice(endOffset).trimStart();

    if (!before && !after) return '';
    if (!before) return after;
    if (!after) return before + '\n';
    return before + '\n\n' + after;
}

export function registerUpdateModelCard(server: McpServer) {
    server.registerTool(
        "update_model_card",
        {
            description:
                "Patch a HuggingFace model card README. Use structured fields for surgical edits (only the specified parts change). Use 'content' to replace the entire card for full rewrites. Creates the README if it doesn't exist.",
            inputSchema: {
                repoId: z.string().describe("Owner/repo-name, e.g. mistralai/Mistral-7B-v0.1"),
                content: z.string().optional().describe(
                    `Full README.md markdown body to commit. frontmatter and removeFields are still applied on top if provided. Use for full card rewrites.
                    Avoid for single-field or minor changes — use frontmatter or sections instead.`,
                ),
                frontmatter: z.record(z.string(), z.unknown()).optional().describe(
                    "Frontmatter fields to set. Arrays replace the existing value — provide the full desired array. Scalars replace.",
                ),
                removeFields: z.array(z.string()).optional().describe(
                    "Frontmatter keys to delete entirely, e.g. ['datasets', 'language'].",
                ),
                sections: z.array(z.object({
                    heading: z.string().describe("Section heading with ## markers, e.g. '## Benchmarks'"),
                    body: z.string().describe("New markdown content for this section, without the heading line."),
                })).optional().describe(
                    "Sections to upsert by heading (case-insensitive, depth-matched). Appended if not found.",
                ),
                removeSections: z.array(z.string()).optional().describe(
                    "Headings of sections to delete entirely, e.g. ['## Old Results'].",
                ),
                commitMessage: z.string().default("Update model card").describe("Commit message"),
            },
        },
        async ({ repoId, content, frontmatter, removeFields, sections, removeSections, commitMessage }) => {
            logger.info({ repoId }, "updating model card");
            try {
                const accessToken = getHFToken();
                const repo = { type: "model" as const, name: repoId };

                let updated: string;

                if (content !== undefined) {
                    if (frontmatter || removeFields) {
                        const { data: existingData, content: body } = matter(content);
                        let data = existingData as Record<string, unknown>;
                        if (frontmatter) data = { ...data, ...frontmatter };
                        if (removeFields) {
                            for (const field of removeFields) delete data[field];
                        }
                        updated = matter.stringify(body, data);
                    } else {
                        updated = content;
                    }
                } else {
                    const readmeResponse = await downloadFile({ repo, path: "README.md", accessToken });
                    const raw = readmeResponse ? await readmeResponse.text() : "---\n---\n";

                    let { data, content: body } = matter(raw);

                    if (frontmatter) {
                        data = { ...data, ...frontmatter };
                    }
                    if (removeFields) {
                        for (const field of removeFields) delete data[field];
                    }
                    if (sections) {
                        for (const { heading, body: sectionBody } of sections) {
                            body = upsertSection(body, heading, sectionBody);
                        }
                    }
                    if (removeSections) {
                        for (const heading of removeSections) {
                            body = removeSection(body, heading);
                        }
                    }

                    updated = matter.stringify(body, data);
                }

                await uploadFiles({
                    repo,
                    files: [{ path: "README.md", content: new Blob([updated], { type: "text/plain" }) }],
                    commitTitle: commitMessage,
                    accessToken,
                });

                return {
                    content: [{
                        type: "text" as const,
                        text: JSON.stringify({
                            repoId,
                            repoUrl: `https://huggingface.co/${repoId}`,
                            message: "Model card updated successfully.",
                        }, null, 2),
                    }],
                };
            } catch (error) {
                logger.error({ error, repoId }, "failed to update model card");
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: `Failed to update model card for ${repoId}: ${error instanceof Error ? error.message : String(error)}`,
                    }],
                };
            }
        },
    );
}
