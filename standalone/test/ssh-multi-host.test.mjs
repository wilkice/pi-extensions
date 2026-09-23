import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const packageDir = process.env.PI_PACKAGE_DIR || join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const require = createRequire(join(packageDir, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: {
    "@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js"),
    "@earendil-works/pi-ai": join(packageDir, "node_modules/@earendil-works/pi-ai/dist/index.js"),
    "@earendil-works/pi-tui": join(packageDir, "node_modules/@earendil-works/pi-tui/dist/index.js"),
    "typebox": join(packageDir, "node_modules/typebox/build/index.mjs"),
} });
const { default: install } = await jiti.import(resolve(import.meta.dirname, "../ssh-multi-host.ts"));
const initialExitCode = process.exitCode;
const initialExitListeners = new Set(process.listeners("exit"));

async function harness(t, opts = {}) {
    const dir = mkdtempSync(join(tmpdir(), "pi-ssh-multi-"));
    mkdirSync(join(dir, "bin"));
    const fake = join(dir, "bin", "ssh");
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SSH_TEST_LOG, JSON.stringify(args) + '\\n');
const alias = args[args.indexOf('--') + 1];
const command = args.at(-1);
if (process.env.SSH_TEST_FAIL === alias) { console.error('unreachable'); process.exit(255); }
if (command.includes("bash -lc ':'")) process.exit(0);
if (command.includes('test -r')) process.exit(0);
if (command.includes('cat --')) { process.stdout.write('line one\\nline two\\nline three'); process.exit(0); }
if (command.includes('sleep 60')) { setTimeout(() => process.exit(0), 60000); return; }
process.stdout.write(alias + ': ' + command);
`);
    chmodSync(fake, 0o755);
    const old = { PATH: process.env.PATH, SSH_TEST_LOG: process.env.SSH_TEST_LOG, SSH_TEST_FAIL: process.env.SSH_TEST_FAIL };
    process.env.PATH = `${join(dir, "bin")}:${old.PATH}`;
    process.env.SSH_TEST_LOG = join(dir, "ssh.log");
    if (opts.fail) process.env.SSH_TEST_FAIL = opts.fail;
    else delete process.env.SSH_TEST_FAIL;
    t.after(() => {
        process.env.PATH = old.PATH;
        if (old.SSH_TEST_LOG === undefined) delete process.env.SSH_TEST_LOG; else process.env.SSH_TEST_LOG = old.SSH_TEST_LOG;
        if (old.SSH_TEST_FAIL === undefined) delete process.env.SSH_TEST_FAIL; else process.env.SSH_TEST_FAIL = old.SSH_TEST_FAIL;
        process.exitCode = initialExitCode;
        for (const listener of process.listeners("exit")) if (!initialExitListeners.has(listener)) process.removeListener("exit", listener);
        rmSync(dir, { recursive: true, force: true });
    });
    const handlers = new Map();
    const tools = new Map();
    const entries = [...(opts.entries || [])];
    const notices = [];
    const prompts = [];
    let active = [];
    let status = "";
    let shutdowns = 0;
    const pi = {
        on(name, handler) { handlers.set(name, handler); },
        registerFlag() {},
        getFlag() { return opts.flag; },
        registerTool(tool) { tools.set(tool.name, tool); },
        setActiveTools(names) { active = names; },
        appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    };
    const ctx = {
        mode: opts.mode || "tui",
        sessionManager: { getBranch: () => entries },
        shutdown() { shutdowns++; },
        ui: {
            theme: { fg: (_color, text) => text },
            notify: (...args) => notices.push(args),
            setStatus: (_key, text) => { status = text; },
            select: async (...args) => { prompts.push(args); return opts.approve ? "Yes" : "No"; },
        },
    };
    install(pi);
    await handlers.get("session_start")({ reason: opts.reason || "startup" }, ctx);
    return { dir, handlers, tools, entries, notices, prompts, ctx,
        get active() { return active; }, get status() { return status; }, get shutdowns() { return shutdowns; },
        sshCalls: () => readFileSync(join(dir, "ssh.log"), "utf8").trim().split("\n").map(JSON.parse),
    };
}

test("validates both targets, restricts tools, persists inventory, and routes concurrent calls", async (t) => {
    const h = await harness(t, { flag: "app=application;db=database=primary" });
    assert.deepEqual(h.active, ["read", "bash", "remote_read", "remote_bash"]);
    assert.match(h.status, /app, db/);
    assert.deepEqual(h.entries[0].data, [{ alias: "app", purpose: "application" }, { alias: "db", purpose: "database=primary" }]);
    const prompt = await h.handlers.get("before_agent_start")({ systemPrompt: "base" });
    assert.match(prompt.systemPrompt, /db: database=primary/);
    assert.deepEqual(h.tools.get("remote_bash").parameters.properties.target.enum, ["app", "db"]);
    const [a, b] = await Promise.all([
        h.tools.get("remote_bash").execute("1", { target: "app", command: "hostname" }),
        h.tools.get("remote_bash").execute("2", { target: "db", command: "hostname" }),
    ]);
    assert.equal(a.details.target, "app");
    assert.equal(b.details.target, "db");
    assert.equal(a.details.exitCode, 0);
    assert.match(a.content[0].text, /SSH target: app/);
    assert.deepEqual(h.sshCalls().map((args) => args[args.indexOf("--") + 1]).sort(), ["app", "app", "db", "db"]);
    assert.ok(h.sshCalls().every((args) => args.includes("BatchMode=yes") && args.includes("StrictHostKeyChecking=yes")));
});

test("remote read enforces absolute paths and includes provenance", async (t) => {
    const h = await harness(t, { flag: "app=application" });
    const read = h.tools.get("remote_read");
    await assert.rejects(read.execute("1", { target: "app", path: "relative" }), /absolute path/);
    await assert.rejects(read.execute("1", { target: "other", path: "/tmp/log" }), /Unknown/);
    const result = await read.execute("1", { target: "app", path: "/tmp/log", offset: 2, limit: 1 });
    assert.equal(result.details.target, "app");
    assert.match(result.content.at(-1).text, /line two/);
    assert.doesNotMatch(result.content.at(-1).text, /line one/);
});

test("invalid or unreachable inventories fail closed without persistence", async (t) => {
    for (const flag of [undefined, "app=", "a=x;;b=y", "-x=bad", "user@host=bad", "a=x;a=y"]) {
        const h = await harness(t, { flag });
        assert.equal(h.shutdowns, 1);
        assert.deepEqual(h.active, []);
        assert.equal(h.entries.length, 0);
    }
    const h = await harness(t, { flag: "app=application;db=database", fail: "db" });
    assert.equal(h.shutdowns, 1);
    assert.match(h.notices.at(-1)[0], /db: unreachable/);
    assert.equal(h.entries.length, 0);
});

test("saved inventory wins, is revalidated, and new session is cancelled", async (t) => {
    const saved = [{ type: "custom", customType: "ssh-multi-host-inventory", data: [{ alias: "saved", purpose: "old topology" }] }];
    const h = await harness(t, { entries: saved, flag: "new=ignored", reason: "resume" });
    assert.equal(h.shutdowns, 0);
    assert.match(h.notices[0][0], /ignored/);
    assert.deepEqual(h.sshCalls().map((args) => args[args.indexOf("--") + 1]), ["saved"]);
    assert.deepEqual(h.handlers.get("session_before_switch")({ reason: "new" }, h.ctx), { cancel: true });
    assert.match(h.notices.at(-1)[0], /new Pi process/);
});

test("dangerous local and remote commands are confirmed separately", async (t) => {
    const h = await harness(t, { flag: "app=application", approve: true });
    const gate = h.handlers.get("tool_call");
    assert.equal(await gate({ toolName: "bash", input: { command: "ps aux" } }, h.ctx), undefined);
    await gate({ toolName: "bash", input: { command: "sudo systemctl restart app" } }, h.ctx);
    await gate({ toolName: "remote_bash", input: { target: "app", command: "rm -rf /tmp/x" } }, h.ctx);
    assert.equal(h.prompts.length, 2);
    assert.match(h.prompts[0][0], /Target: local[\s\S]*privilege escalation[\s\S]*sudo systemctl restart app/);
    assert.match(h.prompts[1][0], /Target: app[\s\S]*file deletion[\s\S]*rm -rf/);
});

test("rejection blocks only its call; same-target calls retain independent routes", async (t) => {
    const h = await harness(t, { flag: "app=application" });
    const gate = h.handlers.get("tool_call");
    assert.deepEqual(await gate({ toolName: "remote_bash", input: { target: "app", command: "kill 123" } }, h.ctx),
        { block: true, reason: "Command rejected for app" });
    assert.equal(await gate({ toolName: "remote_bash", input: { target: "app", command: "hostname" } }, h.ctx), undefined);
    const tool = h.tools.get("remote_bash");
    const [a, b] = await Promise.all([
        tool.execute("1", { target: "app", command: "printf '%s' 'one'" }),
        tool.execute("2", { target: "app", command: "printf '%s' 'two'" }),
    ]);
    assert.match(a.content.at(-1).text, /one/);
    assert.match(b.content.at(-1).text, /two/);
    assert.equal(a.details.target, "app");
    assert.equal(b.details.target, "app");
    assert.deepEqual(h.sshCalls().map((args) => args[args.indexOf("--") + 1]), ["app", "app", "app"]);
});

test("timeouts and cancellation report best-effort remote termination", async (t) => {
    const h = await harness(t, { flag: "app=application" });
    const tool = h.tools.get("remote_bash");
    await assert.rejects(tool.execute("1", { target: "app", command: "sleep 60", timeout: 0.1 }), /SSH target: app.*timeout.*Remote process may still be running/);
    const controller = new AbortController();
    const pending = tool.execute("2", { target: "app", command: "sleep 60" }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, /SSH target: app.*aborted.*Remote process may still be running/);
});

test("non-TUI and resume without saved state fail closed", async (t) => {
    const a = await harness(t, { flag: "app=application", mode: "print" });
    assert.equal(a.shutdowns, 1);
    const b = await harness(t, { flag: "app=application", reason: "resume" });
    assert.equal(b.shutdowns, 1);
    assert.match(b.notices.at(-1)[0], /no saved SSH target inventory/);
});
