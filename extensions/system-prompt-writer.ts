/**
 * System Prompt Writer Extension
 *
 * Writes the effective system prompt immediately before an agent run starts.
 * By default, the prompt is stored next to the current Pi session file.
 *
 * Usage:
 *   pi -e ./extensions/system-prompt-writer.ts
 *   pi -e ./extensions/system-prompt-writer.ts --system-prompt-output /tmp/system-prompt.md
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function defaultOutputPath(sessionFile: string | undefined, cwd: string): string {
    if (!sessionFile) return resolve(cwd, ".pi-system-prompt.md");

    const base = sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : sessionFile;
    return `${base}.system-prompt.md`;
}

export default function (pi: ExtensionAPI) {
    pi.registerFlag("system-prompt-output", {
        description: "File that receives the effective system prompt",
        type: "string",
    });

    pi.on("agent_start", async (_event, ctx) => {
        const configuredPath = pi.getFlag("system-prompt-output");
        const outputPath =
            typeof configuredPath === "string"
                ? isAbsolute(configuredPath)
                    ? configuredPath
                    : resolve(ctx.cwd, configuredPath)
                : defaultOutputPath(ctx.sessionManager.getSessionFile(), ctx.cwd);

        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, ctx.getSystemPrompt(), { encoding: "utf8", mode: 0o600 });
    });
}
