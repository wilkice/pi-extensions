import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// Resolve Pi from the installed CLI, without installing a second copy of its runtime.
const packageDir = process.env.PI_PACKAGE_DIR || join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "@earendil-works/pi-coding-agent",
);
const require = createRequire(join(packageDir, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
    alias: { "@earendil-works/pi-coding-agent": join(packageDir, "dist/index.js") },
});
const { initTheme } = await jiti.import(join(packageDir, "dist/index.js"));
initTheme("dark", false);
const { default: install } = await jiti.import(resolve(import.meta.dirname, "../index.ts"));

async function harness(t, options = {}) {
    const dir = mkdtempSync(join(tmpdir(), "pi-polish-test-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(dir, { recursive: true, force: true });
    });
    if (options.saved !== undefined) writeFileSync(join(dir, "polish.json"), options.saved);
    const events = new Map();
    const commands = new Map();
    const calls = [];
    const notices = [];
    let editor = "";
    let status;
    let component;
    let customCount = 0;
    const model = { id: "selected-model", provider: "test" };
    const polishModel = { id: "deepseek-flash", provider: "deepseek" };
    const ctx = {
        mode: "tui",
        model,
        isIdle: () => true,
        ui: {
            setStatus: (_key, text) => { status = text; },
            notify: (...args) => notices.push(args),
            setEditorText: text => { editor = text; },
            custom: factory => new Promise((resolve, reject) => {
                customCount++;
                try {
                    component = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, value => {
                        component?.dispose();
                        resolve(value);
                    });
                } catch (error) { reject(error); }
            }),
        },
        modelRegistry: {
            find: (provider, id) => options.modelAvailable === false
                ? undefined
                : provider === "deepseek" && id === "deepseek-flash" ? polishModel : undefined,
            complete: async (...args) => {
                calls.push(args);
                return options.complete ? options.complete(...args) : {
                    stopReason: "stop", content: [{ type: "text", text: "Please fix the bug." }],
                };
            },
        },
    };
    const pi = { on: (name, handler) => events.set(name, handler), registerCommand: (name, command) => commands.set(name, command) };
    install(pi);
    await events.get("session_start")({}, ctx);
    t.after(() => component?.dispose());
    return {
        dir, ctx, events, calls, notices,
        get editor() { return editor; },
        get status() { return status; },
        get customCount() { return customCount; },
        toggle: (args = "") => commands.get("polish").handler(args, ctx),
        input: (text = "pls fix bug", extra = {}) => events.get("input")({ text, source: "interactive", ...extra }, ctx),
        type: data => component.handleInput(data),
        cancel: () => component.handleInput("\x1b"),
    };
}

test("starts off, toggles and persists globally", async t => {
    const h = await harness(t);
    assert.equal(h.status, "polish: off");
    assert.equal((await h.input()).action, "continue");
    await h.toggle();
    assert.deepEqual(JSON.parse(readFileSync(join(h.dir, "polish.json"), "utf8")), { enabled: true });
    await h.events.get("session_start")({}, h.ctx);
    assert.equal(h.status, "polish: on");
    await h.toggle();
    assert.equal(h.status, "polish: off");
});

test("polishes only draft with DeepSeek Flash and thinking disabled, then sends edited draft once", async t => {
    const h = await harness(t, { saved: '{"enabled":true}' });
    assert.equal((await h.input()).action, "handled");
    assert.equal(h.editor, "Please fix the bug.", JSON.stringify(h.notices));
    assert.match(h.status, /review/);
    const [model, context, options] = h.calls[0];
    assert.deepEqual(model, { id: "deepseek-flash", provider: "deepseek" });
    assert.equal(context.messages.length, 1);
    assert.equal(context.messages[0].content[0].text, "pls fix bug");
    assert.equal(context.tools, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(options.samplingParams, { thinking: { type: "disabled" } });
    assert.equal((await h.input("Please fix the bug in foo.ts.")).action, "continue");
    assert.equal(h.calls.length, 1);
    assert.equal((await h.input("next draft")).action, "handled");
    assert.equal(h.calls.length, 2);
});

test("bypasses commands, attachments, busy/queued messages and noninteractive input", async t => {
    const h = await harness(t, { saved: '{"enabled":true}' });
    for (const [text, extra] of [
        ["/model", {}], [" !ls", {}], ["", {}],
        ["describe", { images: [{}] }], ["wait", { streamingBehavior: "steer" }],
        ["later", { streamingBehavior: "followUp" }], ["injected", { source: "extension" }],
        ["rpc", { source: "rpc" }],
    ]) assert.equal((await h.input(text, extra)).action, "continue");
    h.ctx.isIdle = () => false;
    assert.equal((await h.input()).action, "continue");
    h.ctx.isIdle = () => true;
    for (const mode of ["rpc", "print", "json"]) {
        h.ctx.mode = mode;
        assert.equal((await h.input()).action, "continue");
    }
    assert.equal(h.calls.length, 0);
    assert.equal(h.customCount, 0);
});

test("failures restore original and never submit or accept partial output", async t => {
    for (const response of [
        { stopReason: "error", errorMessage: "offline", content: [] },
        { stopReason: "length", content: [{ type: "text", text: "partial" }] },
        { stopReason: "stop", content: [] },
        { stopReason: "stop", content: [{ type: "text", text: "!rm file" }] },
        new Error("network failure"),
    ]) {
        await t.test(String(response.stopReason || response.message), async t => {
            const h = await harness(t, { saved: '{"enabled":true}', complete: () => {
                if (response instanceof Error) throw response;
                return response;
            } });
            assert.equal((await h.input()).action, "handled");
            assert.equal(h.editor, "pls fix bug");
            assert.ok(h.notices.some(([, level]) => level === "error"));
            assert.equal((await h.input()).action, "handled");
            assert.equal(h.calls.length, 2);
        });
    }
});

test("Escape cancels immediately; late completion cannot overwrite new typing", async t => {
    let resolve;
    const h = await harness(t, { saved: '{"enabled":true}', complete: () => new Promise(r => { resolve = r; }) });
    const pending = h.input();
    await Promise.resolve();
    assert.equal((await h.input("duplicate")).action, "handled");
    h.cancel();
    assert.equal((await pending).action, "handled");
    assert.equal(h.editor, "pls fix bug");
    assert.equal(h.calls[0][2].signal.aborted, true);
    h.ctx.ui.setEditorText("new typing");
    resolve({ stopReason: "stop", content: [{ type: "text", text: "late result" }] });
    await new Promise(r => setImmediate(r));
    assert.equal(h.editor, "new typing");
});

test("loader consumes typing instead of editing the draft", async t => {
    const h = await harness(t, { saved: '{"enabled":true}', complete: () => new Promise(() => {}) });
    const pending = h.input();
    await Promise.resolve();
    assert.equal(h.customCount, 1);
    h.type("new typing");
    h.type("\r");
    assert.equal(h.editor, "");
    assert.equal(h.calls.length, 1);
    h.cancel();
    await pending;
    assert.equal(h.editor, "pls fix bug");
});

test("shutdown cancels without restoring into the replacement session", async t => {
    const h = await harness(t, { saved: '{"enabled":true}', complete: () => new Promise(() => {}) });
    const pending = h.input();
    await Promise.resolve();
    await h.events.get("session_shutdown")({}, h.ctx);
    h.ctx.ui.setEditorText("replacement session");
    await pending;
    assert.equal(h.editor, "replacement session");
    assert.equal(h.calls[0][2].signal.aborted, true);
});

test("missing polish model restores draft; invalid preferences fall back to off", async t => {
    const h = await harness(t, { saved: "broken json", modelAvailable: false });
    assert.equal(h.status, "polish: off");
    assert.equal(h.notices[0][1], "warning");
    await h.toggle();
    assert.equal((await h.input()).action, "handled");
    assert.equal(h.editor, "pls fix bug");
    assert.equal(h.calls.length, 0);
});

test("unsupported undo argument does not toggle", async t => {
    const h = await harness(t);
    await h.toggle("undo");
    assert.equal(h.status, "polish: off");
});
