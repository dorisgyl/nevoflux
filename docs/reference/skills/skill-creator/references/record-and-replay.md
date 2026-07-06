# Record & Replay (browser use)

This file is the detailed companion to the **Record & Replay** section in
`SKILL.md`. Read it when you are turning a browser recording into a flow
package (a deterministic replay script invoked via `run_flow`), or when you
need the trace schema, the `replay.py` writing rules, or the `run_flow`
result contract.

Scope today is **browser use only** — interactions inside web pages plus
navigation. Full computer use (OS-level windows, native apps) is out of scope;
do not author recorded skills against computer-use tools.

---

## Where the recording comes from

The user demonstrates a workflow by driving the browser themselves. A passive
recorder in the page actor observes their real interactions (it never blocks
them) and a daemon-side collector writes a normalized, ordered, lossless trace.

You drive the recording yourself from inside the skill-creator session, in
agent mode. `start_recording` (with a one-line `goal_hint`) arms the recorder on
the active tab and returns `{ recording_id, trace_path }`; you then tell the
user to demonstrate the workflow, and when they say they are done you call
`stop_recording` with the `recording_id`. `trace_path` is the **absolute path**
to the recording — a JSONL file at `{recording_id}.jsonl` — which you read
directly (no further path resolution needed).

Read the whole file with `read_file`. It is **NDJSON**: the first line is a
`header` record and every other line is a normalized `step`. **Sort the step
lines by `ts_ms`** before using them — order in the file is arrival order, which
is not guaranteed to be event order (see Trace schema). There is **no separate
`detected_inputs` record**; derive the candidate inputs yourself from the step
lines' `input_ref`. Treat the recording as the raw material for **Capture
Intent** — it is a demonstrated workflow, exactly the case the Capture Intent
step was written for.

---

## Trace schema

The file is **NDJSON**, not a single object. The first line is a `header`;
every other line is a `step`.

`header` (first line):

| Field | Meaning |
| --- | --- |
| `type` | `"header"` |
| `recording_id` | Stable id; also the filename and the skill's working handle |
| `created_at` | Epoch ms when recording started |
| `start_url` | Where the demonstration began |
| `goal_hint` | The user's own one-line description of the task |

Each `step` line:

| Field | Meaning |
| --- | --- |
| `i` | Step index |
| `action` | `navigate` \| `click` \| `fill` \| `select` \| `scroll` |
| `target` | Element descriptor (omitted for `navigate` / `scroll`) |
| `target.role` | Accessible role, e.g. `button`, `textbox` |
| `target.name` | Accessible name |
| `target.text` | Trimmed text content (≤200 chars) — optional; today the snapshot captures only `name` |
| `target.tag` | Lowercased tag name |
| `target.landmark` | Nearest landmark `role "name"` (e.g. `region "Billing"`) — used to disambiguate |
| `target.selectors[]` | **Ranked** locators `{type, strategy, value}` — durable first |
| `target.element_kind` | Present only for special cases: `select`, `file` |
| `value` | Observed value for `fill`; `null` if redacted |
| `redacted` | `true` when the value was a secret (password / token-shaped) |
| `input_ref` | Candidate placeholder like `{{email}}` if this value may vary |
| `url` / `title` | Page context when the step happened |
| `ts_ms` | **Event-time** timestamp — sort steps by this; file/arrival order ≠ event order |
| `wait_after` | `navigation` \| `interaction` \| `scroll` hint for inserting a wait |

There is **no `detected_inputs` record**. Build the candidate list yourself by
scanning the step lines — each candidate is
`{ ref: input_ref, from_step: i, sample: value, secret: redacted }`. These are
candidates only; the user confirms which are real (decision 2).

The `selectors[]` array is ranked by durability: `role` (a11y / aria) →
`aria-label` → `placeholder` → `label` → `testid` → stable `id` → CSS path →
last-resort attribute. **Prefer the top entries.** A bare CSS path is a
fallback, not a first choice.

> The recorder strips its ephemeral per-snapshot ids (`e0`, `e1`, …). They are
> never in the trace and must never end up in a skill — they are reassigned on
> every snapshot, so a skill that hardcodes one breaks on the next run.

---

## From recording to flow package

This is Capture Intent, specialized for a recording. The output is NOT
natural-language replay steps — it is a **flow package**: a deterministic
Monty python script plus a manifest, invoked at use time through the
`run_flow` tool with LLM-extracted parameters.

1. **Read the trace.** Summarize the workflow back to the user in plain
   language from `goal_hint` + the step sequence, so they can confirm you
   understood the demonstration.

2. **Confirm the variables.** The recorder only *guesses* which values vary
   (the `input_ref` on step lines). You decide nothing on its behalf — present
   the candidates and let the user confirm which are real inputs and which are
   fixed. A value typed once is not automatically a parameter; a fixed login
   URL often is not. Secrets (`redacted: true`) become required params marked
   `x-secret: true` in the manifest — never baked into the script or manifest.

3. **Write the flow package** inside the skill directory:

   ```text
   <skill>/flows/<flow_name>/
     replay.py      -- Monty script defining run(params)
     flow.json      -- manifest (see below)
     trace.jsonl    -- copy of the recording, kept for regeneration
   ```

   `flow.json`:

   ```json
   {
     "name": "jira_ticket",
     "description": "Create a Jira ticket (recorded flow)",
     "version": 1,
     "recording_id": "<from the trace header>",
     "params_schema": {
       "type": "object",
       "properties": {
         "project": { "type": "string", "description": "Jira project key" },
         "title":   { "type": "string", "description": "ticket title" },
         "api_token": { "type": "string", "x-secret": true }
       },
       "required": ["project", "title", "api_token"]
     }
   }
   ```

   The flow `name` must be unique across the user's flows — prefix with the
   skill name when in doubt.

4. **Write the thin SKILL.md.** The skill body no longer contains replay
   steps. It states when to use the flow, what each param means, and the one
   call to make:

   ```markdown
   Extract `project` and `title` from the user's request, ask for `api_token`
   if not provided, then call:
   run_flow("jira_ticket", {"project": ..., "title": ..., "api_token": ...})
   Follow the result's `instruction` field if the script fails.
   ```

5. **Verify before saving.** Run the flow once for real via `run_flow` with
   sample params and check the concrete end state (URL reached, confirmation
   text present). A flow package that has never replayed successfully is not
   done.

---

## Writing replay.py

The script runs in the Monty sandbox with the browser tools bound as global
functions — the same runtime as the headless fixed-script mode. Follow the
conventions of `deploy/headless/examples/fixed-flow-advanced.py`, plus these
flow-specific rules:

- **Entry point is `run(params)`** where `params` is a dict already validated
  against `params_schema`. Never `run(task)`.
- **Monty syntax limits:** def / if / for / while / try-except /
  comprehensions / f-strings / lambda are fine; `import json/re/time` is
  auto-handled. NOT supported: class, match/case, with, async/await, yield,
  decorators, map()/filter(), sorted(key=).
- **Tool errors are envelopes, not exceptions:** check results with
  `isinstance(r, dict) and r.get("__tool_error")`.
- **Thread `tab_id`:** `browser_navigate` opens a NEW, INACTIVE tab and
  returns `{"tab_id": N}`. Pass that id into every later call.
- **Inline the selector ladder.** The trace's `selectors[]` is ranked by
  durability (role → aria-label → placeholder → label → testid → stable id →
  CSS path). Carry the top candidates into the script and try them in order —
  never a single hardcoded CSS path:

  ```python
  def _first_match(candidates, tab):
      for sel in candidates:
          r = browser_wait_for(selector=sel, tab_id=tab, timeout_ms=3000)
          if not (isinstance(r, dict) and r.get("__tool_error")):
              return sel
      return None
  ```

  If even the durable selectors cannot uniquely identify the recorded element
  (many "Delete" rows, several "Search" boxes), **flag it to the user** during
  Capture Intent rather than baking a fragile ordinal.
- **Text input:** `browser_input(selector=..., text=..., mode="fill",
  verify=True, tab_id=...)`. `browser_fill` / `browser_type` are deprecated
  (2026-04) and silently no-op on many editors — never generate them.
- **Native `<select>`:** click to open, then click the option by recorded
  text — `browser_input` only handles input / textarea / contentEditable.
  **File inputs:** `browser_upload_file` only; the local path is always a
  param, never recorded. **Submit:** author an explicit `browser_click` on
  the submit control — filling does not submit on generic pages. A page that
  submits *only* on raw Enter with no clickable control is a genuine gap —
  flag it to the user rather than guessing.
- **Waits:** insert `browser_wait_for` wherever the trace marked
  `wait_after` (navigation / interaction settling). This is what keeps the
  script from racing ahead of the page.
- **Never let an exception escape, and never return a bare string on
  failure.** On any failed step, return the handoff envelope so the calling
  LLM can take over at the exact failure point:

  ```python
  return {
      "ok": False,
      "failed_step": 3,
      "step_label": "click the submit button",
      "selectors_tried": ["button[aria-label=Submit]", "form .submit"],
      "url": current_url,
      "tab_id": tab,
      "error": "no selector matched",
  }
  ```

  On success, return `{"ok": True, ...}` with whatever end-state data the
  skill promised (confirmation URL, created record id, extracted text).
- **No secrets and no ephemeral snapshot ids** (`e0`, `e1`, …) anywhere in
  the script.

---

## The run_flow contract

At use time the calling agent does exactly this:

1. Extract params from the user's request per the thin SKILL.md.
2. `run_flow(name, params)`. Four result shapes:
   - **success** — the script's `{"ok": true, ...}` dict, passed through.
   - **`status: invalid_params`** — fix params against the returned
     `params_schema` and retry.
   - **`status: script_failed`** — the script hit a broken step and returned
     its handoff; the browser is still at the failure state.
   - **`status: script_error`** — the script itself crashed (Monty error).
3. On either failure shape, follow the result's `instruction`: relocate the
   failed element live (durable selectors first, then `browser_find_elements`
   with role+name, narrowing by text / landmark — the same relocate ladder
   recorded skills always used), finish the remaining steps with browser
   tools, and then call `report_flow_repair(flow, failed_step, suggestion)`
   with what worked.
4. `list_flows()` exists as a fallback discovery path when the skill text is
   not in context.

Repair suggestions land in the flow package's `repairs.jsonl`. On a later
skill-creator session, check each flow package for pending repairs, show them
to the user, and update `replay.py` only with their approval — bump
`version` in `flow.json` when you do. No silent self-healing.

---

## allowed_tools and replay mode

In the generated skill's frontmatter, declare the browser tools it needs in
`allowed_tools` so the skill is only injected when those tools are present. A
recorded skill is useless in a text-only run.

**`allowed_tools` must be a YAML sequence, not a bare scalar.** Write the list
form — a bare string like `allowed_tools: browser_*` is the most common
generation mistake (it parsed as a string and the whole skill was silently
dropped at load time):

```yaml
allowed_tools:
  - run_flow
  - report_flow_repair
  - browser_*
```

(`browser_*` is still required — the LLM fallback takes over with browser
tools when the script fails.)

The same applies to `tags`, `dependencies`, and `triggers` — always lists.

Remember the mode is fixed when a run starts — the tool catalog comes from
`get_tools_for_mode` at launch and cannot be escalated mid-run. So replay (and
the eval runs that test it) must **start** in a mode that already includes the
browser tools, not switch into one partway through.

---

## Test the replay

Use the normal eval loop from `SKILL.md`. The only specialization:

- Spawn the with-skill and baseline subagents in a mode that carries the
  browser tools **and `run_flow`** (browser or agent mode), since replay needs
  them from the first turn.
- Good assertions for recorded skills are concrete end-states: the expected URL
  was reached, the confirmation text appeared, the record was created. Prefer
  checking the *outcome* of the workflow over asserting that a particular
  selector was used — the whole point is that the agent may take a slightly
  different path to the same result.
- Realistic inputs, no secrets, short complete demonstrations. The same advice
  you give users about recording applies to the test prompts you write.

Cases every flow package should pass before it ships:

1. **Normal replay** — valid params → the script succeeds → the expected end
   state is reached.
2. **Param validation** — a missing required param → `status: invalid_params`
   → the agent fixes the params and retries successfully.
3. **Broken selector** — deliberately corrupt one selector in a scratch copy
   of the script → `status: script_failed` handoff → the agent finishes the
   workflow live → a record appears in `repairs.jsonl`.
4. **No plaintext secrets** — grep the script and manifest: `x-secret` params
   never appear as literal values anywhere in the package.
