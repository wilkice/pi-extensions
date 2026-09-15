# Prompt polishing MVP

## Use

1. Run `/reload` to load the extension.
2. Run `/polish` to enable it (initially off).
3. Type an ordinary text prompt and press Enter.
4. Wait for polishing, then review/edit the result in the editor.
5. Press Enter again to send it without another polishing pass.

The footer shows `polish: off`, `polish: on`, or `polish: review · Enter sends`.
`/polish` toggles the feature; the preference is saved globally in
`~/.pi/agent/polish.json` (or your `PI_CODING_AGENT_DIR`).

While polishing, the editor is temporarily replaced by a cancellable loader.
Escape restores your original draft. Errors, empty output, and incomplete output
also restore it. After cancellation/failure, Enter retries; toggle `/polish` off
to send without polishing. There is no undo command.

## Scope

- Uses the model currently selected when polishing begins, with its configured authentication.
- Sends only the draft and polishing instructions—not conversation history or tools.
- Asks for conservative grammar/clarity improvements while preserving language,
  meaning, ambiguity, code, paths, and references. Review the result: these are
  model instructions, not a guarantee of semantic equivalence.
- Skips commands (`/…`, `!…`), image-bearing messages, and messages sent while the agent is busy.
- Runs only in the interactive terminal, not RPC/print/JSON mode.
- Polishing is an additional model request and may incur provider charges.
  Its usage is not included in Pi's conversation token totals.

## Tests

Uses your installed Pi runtime, fake model responses, and temporary preferences;
no live model calls or changes to your saved preference:

```sh
node --test polish/test/polish.test.mjs
```

Run from the parent `extensions/` directory. If Pi is not installed globally via
npm, set `PI_PACKAGE_DIR` to its package directory for the test runner.
