/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Sidebar state for the `/loop` skill.

use std::collections::VecDeque;

/// Per-loop sidebar state, populated from `system:loop:*` EventBus deliveries.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LoopState {
    pub loop_id: String,
    pub session_id: String,
    pub trigger_expr: String,
    pub prompt_text: Option<String>,
    pub wrapped_skill: Option<String>,
    pub state: String, // pending|running|idle|failed|cancelled
    pub iteration_count: i64,
    pub skipped_triggers: i64,
    pub scratchpad_preview: String,
    pub scratchpad_bytes: i64,
    /// Most recent first; capped at 20.
    pub iterations: VecDeque<IterationRow>,
    /// A pending `/loop evolve` self-improvement proposal awaiting a human
    /// accept/reject, if any. Set by `system:loop:proposal`, cleared by
    /// `system:loop:proposal_resolved`.
    pub pending_proposal: Option<LoopProposalUi>,
}

/// Sidebar-side view of a pending `/loop evolve` proposal, populated from
/// the `system:loop:proposal` EventBus delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopProposalUi {
    pub id: String,
    pub rationale: String,
    pub proposed_prompt_text: Option<String>,
    pub proposed_gate_spec: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IterationRow {
    pub sequence_number: i64,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub status: String, // running|ok|error
    pub fire_reason: String,
    pub tool_calls_summary: serde_json::Value,
    /// LLM's final text response for this iteration. Set on iteration_end;
    /// `None` while running or for error iterations. In-memory only — not
    /// persisted across sidebar reload.
    pub final_text: Option<String>,
    /// W5 §verify verdict for this iteration's programmatic check, if the
    /// loop has a `verify_check`. `None` when the loop has no verify_check,
    /// the iteration is still running, or the check failed to parse
    /// (fail-open — see `finalize_iteration_ok` in the daemon).
    pub verify_passed: Option<bool>,
    /// Human-readable reason paired with `verify_passed` (e.g. "check '...'
    /// passed"). `None` whenever `verify_passed` is `None`.
    pub verify_reason: Option<String>,
}

impl LoopState {
    pub fn push_or_update_iteration(&mut self, row: IterationRow) {
        if let Some(existing) = self
            .iterations
            .iter_mut()
            .find(|r| r.sequence_number == row.sequence_number)
        {
            *existing = row;
            return;
        }
        self.iterations.push_front(row);
        if self.iterations.len() > 20 {
            self.iterations.pop_back();
        }
    }
}
