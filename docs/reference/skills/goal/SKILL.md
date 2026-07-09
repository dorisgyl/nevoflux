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

`goal_set` attaches a completion condition to this session. After **every** turn, an independent evaluator model — zero tools, one-shot, temperature 0 — reads the tail of the conversation and returns strict JSON `{"met": bool, "reason": "..."}`. If unmet and turns remain, the system automatically injects a continuation message and you keep working. You do not manage the loop; you just work and surface evidence.

The evaluator judges ONLY from evidence present in the conversation text: test output, command exit codes, file listings, explicit confirmations. Your CLAIM that you are done is not evidence.

## Writing conditions

A good condition has three parts, all in one string (≤ 4000 chars):

1. **One measurable end state** — not a vibe. "All unit tests pass", not "the code is good".
2. **A stated check** — name the command or observation that proves it: "as shown by `cargo test` exiting 0".
3. **Constraints / bounding clause** — "without modifying files under vendor/", "or stop after 10 turns".

**Critical: run the check so its output lands in the transcript.** The evaluator sees only conversation-surfaced evidence. If you fix the bug but never re-run the test in a turn, the condition can never be judged met. End work segments by executing the stated check and letting its raw output appear.

Good: `"The sidebar builds cleanly: 'cargo check --target wasm32-unknown-unknown' exits 0 with zero warnings, output shown in conversation. Or stop after 15 turns."`
Bad: `"Finish the refactor and make sure everything works."` (no check, no measurable state)

## Setting a goal — the flow

1. **Ask the user which model should evaluate.** Default: the current provider/model. The evaluator MUST be a direct-API provider (e.g. `anthropic`, `openai`, `gemini`) — ACP providers (`claude-code`, `gemini-cli`, `kimi`, `openclaw`) cannot evaluate and are rejected.
2. **Confirm max_turns** (default 20). This is the turn budget before the goal expires unmet.
3. Call `goal_set`.

## Tools

- `goal_set { condition, evaluator_provider?, evaluator_model?, max_turns? }` — set the session goal. `condition` required, ≤ 4000 chars, self-provable. `evaluator_provider`/`evaluator_model` default to the current provider/model (direct-API only). `max_turns` default 20. Returns the new goal's status JSON.
- `goal_status {}` — current goal status: `active` / `achieved` / `expired` / `cleared` / `none`, plus condition, turns_used/max_turns, the evaluator's last reason, and evaluator provider/model.
- `goal_clear {}` — clear the active goal and stop post-turn evaluation.

## What the continuation loop feels like

While the goal is active, each unmet verdict injects a `<GOAL-CONTINUATION>` block into your next turn: the condition, the evaluator's reason it is not yet met, and `Turn N/max`. Treat the reason as review feedback — it usually names the missing evidence. Do the work, then re-run the stated check so the evaluator can see it.

Terminal states: evaluator says met → `achieved` (stops immediately, even on the last turn); turn budget exhausted → `expired`; `goal_clear` → `cleared`. Evaluator transport errors are fail-safe: the turn is counted with an error reason but no continuation fires — the loop never runs away on a broken evaluator.

## Bounding

Always give the user an escape hatch. Prefer an explicit bounding clause inside the condition ("or stop after N turns") plus a sane `max_turns`. Tell the user they can say stop at any time — `goal_clear` ends it instantly.
