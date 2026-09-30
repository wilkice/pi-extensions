/**
* Permission Gate Extension
*
* Default mode: prompts for confirmation before running potentially dangerous bash commands.
* Patterns checked: rm -rf, sudo, chmod/chown 777, kill, systemctl, ssh, shutdown, reboot
*
* Strict mode (--strict): prompts for every bash, write and edit tool call, local or remote.
* Intended for sessions against production servers. It cannot be turned off mid-session.
* Anything other than an explicit "Yes" blocks the call; without a UI every gated call is blocked.
*
* Usage:
*   pi --strict
*   pi --ssh prod --strict
*/

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STRICT_TOOLS = new Set(["bash", "write", "edit"]);
const STRICT_GUIDELINE =
    "Strict mode: every bash, write and edit call requires human approval. Prefer fewer, well-explained calls and do not chain unrelated commands.";

const YES = "Yes";
const NO = "No";
const NO_WITH_REASON = "No, with reason";

export default function (pi: ExtensionAPI) {
    pi.registerFlag("strict", {
        description: "Require approval for every bash, write and edit tool call",
        type: "boolean",
        default: false,
    });

    const isStrict = () => pi.getFlag("strict") === true;

    const sshCommandPattern =
        /(?:^|[;&|()\n])\s*(?:(?:command|exec)\s+)?(?:env(?:\s+(?:-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=[^\s]+))*\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:[^\s;&|()]+\/)?ssh(?=\s|[;&|()\n]|$)/i;

    const dangerousPatterns = [
        /\brm\s+(-rf?|--recursive)/i,
        /\bsudo\b/i,
        /\b(chmod|chown)\b.*777/i,
        /\bkill\b/i,
        /\bsystemctl\b/i,
        sshCommandPattern,
        /\bshutdown\b/i,
        /\breboot\b/i,
    ];

    pi.on("session_start", async (_event, ctx) => {
        if (!isStrict()) return;
        ctx.ui.setStatus("strict", ctx.ui.theme.fg("warning", "STRICT"));
        ctx.ui.notify("Strict mode: every bash, write and edit call requires approval", "warning");
    });

    pi.on("before_agent_start", async (event) => {
        if (!isStrict()) return;
        const guidelines = event.systemPromptOptions.promptGuidelines;
        if (!guidelines.includes(STRICT_GUIDELINE)) guidelines.push(STRICT_GUIDELINE);
    });

    pi.on("tool_call", async (event, ctx) => {
        const strict = isStrict();
        const command = event.toolName === "bash" ? (event.input.command as string) : undefined;
        const isDangerous = command !== undefined && dangerousPatterns.some((p) => p.test(command));

        if (strict ? !STRICT_TOOLS.has(event.toolName) : !isDangerous) return undefined;

        if (!ctx.hasUI) {
            // In non-interactive mode, block by default
            return {
                block: true,
                reason: strict
                    ? "Strict mode: blocked (no UI for confirmation)"
                    : "Dangerous command blocked (no UI for confirmation)",
            };
        }

        if (!strict) {
            const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, [YES, NO]);
            if (choice !== YES) {
                return { block: true, reason: "Blocked by user" };
            }
            return undefined;
        }

        const lines: string[] = [];
        if (isDangerous) lines.push("⚠️ matches dangerous pattern", "");
        lines.push(`[STRICT] ${event.toolName}`, "");
        if (command !== undefined) {
            lines.push(`  ${command}`);
            const timeout = event.input.timeout as number | undefined;
            if (timeout) lines.push("", `Timeout: ${timeout}s`);
        } else {
            lines.push(`  ${event.input.path as string}`);
        }
        lines.push("", "Allow?");

        const signal = ctx.signal;
        const choice = await ctx.ui.select(lines.join("\n"), [YES, NO, NO_WITH_REASON], { signal });
        if (signal?.aborted) return { block: true, reason: "Blocked by user" };
        if (choice === YES) return undefined;

        if (choice === NO_WITH_REASON) {
            const reason = await ctx.ui.input("Reason for blocking (sent to the model)", undefined, { signal });
            if (!signal?.aborted && reason?.trim()) {
                return { block: true, reason: `Blocked by user: ${reason.trim()}` };
            }
        }

        return { block: true, reason: "Blocked by user" };
    });
}
