---
name: loop
description: Re-run a prompt or wrapped skill on a time, event, or DOM-state trigger. Each iteration is fresh; persist anything across iterations via the ≤4KB scratchpad.
tools: read,scratchpad-write,event-subscribe
max_iterations: 50
---

# /loop

## When NOT to use this

- Wall-clock or hourly-plus cadence ("every morning at 9", "weekly") → `schedule_create` (/schedule skill).
- A one-shot task with a verifiable end state ("until tests pass") → `goal_set` (/goal skill).
- /loop is for minute-level polling and event/DOM reactions while the session is alive.

You are running INSIDE a loop iteration. Behave accordingly.

## Writing a loop contract (for whoever creates the loop)

A loop runs unattended — nobody is watching most fires. Before creating one, write its `prompt_text` as a small contract with three parts, so every fresh iteration knows exactly what to do and what it may NOT do:

- **Goal** — what winning looks like, and whether there's a finish line (a monitor with no end, or a closed loop that self-cancels when a condition holds).
- **Boundaries** — the fence you can walk away behind. What the loop may do freely; what it must never do; and the exact line between *ship on its own* and *stop and ask a human*. Underinvest here and you can't walk away.
- **SOP** — the steps each fire follows (read state + recent_runs → gather what changed → do the single most worthwhile thing → record a result line).

**Ship-vs-ask, mechanically:**
- The hard line is the loop's `mode` / `allowed_tool_classes`: destructive tools (write/edit/bash) are unavailable unless the loop was created with them opened. Keep a monitor in `chat` mode so it *cannot* take irreversible action.
- The soft line is `notify_user`: when a fire hits something risky, ambiguous, or above its pay grade, call `notify_user`, write the situation to the scratchpad, and do NOT self-ship this fire. A later fire (or the user in the app) handles it. There is no blocking "wait for approval" inside a loop — draft + notify, don't block.

## Iteration context model

You **do not see previous iterations' messages**. The only memory carried across iterations is the loop's `scratchpad` (≤ 4096 bytes). Treat each iteration as a fresh agent invocation that happens to share a scratchpad with its prior selves.

The system prompt for this iteration begins with a `<LOOP-CONTEXT>` block:

```
<LOOP-CONTEXT>
loop_id=<id>
iteration=<n>
trigger=<trigger expression literal>
fire_reason=<time | event:<topic> | state:tab=…:<selector>>
scratchpad_bytes=<len>
scratchpad:
<verbatim scratchpad content, or "(empty)">
</LOOP-CONTEXT>
```

## Trigger expression quick reference

- `time:<n>{s|m|h|d}` — every interval. Sub-minute rounds up to 1m.
- `time:dynamic` — you choose the next delay; emit a `loop-meta` block (see below).
- `event:<topic-pattern>` — fires when a matching EventBus event publishes.
- `state:tab=current|<id>:<css-selector>:change` — fires when the selector's DOM mutates (deferred — currently no-ops).
- `AND(a,b,…)` / `OR(a,b,…)` — combine; nesting depth ≤ 3.

## Deterministic gate (skip empty runs)

A loop may carry an optional `gate` — a cheap, LLM-free pre-check that runs each fire BEFORE the agent. If the gate says "nothing changed", the fire is skipped with zero token cost (`skipped_triggers` climbs); only when it says "run" does the agent wake, and the gate hands it the data it already fetched (in a `gate_output:` block inside `<LOOP-CONTEXT>`) so you don't re-fetch. This is how you run cheap long-interval `time:` polling loops without burning tokens on unchanged fires.

Three kinds (set via `loop_create`'s `gate` param):
- `http` `{url, extract}` — GET the url, extract a value (`extract` is a `$.a.b` JSON path or a `/regex/`; omit to use the whole body). Value-diff: the agent wakes only when the extracted value changes. Pairs with a `time:` trigger.
- `bash` `{command}` — run a command; its stdout is the value; same value-diff. Pairs with a `time:` trigger. (agent-mode loops only.)
- `event` `{path, equals}` — a predicate on the triggering event's payload (dot-path `equals` match). Pairs with an `event:` trigger.

Gates are fail-open: a broken gate (timeout, error) wakes the agent anyway (with the error in `gate_output`) — it never silently stalls the loop.

## Tool mode

The iteration's tool catalog is picked by `mode`, inherited from the sidebar's current chat mode at /loop creation time. Three modes form an inclusion hierarchy:

- `chat` (default, safe): reasoning + scratchpad + read-only tools (`think`, `web_search`, `web_fetch`, `memory_search`, `memory_view`, browser-read tools like `browser_get_content`/`browser_get_markdown`/`browser_screenshot`, `loop.scratchpad.get/set`)
- `browser`: `chat` ∪ browser interaction (`browser_click`, `browser_type`, `browser_scroll`, `browser_navigate`, `browser_activate_tab`, …)
- `agent`: `browser` ∪ destructive tools (`write`, `edit`, `bash`, `browser_edit_artifact`, `memory_create/update/delete`, canvas tools)

Two tools are always forbidden inside iterations regardless of mode: `loop.create` (would let an iteration spawn nested loops) and `ask_user` (would block on a sidebar that may be closed).

## Scratchpad usage

Call `loop.scratchpad.set({ content })` with the **full replacement content**. Bytes ≤ 4096 enforced. `loop.scratchpad.get()` reads it; you can also see it in the system prompt.

Use scratchpad to remember: cursor positions, last-seen IDs, derived state, the next thing you intend to do.

## State + logs discipline

Each iteration now sees a `recent_runs` block in `<LOOP-CONTEXT>` — the last few iterations' one-line results. Use it: do NOT redo work a recent run already did.

Keep two kinds of memory:
- **State** (the 4 KB scratchpad): the durable picture — skip-lists ("already handled X"), your current hypothesis, cursors/last-seen IDs, lessons learned. Read it at the top of every run; keep it small and current.
- **Logs** (automatic): the system records each run's one-line result (its `final_text`). End every run by stating a single clear result line — that line becomes your log for future runs, so make it specific ("no change since cursor 4821" / "filed 2 new items"), never "done".

A loop that maintains good state stops repeating itself and gets more valuable the longer it runs.

## Verify (prove each run)

A loop may carry an optional `verify` check (set via `loop_create`'s `verify` param — same shape as /goal's `check`: `{tool?, matches, negate?}`). After each iteration, the check runs against that iteration's real tool-result content and the pass/fail verdict is stored on the run — shown as a chip on the run in the Loop Jobs panel, not just whatever your `final_text` claims.

- **Verify by independent read-back, not self-certification.** The check only sees actual tool-result content, never your prose. Run the real check — the same command/fetch/read the `matches` pattern is looking for — inside the iteration so its output lands in a tool result; don't just assert the outcome in `final_text` and hope it matches.
- `tool` (optional) scopes the check to one tool's output; omit to match any tool's result from the iteration.
- `matches` is a substring or `/regex/`; `negate: true` flips it to "must be absent" (e.g. proving an error string is gone).
- Prefer `verify` over eyeballing `final_text` for any loop with a machine-checkable outcome — it turns "I think it worked" into a stored, auditable pass/fail.

## time:dynamic protocol

Fenced JSON at the end of your output:

\`\`\`loop-meta
{ "next_delay_seconds": 240 }
\`\`\`

Range clamped to [60, 3600]. Missing/unparseable defaults to 300.

## Cancellation and failure

- Three consecutive iteration errors trip auto-cancel (state → `failed`).
- You can self-cancel via `loop.cancel({ loop_id: <your_loop_id_from_LOOP-CONTEXT> })`.
- You **may not** create new loops (`loop.create` is forbidden in iterations) or call `ask_user` (sidebar may be closed; nobody to answer).

## Writing self-provable conditions

When a loop exists to reach an end state ("until the deploy is green", "until the price drops"), phrase the stop condition the way the /goal evaluator demands: one measurable end state + a stated check whose output you actually surface. Run the check inside the iteration and write its result to the scratchpad — a future iteration (which remembers nothing else) must be able to decide "met, self-cancel" from the scratchpad alone. Never self-cancel on an assumption; only on observed check output.

## Token discipline

- Match the interval to the change rate of what you're watching. If nothing changed in the last N fires, prefer `time:dynamic` and back the delay off toward the 3600s cap.
- Prefer scripts over reasoning: a `bash` one-liner (agent mode) or a single `web_fetch` that emits a comparable value beats re-deriving state from prose every fire.
- Scratchpad over re-derivation: store the last-seen value/ID/cursor and diff against it; exit early ("no change") instead of re-analyzing from scratch.

## Safety warnings

- The user may not be watching when you fire. **Do not** take irreversible side-effects unless `allowed_tool_classes` was explicitly opened up.
- A force-cancel mid-iteration aborts in-flight tool calls but cannot undo network requests already dispatched.
