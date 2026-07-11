---
name: schedule
description: Create routines-style background jobs on a cron or one-off timestamp; they run even with the sidebar closed and appear in the Jobs panel.
---

# /schedule

## When NOT to use this

- Sub-hourly cadence ("every 5 minutes", "poll this page") → `loop_create` (/loop skill); `schedule_create` rejects anything finer than 1 hour.
- A condition-driven single task in the current session ("keep going until tests pass") → `goal_set` (/goal skill).
- /schedule is for wall-clock jobs — cron or a one-off timestamp — that must fire in the background, sidebar open or not.

## Before calling schedule_create

Always confirm with the user: the schedule's **name** and a **human-readable cadence** ("every day at 9am"). Then call.

## schedule_create arguments

`schedule_create { name, cron | at, prompt_text | wrapped_skill, mode?, browser?, on_unavailable?, headless_profile?, catch_up?, goal_condition?, goal_max_turns?, max_tokens_per_run?, evaluator_provider?, evaluator_model? }`

- `name` (required) — short human-readable name.
- `cron` — 5-field cron expression, e.g. `"0 9 * * *"`. XOR with `at`. Minimum 1 hour between fires; finer → creation error → use /loop.
- `at` — one-off fire time: RFC3339 with offset (`"2026-07-15T18:00:00+08:00"`) or unix seconds. XOR with `cron`.
- `prompt_text` — raw prompt re-issued each fire. XOR with `wrapped_skill`.
- `wrapped_skill` — JSON-stringified `{name, args}` blob (call JSON.stringify first). XOR with `prompt_text`.
- `mode` — `chat` | `browser` | `agent`. Agent mode for the run. Default `chat`.
- `browser` — `none` | `live` | `headless`. Default `none`. See browser policy below.
- `on_unavailable` — `defer` | `skip`. What to do if the required browser isn't available at fire time. Default `defer`: the run is parked and fires once, coalesced, when a browser reappears. `skip`: the run is recorded as skipped. Neither counts as a failure.
- `headless_profile` — named headless browser profile to use.
- `catch_up` — boolean, default false. Fire once on next boot if the daemon was offline at the scheduled time.
- `goal_condition` — natural-language success condition (max 4000 chars); when set, each fire runs a goal loop that re-evaluates after every turn until met or budget/turns run out.
- `goal_max_turns` — max turns for a goal-enabled run. Default 20.
- `max_tokens_per_run` — token budget per run (plain and goal-enabled runs; goal turns + evaluator calls both count against it).
- `evaluator_provider` / `evaluator_model` — provider/model used to evaluate `goal_condition`. Default: the current provider/model. Most providers (any direct-API one, plus kimi-agent) judge in one zero-tool call; the streaming-only ACP providers (claude-code, gemini-cli, openclaw) judge in a degraded one-shot mode.

## Browser policy

- `none` (default) — no browser needed. Right for pure-LLM work and API calls.
- `headless` — recommended for web tasks and anything needing login state. Launches a throwaway browser from a cloned base profile; `headless_profile` names which base profile to clone (default `"default"`, from `~/.config/nevoflux/base-profiles/` — clones carry cookies, i.e. login state).
- `live` (+ `on_unavailable: "defer"`) — only when the run needs the user's own CURRENT window/tab state; it borrows their visible browser. If no browser is attached at fire time, `defer` parks the run until one appears.

## Worked examples

Daily 9am web report (needs login state, runs unattended):

```json
schedule_create {
  "name": "morning HN digest",
  "cron": "0 9 * * *",
  "prompt_text": "Open news.ycombinator.com, collect the top 10 stories, and write a 5-bullet digest with links.",
  "mode": "browser",
  "browser": "headless",
  "headless_profile": "default"
}
```

Weekday API pull (no browser at all):

```json
schedule_create {
  "name": "weekday metrics pull",
  "cron": "0 8 * * 1-5",
  "prompt_text": "Fetch https://api.example.com/v1/metrics/daily with web_fetch and summarize deltas vs yesterday in 3 lines.",
  "mode": "chat",
  "browser": "none"
}
```

One-off cleanup reminder (fires once, survives a daemon restart):

```json
schedule_create {
  "name": "clear stale downloads reminder",
  "at": "2026-07-15T18:00:00+08:00",
  "prompt_text": "Remind the user to clear ~/Downloads of files older than 30 days; list the 10 largest candidates.",
  "catch_up": true
}
```

## The proactive-loop pattern (goal_condition + max_tokens_per_run)

Compose a schedule with a goal to get "keep working each fire until done, within budget":

```json
schedule_create {
  "name": "nightly flaky-test hunt",
  "cron": "0 2 * * *",
  "prompt_text": "Run the unit test suite three times; identify any test that does not fail identically across runs.",
  "mode": "agent",
  "goal_condition": "Three full suite runs are shown in conversation output and a verdict is stated: either 'no flaky tests' or a named list of flaky tests with their differing outputs.",
  "goal_max_turns": 10,
  "max_tokens_per_run": 200000
}
```

Each fire re-evaluates the condition after every turn (zero-tool evaluator — direct-API, or ACP in degraded one-shot mode) and stops at met / turns / token budget — whichever comes first.

## Timing semantics — stated plainly

**Schedules fire only while the daemon runs.** There is no OS-level timer; a fire scheduled while the daemon is down does not happen.

- Recurring + `catch_up: true` — a missed fire is recorded as missed, one catch-up run fires on next boot, then the cron rearms normally.
- Recurring + `catch_up: false` (default) — the missed fire is recorded as missed and skipped; next cron occurrence proceeds.
- One-off + `catch_up: true` — fires once on next boot, then retires.
- One-off + `catch_up: false` — the moment is gone; the miss is recorded and the schedule retires without executing.

## Management

- `schedule_list {}` — all schedules, any status (active, paused, ran, cancelled).
- `schedule_pause { schedule_id }` — stop firing until resumed.
- `schedule_resume { schedule_id }` — resume; next fire recomputed from now.
- `schedule_run_now { schedule_id }` — fire immediately, out of band, without disturbing the cadence.
- `schedule_cancel { schedule_id }` — permanent, terminal.
- `schedule_runs { schedule_id, limit? }` — recent run history (status, timing, errors — not full output text). `limit` default 20, max 100.

The user sees the same jobs in the sidebar **Jobs panel** (calendar icon in the sidebar header): one card per job with cadence, status and last-run badge, pause/resume, run-now, cancel, and run history. Point them there for manual control.
