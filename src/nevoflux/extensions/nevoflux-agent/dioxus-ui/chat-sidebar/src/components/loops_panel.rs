/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Loop Jobs panel component for the `/loop` skill.
//!
//! Full-panel overlay (mirrors `jobs_panel.rs`) listing the current session's
//! live loops as cards: state, trigger, iteration/skip counts, prompt/skill,
//! scratchpad preview, and cancel. In the maximized (tab) form this is the sole
//! loop control surface — the sticky in-chat cards are hidden there
//! (`sticky_loop_card.rs`). Loops are session-scoped and event-only, so there
//! is no persisted history here (unlike the schedule Jobs panel).

use dioxus::prelude::*;
use wasm_bindgen_futures::spawn_local;

use crate::context::use_app_context;
use crate::messaging::send_loop_cancel;
use crate::state::LoopState;

/// Full-panel view listing the current session's live loops.
#[component]
pub fn LoopsPanel() -> Element {
    let ctx = use_app_context();

    if !*ctx.show_loops_panel.read() {
        return rsx! {};
    }

    let active_session_id = ctx.session.read().id.clone();
    let mut loops: Vec<LoopState> = ctx
        .loops
        .read()
        .values()
        .filter(|l| l.session_id == active_session_id && l.state != "cancelled")
        .cloned()
        .collect();
    // Newest first by iteration count, then loop_id for stability.
    loops.sort_by(|a, b| {
        b.iteration_count
            .cmp(&a.iteration_count)
            .then_with(|| a.loop_id.cmp(&b.loop_id))
    });

    rsx! {
        div {
            class: "jobs-panel",
            role: "dialog",
            aria_modal: "true",
            aria_label: "Loop jobs",

            LoopsPanelHeader {}

            div { class: "jobs-panel-list",
                if loops.is_empty() {
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
                    for state in loops.iter() {
                        LoopJobCard { key: "{state.loop_id}", state: state.clone() }
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

/// One loop rendered as a card.
#[component]
fn LoopJobCard(state: LoopState) -> Element {
    let session_id = state.session_id.clone();
    let loop_id = state.loop_id.clone();
    let run_suffix = if state.iteration_count == 1 { "" } else { "s" };
    let scratch_visible = state.scratchpad_bytes > 0;

    let on_cancel = move |_| {
        let s = session_id.clone();
        let l = loop_id.clone();
        spawn_local(async move {
            if let Err(e) = send_loop_cancel(&s, &l, false).await {
                tracing::warn!("loop cancel failed: {}", e);
            }
        });
    };

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

            div { class: "job-card-actions",
                button {
                    class: "job-action-btn job-action-danger-ghost",
                    onclick: on_cancel,
                    "Cancel"
                }
            }
        }
    }
}
