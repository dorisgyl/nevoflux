---
name: goal
description: Keep working across turns until a self-provable completion condition holds, judged by an independent zero-tool evaluator model.
---

# /goal

## When NOT to use this

- Recurring or wall-clock work ("every morning at 9", "weekly digest") → `schedule_create` (/schedule skill).
- Minute-level polling or event/DOM reactions while the session is alive ("check every 2 minutes") → `loop_create` (/loop skill).
- /goal is for ONE task in the CURRENT session that should keep going, turn after turn, until a provable end state holds.

## How it works

`goal_set` attaches a completion condition to this session. After **every** turn, completion is decided one of two ways: (a) if the goal has a programmatic `check`, it is evaluated in pure code over your recent tool results — no model involved; or (b) otherwise an independent evaluator model — zero tools, one-shot, temperature 0 — reads the tail of the conversation and returns strict JSON `{"met": bool, "reason": "..."}`. If unmet and turns remain, the system automatically injects a continuation message and you keep working. You do not manage the loop; you just work and surface evidence.

The evaluator (and the `check`) judge ONLY from evidence present in the conversation: test output, command exit codes, file listings, tool results, explicit confirmations. Your CLAIM that you are done is not evidence. Tool results are surfaced to the evaluator verbatim, so an independent read-back tool's raw output counts as evidence.

## Writing conditions

A good condition has three parts, all in one string (≤ 4000 chars):

1. **One measurable end state** — not a vibe. "All unit tests pass", not "the code is good".
2. **A stated check** — name the command or observation that proves it: "as shown by `cargo test` exiting 0".
3. **Constraints / bounding clause** — "without modifying files under vendor/", "or stop after 10 turns".

**Critical: run the check so its output lands in the transcript.** The evaluator sees only conversation-surfaced evidence. If you fix the bug but never re-run the test in a turn, the condition can never be judged met. End work segments by executing the stated check and letting its raw output appear.

Good: `"The sidebar builds cleanly: 'cargo check --target wasm32-unknown-unknown' exits 0 with zero warnings, output shown in conversation. Or stop after 15 turns."`
Bad: `"Finish the refactor and make sure everything works."` (no check, no measurable state)

### Verify by independent read-back, not by the mutating tool's word

The check must be a **separate observation** that reads the real state — never the "success" text the mutating tool returned (that is easy to hallucinate or is just an echo). Split *mutate* from *verify*:

- wrote to the knowledge base → verify by **querying** it back (`brain_search`/knowledge query returns the entry)
- wrote a file → verify by `read`/`grep`
- deployed → verify by `curl`-ing the health endpoint
- built a Canvas app → verify by running it (`canvas_eval` reads the live value)

Tool results are now surfaced to the evaluator verbatim, so the read-back tool's raw output *is* the evidence — you don't have to (and shouldn't) retype it.

### Prefer a programmatic `check` when the goal is machine-verifiable

`goal_set` takes an optional `check` that is evaluated over recent tool results in pure code — **if it holds the goal is met with NO evaluator model at all**. Use it whenever completion is a concrete string/value: an exit code, a read-back value, a non-empty query.

```
goal_set {
  condition: "the calculator computes 3*5 = 15",
  check: { tool: "canvas_eval", matches: "15" }
}
```

`check` fields: `tool?` (only inspect this tool's recent result; omit = any tool), `matches` (substring, or `/regex/` when slash-wrapped), `negate?` (require the pattern ABSENT). A `check` makes `/goal` work with **no API key and even with only ACP providers** — it needs no judge model. Keep the natural-language `condition` too (it documents intent and is the fallback when there is a model judge).

## Setting a goal — the flow

1. **Decide how completion is judged.** If the goal is machine-verifiable, add a programmatic `check` (see above) — then no evaluator model is needed and you can skip the model question entirely. Otherwise (subjective goal) ask the user which **model** should evaluate. Prefer a direct-API provider (e.g. `anthropic`, `openai`, `gemini`) — reproducible, one-shot, temperature 0. An ACP provider (`claude-code`, `gemini-cli`, `kimi`, `openclaw`) can now also act as a judge (one-shot over a connected session) but is **degraded** (no temperature control, subprocess cost) — use it only when no direct-API key is available. **When the goal is machine-verifiable, a `check` beats any model judge** (cheaper, deterministic, works with no API/ACP-only).
2. **Confirm max_turns** (default 20). This is the **turn budget** — how many total conversation turns the loop may run — **not a "retry count"**. A multi-step task (build → run → verify → fix, repeated) needs enough turns to cover `steps × rounds + slack`; give ≥ 10 for anything non-trivial. Do NOT copy a user's casual "at most 3 tries" into `max_turns=3` — that budgets the whole loop, and 3 turns rarely reaches even the first verification.
3. **Call `goal_set` — mandatory, not optional.** The user's confirmation reply (a model name, "yes", etc.) only tells you what parameters to pass. It does not activate anything by itself. Nothing runs the post-turn evaluation loop until `goal_set` has actually executed as a tool call.
4. **Immediately call `goal_status` to self-verify before doing ANY task work.** Confirm the response shows `"status": "active"`. Only then proceed to `skill_load`, `create_artifact`, browser actions, etc.

**Do not jump from "user confirmed parameters" straight into task execution.** That skips step 3 entirely: the turn just does the work and ends normally, `after_turn` finds no active goal, and silently no-ops — no evaluation, no `<GOAL-CONTINUATION>`, no further rounds. From the user's side this looks identical to the goal working and simply finishing after one turn, except nothing was ever checked. The step-4 self-check is what catches this before multiple turns of unsupervised work happen on a goal that was never actually set.

## Tools

- `goal_set { condition, check?, evaluator_provider?, evaluator_model?, max_turns? }` — set the session goal. `condition` required, ≤ 4000 chars, self-provable. `check?` = `{ tool?, matches, negate? }` programmatic check over recent tool results (met without any model when it holds — works with no API/ACP-only). `evaluator_provider`/`evaluator_model` default to the current provider/model (direct-API only); ignored when a `check` completes the goal first. `max_turns` default 20 (turn budget, not retries). Returns the new goal's status JSON.
- `goal_status {}` — current goal status: `active` / `achieved` / `expired` / `cleared` / `none`, plus condition, turns_used/max_turns, the evaluator's last reason, and evaluator provider/model.
- `goal_clear {}` — clear the active goal and stop post-turn evaluation.

## What the continuation loop feels like

While the goal is active, each unmet verdict injects a `<GOAL-CONTINUATION>` block into your next turn: the condition, the evaluator's reason it is not yet met, a **`Recent actions`** list (auto-derived from your last tool results), and `Turn N/max`. Treat the reason as review feedback — it usually names the missing evidence. Do the work, then re-run the stated check so the evaluator can see it.

**A continuation is a RESUME, not a RESTART.** The `Recent actions` list tells you what already happened — do **not** redo a completed step. If a prior turn already created the artifact / wrote the file / ran the build, advance to the next unmet step (verify, or fix-then-verify) instead of doing it again from scratch. Re-creating the same thing every turn burns the whole turn budget without ever reaching verification — the classic way a goal "runs but never finishes". Note also that some tools **end the turn immediately** (`create_artifact`, plan proposals); if setting up the goal or your first action involves one of those, call `goal_set` **first** (ideally in its own turn) so the loop is armed before the turn ends.

Terminal states: evaluator says met → `achieved` (stops immediately, even on the last turn); turn budget exhausted → `expired`; `goal_clear` → `cleared`. Evaluator transport errors are fail-safe: the turn is counted with an error reason but no continuation fires — the loop never runs away on a broken evaluator.

## Bounding

Always give the user an escape hatch. Prefer an explicit bounding clause inside the condition ("or stop after N turns") plus a sane `max_turns`. Tell the user they can say stop at any time — `goal_clear` ends it instantly.
