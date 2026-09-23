/**
 * Opt-in, TUI-only multi-host SSH diagnostic mode.
 *
 * pi -e ./extensions/ssh-multi-host/index.ts --ssh-hosts 'app=application;db=database'
 * SSH aliases must already be configured and trusted by OpenSSH.
 */
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool, truncateTail } from "@earendil-works/pi-coding-agent";

type Target = { alias: string; purpose: string };
const STATE = "ssh-multi-host-inventory";
const SSH_OPTIONS = [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=yes",
    "-o", "PreferredAuthentications=publickey", "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
];
const aliasPattern = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

function parseInventory(raw: string): Target[] {
    if (!raw.trim()) throw new Error("--ssh-hosts needs at least one alias=purpose entry");
    const seen = new Set<string>();
    return raw.split(";").map((entry) => {
        const at = entry.indexOf("=");
        if (at < 0) throw new Error(`Missing '=' in SSH target entry: ${entry.trim()}`);
        const alias = entry.slice(0, at).trim();
        const purpose = entry.slice(at + 1).trim();
        if (!aliasPattern.test(alias)) throw new Error(`Invalid OpenSSH alias: ${alias || "(empty)"}`);
        if (!purpose) throw new Error(`Missing purpose for SSH alias ${alias}`);
        if (seen.has(alias)) throw new Error(`Duplicate SSH alias: ${alias}`);
        seen.add(alias);
        return { alias, purpose };
    });
}

function validInventory(data: unknown): data is Target[] {
    if (!Array.isArray(data) || data.length === 0) return false;
    const seen = new Set<string>();
    return data.every((item) => {
        if (!item || typeof item.alias !== "string" || !aliasPattern.test(item.alias) ||
            typeof item.purpose !== "string" || !item.purpose.trim() || seen.has(item.alias)) return false;
        seen.add(item.alias);
        return true;
    });
}

function quote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

function remoteCommand(command: string): string {
    // OpenSSH sends one command string to the remote login shell. Quote the
    // Bash argument for that shell; Bash then receives the original bytes.
    return `bash -lc ${quote(command)}`;
}

type SshResult = { stdout: Buffer; stderr: Buffer; exitCode: number | null };
function ssh(alias: string, command: string, options: {
    signal?: AbortSignal; timeout?: number; onData?: (data: Buffer) => void;
} = {}): Promise<SshResult> {
    return new Promise((resolve, reject) => {
        const child = spawn("ssh", [...SSH_OPTIONS, "--", alias, remoteCommand(command)], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let stopped: "aborted" | "timeout" | undefined;
        let settled = false;
        const stop = (reason: "aborted" | "timeout") => {
            stopped = reason;
            child.kill("SIGKILL");
        };
        const abort = () => stop("aborted");
        const timer = options.timeout === undefined ? undefined : setTimeout(() => stop("timeout"), options.timeout * 1000);
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) stop("aborted");
        child.stdout.on("data", (data: Buffer) => { out.push(data); options.onData?.(data); });
        child.stderr.on("data", (data: Buffer) => { err.push(data); options.onData?.(data); });
        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        });
        child.on("close", (exitCode) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (stopped) reject(new Error(`SSH ${stopped}; local SSH client stopped. Remote process may still be running.`));
            else resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), exitCode });
        });
    });
}

const dangerous: [string, RegExp][] = [
    ["privilege escalation", /\b(?:sudo|su|doas)\b/i],
    ["file deletion", /\b(?:rm|rmdir|unlink)\b/i],
    ["shutdown or reboot", /\b(?:shutdown|reboot|poweroff|halt)\b/i],
    ["service change", /\b(?:systemctl|service)\s+(?:stop|restart|disable|kill|mask)\b/i],
    ["process termination", /\b(?:kill|killall|pkill|fuser\s+-k)\b/i],
    ["permission or ownership change", /\b(?:chmod|chown|chgrp|setfacl)\b/i],
    ["filesystem or block device", /\b(?:mkfs(?:\.\w+)?|fsck|fdisk|parted|mount|umount|dd)\b/i],
    ["truncation or output redirection", /(?:^|[^<])>{1,2}|\btruncate\b/i],
    ["in-place edit or tee", /\b(?:sed\s+-i\b|perl\s+-i\b|tee\b)\b/i],
    ["destructive Git", /\bgit\s+(?:reset\s+--hard|clean\b|push\s+(?:--force|-f\b)|rebase\b|checkout\s+--|restore\b)/i],
    ["Docker state change", /\bdocker\s+(?:rm|rmi|stop|restart|kill|prune|run|exec|compose\s+(?:down|stop|restart|up))\b/i],
    ["kubectl state change", /\bkubectl\s+(?:delete|apply|patch|replace|scale|rollout\s+(?:restart|undo)|drain|cordon|exec)\b/i],
    ["SQL mutation", /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(?:TABLE|DATABASE|INDEX)|ALTER\s+TABLE|TRUNCATE\s+TABLE|CREATE\s+(?:TABLE|DATABASE|INDEX))\b/i],
];

export default function (pi: ExtensionAPI) {
    pi.registerFlag("ssh-hosts", { description: "OpenSSH aliases and purposes: app=application;db=database", type: "string" });
    let targets: Target[] = [];
    let ready = false;

    const fail = (ctx: { mode: string; ui: { notify: (message: string, level: "error") => void }; shutdown: () => void }, message: string) => {
        ready = false;
        pi.setActiveTools([]);
        ctx.ui.notify(`Multi-host SSH: ${message}`, "error");
        if (ctx.mode !== "tui") process.stderr.write(`Multi-host SSH: ${message}\n`);
        process.exitCode = 1;
        // Pi's TUI shutdown calls process.exit(0). An exit listener can still
        // replace that explicit status after Pi finishes its own cleanup.
        process.once("exit", () => { process.exitCode = 1; });
        ctx.shutdown();
    };
    const assertTarget = (alias: string) => {
        if (!ready || !targets.some((item) => item.alias === alias)) throw new Error(`Unknown or unavailable SSH target: ${alias}`);
    };
    const withSource = (alias: string, result: { content: any[]; details?: unknown }, extra: Record<string, unknown> = {}) => ({
        content: [{ type: "text" as const, text: `[SSH target: ${alias}]` }, ...result.content],
        details: { ...(typeof result.details === "object" && result.details ? result.details : {}), target: alias, ...extra },
    });

    pi.on("session_start", async (event, ctx) => {
        ready = false;
        const saved = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === STATE).at(-1);
        const flag = pi.getFlag("ssh-hosts") as string | undefined;
        if (!saved && flag === undefined && (event.reason === "startup" || event.reason === "new")) return;
        pi.setActiveTools([]);
        if (ctx.mode !== "tui") return fail(ctx, "TUI mode is required");
        let next: Target[];
        try {
            if (saved) {
                if (!validInventory(saved.data)) throw new Error("Saved target inventory is invalid");
                next = saved.data;
                if (flag !== undefined) ctx.ui.notify("Saved SSH targets take precedence; --ssh-hosts was ignored.", "warning");
            } else {
                if (event.reason !== "startup" && event.reason !== "new") throw new Error("Session has no saved SSH target inventory");
                if (flag === undefined) throw new Error("Missing --ssh-hosts inventory");
                next = parseInventory(flag);
            }
        } catch (error) {
            return fail(ctx, (error as Error).message);
        }
        const checks = await Promise.all(next.map(async ({ alias }) => {
            try {
                const result = await ssh(alias, ":", { timeout: 7 });
                return result.exitCode === 0 ? null : `${alias}: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`;
            } catch (error) { return `${alias}: ${(error as Error).message}`; }
        }));
        const failures = checks.filter((item): item is string => item !== null);
        if (failures.length) return fail(ctx, `Target validation failed:\n${failures.join("\n")}`);
        targets = next;
        if (!saved) pi.appendEntry(STATE, next);
        // Register after validation so providers see an enum of verified aliases.
        const targetSchema = StringEnum(next.map((item) => item.alias), { description: "Exact configured SSH alias" });
        pi.registerTool({
            name: "remote_read", label: "remote_read", description: "Read an absolute file path on the named SSH target. Offset is 1-indexed.",
            executionMode: "parallel", promptSnippet: "Read a file on an explicit SSH target",
            parameters: Type.Object({ target: targetSchema, path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
            async execute(id, params, signal, onUpdate, toolCtx) {
                assertTarget(params.target);
                if (!isAbsolute(params.path)) throw new Error(`remote_read requires an absolute path: ${params.path}`);
                const read = createReadTool("/", { operations: {
                    access: async (path) => {
                        const result = await ssh(params.target, `test -r ${quote(path)}`, { signal });
                        if (result.exitCode !== 0) throw new Error(`[SSH target: ${params.target}] Cannot read ${path}: ${result.stderr.toString().trim()}`);
                    },
                    readFile: async (path) => {
                        const result = await ssh(params.target, `cat -- ${quote(path)}`, { signal });
                        if (result.exitCode !== 0) throw new Error(`[SSH target: ${params.target}] Read failed: ${result.stderr.toString().trim()}`);
                        return result.stdout;
                    },
                } });
                try {
                    return withSource(params.target, await read.execute(id, { path: params.path, offset: params.offset, limit: params.limit }, signal, onUpdate, toolCtx));
                } catch (error) {
                    throw new Error(`[SSH target: ${params.target}] ${(error as Error).message}`);
                }
            },
            renderCall(args, theme) { return new Text(theme.fg("toolTitle", `remote_read [${args.target}] ${args.path}`), 0, 0); },
            renderResult(result, _options, theme) { return new Text(theme.fg("accent", `[${result.details?.target ?? "unknown"}] `) + result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), 0, 0); },
        });
        pi.registerTool({
            name: "remote_bash", label: "remote_bash", description: "Run a Bash command on the named SSH target. A timeout in seconds is optional. SSH cancellation is best-effort; a remote process may continue.",
            executionMode: "parallel", promptSnippet: "Run Bash on an explicit SSH target",
            parameters: Type.Object({ target: targetSchema, command: Type.String(), timeout: Type.Optional(Type.Number()) }),
            async execute(_id, params, signal, onUpdate) {
                assertTarget(params.target);
                if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout <= 0 || params.timeout > 86400)) throw new Error("Invalid timeout: expected 0 < seconds <= 86400");
                const chunks: Buffer[] = [];
                let result: SshResult;
                try {
                    result = await ssh(params.target, params.command, { signal, timeout: params.timeout,
                        onData: (data) => {
                            chunks.push(data);
                            if (onUpdate) onUpdate(withSource(params.target, { content: [{ type: "text", text: truncateTail(Buffer.concat(chunks).toString()).content }] }));
                        },
                    });
                } catch (error) {
                    throw new Error(`[SSH target: ${params.target}] ${(error as Error).message}`);
                }
                const output = truncateTail(Buffer.concat(chunks).toString());
                const status = result.exitCode === 0 ? "" : `\n[SSH exited with code ${result.exitCode}]`;
                const truncationNotice = output.truncated ? `\n[Output truncated: showing last ${output.outputLines} of ${output.totalLines} lines]` : "";
                return withSource(params.target, { content: [{ type: "text", text: `${output.content || "(no output)"}${truncationNotice}${status}` }], details: { truncation: output.truncated ? output : undefined } }, { exitCode: result.exitCode, timeout: params.timeout });
            },
            renderCall(args, theme) { return new Text(theme.fg("toolTitle", `remote_bash [${args.target}] ${args.command}`), 0, 0); },
            renderResult(result, _options, theme) { return new Text(theme.fg("accent", `[${result.details?.target ?? "unknown"}] `) + result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), 0, 0); },
        });
        pi.setActiveTools(["read", "bash", "remote_read", "remote_bash"]);
        ready = true;
        ctx.ui.setStatus("ssh-multi-host", ctx.ui.theme.fg("accent", `SSH: ${next.map((item) => item.alias).join(", ")}`));
    });

    pi.on("session_before_switch", (event, ctx) => {
        if (!ready || event.reason !== "new") return;
        ctx.ui.notify("Multi-host SSH: start a new Pi process with a new --ssh-hosts value.", "warning");
        return { cancel: true };
    });
    pi.on("before_agent_start", (event) => {
        if (!ready) return;
        pi.setActiveTools(["read", "bash", "remote_read", "remote_bash"]);
        return { systemPrompt: `${event.systemPrompt}\n\n## Multi-host SSH diagnostic environment\nTargets:\n${targets.map(({ alias, purpose }) => `- ${alias}: ${purpose}`).join("\n")}\nRemote operations require exact target aliases. Remote reads require absolute paths. Do not assume files or processes are shared across servers. Preserve each result's target provenance. Local read and bash run on this machine. SSH cancellation is best-effort; remote processes may continue.\n` };
    });
    pi.on("tool_call", async (event, ctx) => {
        if (!ready || (event.toolName !== "bash" && event.toolName !== "remote_bash")) return;
        const command = (event.input as { command?: string }).command;
        if (typeof command !== "string") return { block: true, reason: "Missing shell command" };
        const matches = dangerous.filter(([, pattern]) => pattern.test(command)).map(([label]) => label);
        if (!matches.length) return;
        const target = event.toolName === "bash" ? "local" : (event.input as { target?: string }).target;
        if (event.toolName === "remote_bash" && (!target || !targets.some((item) => item.alias === target))) return { block: true, reason: `Unknown SSH target: ${target}` };
        const choice = await ctx.ui.select(`Dangerous diagnostic command\nTarget: ${target}\nRules: ${matches.join(", ")}\n\n${command}\n\nRun this command?`, ["No", "Yes"]);
        if (choice !== "Yes") return { block: true, reason: `Command rejected for ${target}` };
    });
}
