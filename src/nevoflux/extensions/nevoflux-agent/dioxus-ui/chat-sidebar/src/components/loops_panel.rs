/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Loop Jobs panel component for the `/loop` skill.
//!
//! Full-panel overlay (mirrors `jobs_panel.rs`) for the current session's loops.
//! Active loops (`pending`/`running`/`idle`) list on top; terminal loops
//! (`cancelled`/`failed`) collect in a collapsible **Completed** section so a
//! finished loop leaves a record instead of vanishing. Each card has a
//! **View details** toggle that renders that loop's iteration cards inline in
//! the panel (from `LoopState.iterations`).
//!
//! In the maximized (tab) form this is the sole loop surface — the sticky
//! in-chat cards and the inline iteration cards are hidden there
//! (`sticky_loop_card.rs`, `message_list.rs`). Loops are session-scoped and
//! event-only, so completed records are in-memory and survive only until the
//! sidebar reloads (no persisted history).

use dioxus::prelude::*;
use wasm_bindgen_futures::spawn_local;

use crate::components::loop_ui::IterationCard;
use crate::context::use_app_context;
use crate::messaging::send_loop_cancel;
use crate::state::LoopState;

/// True when a loop has reached a terminal state and belongs in Completed.
fn is_terminal(state: &str) -> bool {
    state == "cancelled" || state == "failed"
}

/// Full-panel view listing the current session's loops.
#[component]
pub fn LoopsPanel() -> Element {
    let ctx = use_app_context();

    if !*ctx.show_loops_panel.read() {
        return rsx! {};
    }

    let active_session_id = ctx.session.read().id.clone();

    // Active loops: non-terminal, newest activity first.
    let mut active: Vec<LoopState> = ctx
        .loops
        .read()
        .values()
        .filter(|l| l.session_id == active_session_id && !is_terminal(&l.state))
        .cloned()
        .collect();
    active.sort_by(|a, b| {
        b.iteration_count
            .cmp(&a.iteration_count)
            .then_with(|| a.loop_id.cmp(&b.loop_id))
    });

    // Completed loops: terminal, most-recent first, capped at 20.
    let mut completed: Vec<LoopState> = ctx
        .loops
        .read()
        .values()
        .filter(|l| l.session_id == active_session_id && is_terminal(&l.state))
        .cloned()
        .collect();
    completed.sort_by(|a, b| {
        b.iteration_count
            .cmp(&a.iteration_count)
            .then_with(|| a.loop_id.cmp(&b.loop_id))
    });
    completed.truncate(20);

    rsx! {
        div {
            class: "jobs-panel",
            role: "dialog",
            aria_modal: "true",
            aria_label: "Loop jobs",

            LoopsPanelHeader {}

            div { class: "jobs-panel-list",
                if active.is_empty() && completed.is_empty() {
                    div { class: "jobs-panel-empty",
                        svg {
                            width: "48",
                            height: "48",
                            view_box: "0 0 24 24",
                            fill: "none",
                            stroke: "currentColor",
                            stroke_width: "1.5",
                            stroke_linecap: "round",
                            stroke_linejoin: "round",
                            polyline { points: "17 1 21 5 17 9" }
                            path { d: "M3 11V9a4 4 0 0 1 4-4h14" }
                            polyline { points: "7 23 3 19 7 15" }
                            path { d: "M21 13v2a4 4 0 0 1-4 4H3" }
                        }
                        p { "No active loops." }
                        p { class: "jobs-empty-hint", "Start one with /loop." }
                    }
                } else {
                    for state in active.iter() {
                        LoopJobCard { key: "{state.loop_id}", state: state.clone() }
                    }
                    if !completed.is_empty() {
                        LoopCompletedSection { loops: completed.clone() }
                    }
                }
            }
        }
    }
}

/// Header bar: back + title.
#[component]
fn LoopsPanelHeader() -> Element {
    let mut ctx = use_app_context();

    let handle_back = move |_| {
        ctx.show_loops_panel.set(false);
    };

    rsx! {
        header { class: "jobs-panel-header",
            button {
                class: "jobs-back-btn",
                onclick: handle_back,
                aria_label: "Back to chat",
                svg {
                    width: "20",
                    height: "20",
                    view_box: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    stroke_width: "2",
                    stroke_linecap: "round",
                    stroke_linejoin: "round",
                    path { d: "M19 12H5" }
                    path { d: "M12 19l-7-7 7-7" }
                }
            }

            h2 { class: "jobs-panel-title", "Loop Jobs" }
        }
    }
}

/// Collapsible "Completed" section holding terminal (`cancelled`/`failed`) loops.
#[component]
fn LoopCompletedSection(loops: Vec<LoopState>) -> Element {
    let mut expanded = use_signal(|| false);
    let is_expanded = *expanded.read();
    let count = loops.len();
    let caret_class = if is_expanded {
        "jobs-completed-caret open"
    } else {
        "jobs-completed-caret"
    };
    let toggle = move |_| {
        let cur = *expanded.read();
        expanded.set(!cur);
    };

    rsx! {
        div { class: "jobs-completed-section",
            button {
                class: "jobs-completed-toggle",
                onclick: toggle,
                aria_expanded: "{is_expanded}",
                span { class: "{caret_class}", "▸" }
                span { "Completed ({count})" }
            }
            if is_expanded {
                for state in loops.iter() {
                    LoopJobCard { key: "{state.loop_id}", state: state.clone() }
                }
            }
        }
    }
}

/// One loop rendered as a card, with a View-details toggle that reveals its
/// iteration cards.
#[component]
fn LoopJobCard(state: LoopState) -> Element {
    let session_id = state.session_id.clone();
    let loop_id = state.loop_id.clone();
    let terminal = is_terminal(&state.state);
    let run_suffix = if state.iteration_count == 1 { "" } else { "s" };
    let scratch_visible = state.scratchpad_bytes > 0;

    let mut show_details = use_signal(|| false);
    let is_showing = *show_details.read();
    let toggle_details = move |_| {
        let cur = *show_details.read();
        show_details.set(!cur);
    };

    // Iterations are stored most-recent first; reverse to oldest-first so they
    // read top-to-bottom, matching the former in-chat order.
    let mut iter_rows: Vec<crate::state::IterationRow> = state.iterations.iter().cloned().collect();
    iter_rows.reverse();
    let has_iters = !iter_rows.is_empty();
    let details_label = if has_iters {
        format!("View details ({} iter{})", iter_rows.len(), if iter_rows.len() == 1 { "" } else { "s" })
    } else {
        "View details".to_string()
    };

    let on_cancel = move |_| {
        let s = session_id.clone();
        let l = loop_id.clone();
        spawn_local(async move {
            if let Err(e) = send_loop_cancel(&s, &l, false).await {
                tracing::warn!("loop cancel failed: {}", e);
            }
        });
    };

    let card_loop_id = state.loop_id.clone();

    rsx! {
        div { class: "job-card",
            div { class: "job-card-header",
                span { class: "job-card-name", "Loop" }
                span { class: "job-status-chip status-{state.state}", "{state.state}" }
            }

            div { class: "job-card-cadence", "{state.trigger_expr}" }

            div { class: "job-card-badges",
                span { class: "job-run-count",
                    "{state.iteration_count} iter{run_suffix}"
                }
                if state.skipped_triggers > 0 {
                    span { class: "job-run-count", "skipped {state.skipped_triggers}" }
                }
            }

            if let Some(skill) = state.wrapped_skill.as_deref() {
                div { class: "loop-wrapped-skill", title: "{skill}", "/{skill}" }
            } else if let Some(prompt) = state.prompt_text.as_deref() {
                div { class: "loop-prompt", title: "{prompt}", "{prompt}" }
            }

            if scratch_visible {
                div { class: "loop-scratchpad-preview",
                    "scratch ({state.scratchpad_bytes}b): {state.scratchpad_preview}"
                }
            }

            // Terminal loops are done — no cancel; active loops keep it.
            if !terminal {
                div { class: "job-card-actions",
                    button {
                        class: "job-action-btn job-action-danger-ghost",
                        onclick: on_cancel,
                        "Cancel"
                    }
                }
            }

            button {
                class: "job-history-toggle",
                onclick: toggle_details,
                {if is_showing { "Hide details".to_string() } else { details_label.clone() }}
            }
            if is_showing {
                div { class: "loop-iter-details",
                    if has_iters {
                        for row in iter_rows.iter() {
                            IterationCard {
                                key: "{card_loop_id}-{row.sequence_number}",
                                loop_id: card_loop_id.clone(),
                                row: row.clone(),
                            }
                        }
                    } else {
                        div { class: "job-history-empty", "No iterations yet." }
                    }
                }
            }
        }
    }
}
