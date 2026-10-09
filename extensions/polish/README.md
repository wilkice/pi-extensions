# Prompt polishing with a Jev gate

The polish extension reviews drafts with Pi's built-in `deepseek/deepseek-flash`
model. Pi's native TypeSafe Jev classifier first decides whether the draft is
mostly English and whether it needs polishing at all.

## Setup

Jev uses Pi's built-in `typesafe/jev-latest` classifier model. Provide its key
before starting Pi:

```sh
export TYPESAFE_API_KEY="your-key"
```

No extra dependencies are needed. The Jev model, threshold, timeout, and retry
policy are fixed in the extension rather than exposed as settings.

## Use

1. Run `/reload` to load the extension.
2. Run `/polish` to enable it (initially off).
3. Type an ordinary text prompt and press Enter.
4. If Jev says it is mostly English and needs polishing, review/edit DeepSeek's
   polished result. Otherwise the original is sent immediately.
5. Press Enter again to send the reviewed result without another check or
   polishing pass.

The footer shows `polish: off`, `polish: on`, or
`polish: review · Enter sends`. When Jev skips polishing, it shows why with the
deciding probability until your next input: `polish: skipped · not English
(en 0.12)` or `polish: skipped · already clean (needs 0.21)`.

`/polish` toggles the feature; the preference is saved globally in
`~/.pi/agent/polish.json` (or your `PI_CODING_AGENT_DIR`).

While checking and polishing, the editor is replaced by one cancellable loader.
Escape during either request restores the original draft without submitting it.

## Jev gate

For each eligible draft, the extension sends the complete draft to Jev through
`ctx.modelRegistry.classify()` with two yes/no questions in one request:

- `mostlyEnglish`: is most of the meaningful prose English? Code, URLs, paths,
  identifiers, Markdown syntax, and punctuation are ignored.
- `needsPolish`: would the prose benefit from grammar, spelling,
  capitalization, or clarity fixes?

- If both probabilities are `0.5` or greater, the draft proceeds to DeepSeek polishing.
- If either is below `0.5`, the original draft is submitted immediately and silently.
- The Jev request times out after three seconds and is not retried.
- If the model is unavailable, the key is missing, or Jev returns an error,
  timeout, or malformed answer, the extension shows the Jev error detail in a
  warning and submits the original unchanged.

A DeepSeek failure behaves differently: it restores the original without
submitting it, so Enter can retry. Toggle `/polish` off to send without either
check.

## Scope, privacy, and cost

- Jev receives the full eligible draft, even when it ultimately bypasses polishing.
- DeepSeek receives only drafts that pass both Jev questions.
- Neither request includes conversation history or tools.
- The extension asks DeepSeek for conservative grammar and clarity improvements
  while preserving meaning, ambiguity, code, paths, and references. Review the
  result: model instructions cannot guarantee semantic equivalence.
- Commands (`/…`, `!…`), image-bearing messages, queued/steered messages, and
  messages entered while the agent is busy bypass both services.
- The extension runs only in the interactive terminal, not RPC, print, or JSON
  mode.
- Each eligible submission makes a TypeSafe request; drafts that pass the gate
  also make a separate DeepSeek request. Both may incur provider charges, and
  their usage is not included in Pi's conversation token totals.

## Tests

The tests use the installed Pi runtime, fake Jev and DeepSeek responses, and
temporary preferences. They make no live model calls and do not change your
saved preference:

```sh
node --test extensions/polish/test/polish.test.mjs
```

If Pi is not installed globally through npm, set `PI_PACKAGE_DIR` to its package
directory before running the tests.
