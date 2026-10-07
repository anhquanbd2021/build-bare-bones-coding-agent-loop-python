# Agent Loop Under Glass — companion demo

Interactive lab for the article *A Coding Agent Is a While Loop — Everything
Else Is Plumbing*. Watch one turn of a coding-agent loop step by step —
boundary → model → tool dispatch → observation → boundary — then inject
steering mid-run and inspect the append-only session log it leaves behind.

Zero dependencies — Node 20+ only. The loop engine, tool registry, model
adapters, and scenarios are plain ES modules shared by the browser UI, the
CLI report, and the test suite.

## What it proves

| Piece | What the lab shows |
|---|---|
| **The loop** (`public/engine.mjs`) | A `while` loop over a message list. The only stop signal is the model returning text instead of a tool call — no step cap. |
| **Boundaries + queues** | Steering drains before every model request; follow-ups drain only at would-stop; abort clears both queues. |
| **The corruption they prevent** | Run `steered-fetch` in `immediate` mode and inject during `web_fetch`: the user message lands between the tool call and its observation → `TRANSCRIPT CORRUPTED`. Same keystroke in `boundary` mode lands cleanly. |
| **Tool registry** (`public/tools.mjs`) | Real dispatch over an in-memory FS: `read`, `write`, `edit` (unique-match + BOM/CRLF normalization + whitespace fallback), `bash`, `todo_write` (overwrite in place), `web_fetch` (fixture pages). |
| **Providers** (`public/models.mjs`) | Two scripted adapters behind one contract — `async (messages) => {text|toolCalls}`. Swap voices without touching the loop. |
| **Session log** (`engine.mjs`) | One `messages` JSONL line per turn; "Resume" replays the file into a fresh run. |

## Run it

```text
npm start        # serve the lab on :3000 (PORT env var overrides)
npm test         # engine + tools + deployment tests
npm run report   # side-by-side boundary/immediate report; writes examples/*.jsonl
npm run check    # both
```

## Examples

- `examples/steered-at-boundary.jsonl` — steered-fetch in boundary mode:
  the injected user message lands before the next model call. Transcript valid.
- `examples/corrupted-injection.jsonl` — the same run in immediate mode:
  `"role":"user","spliced":true` sits between `web_fetch`'s call and its
  observation. Transcript invalid.

Regenerate either file with `npm run report`.

## Honest limits

- **The model is a playback deck.** It cannot react to what your steering
  says — it only shows *where* steered text lands in the message list. A real
  LLM would also change its next action.
- **The shell is a command table.** `bash` only runs commands the scenario
  registered, over an in-memory filesystem. Nothing touches your disk, and no
  real process ever starts.
- **No context window, retries, approvals, or tracing.** Real harnesses add
  all of these; they are deliberately out of scope.
- **Single turn, single agent.** No subagents, headless mode, or remote
  executors.

This is an educational simulator, not agent infrastructure.
