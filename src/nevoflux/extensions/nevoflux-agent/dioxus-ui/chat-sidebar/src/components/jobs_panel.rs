/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Jobs panel component for the `/schedule` skill.
//!
//! Full-panel overlay (cloned from `history_panel.rs`) listing all scheduled
//! background jobs as cards: cadence, status + last-run badge, pause/resume,
//! run-now, cancel (two-click inline confirm), and lazily-fetched run history.
//! Mounted alongside `HistoryPanel` inside `.chat-content`, so it overlays the
//! message area in both the sidebar and maximized forms.

use dioxus::prelude::*;
use wasm_bindgen_futures::spawn_local;

use crate::context::{use_app_context, AppContext};
use crate::state::ScheduleJobState;
use crate::utils::format_unix_datetime;

/// Replace `ctx.schedule_jobs` with the authoritative `schedule.list` result,
/// preserving in-flight `running` flags (which the list payload never carries).
fn reconcile_schedule_jobs(mut ctx: AppContext, incoming: Vec<ScheduleJobState>) {
    let mut map = ctx.schedule_jobs.write();
    let running_ids: std::collections::HashSet<String> = map
        .values()
        .filter(|j| j.running)
        .map(|j| j.schedule_id.clone())
        .collect();
    map.clear();
    for mut job in incoming {
        // `schedule.list` returns ALL statuses, including terminal ones
        // (`cancelled`/`ran`). Terminal schedules must never re-enter the live
        // map: the panel filters them out, and — crucially — a cancelled row
        // whose `last_run_status` is still `error` would otherwise re-poison
        // the header/left-menu failed badge forever. Skip them here.
        if job.status == "cancelled" || job.status == "ran" {
            continue;
        }
        if running_ids.contains(&job.schedule_id) {
            job.running = true;
        }
        map.insert(job.schedule_id.clone(), job);
    }
}

/// Human cadence line for a job card.
fn cadence_line(job: &ScheduleJobState) -> String {
    if let Some(cron) = job.cron.as_deref() {
        match job.next_fire_at {
            Some(ts) => format!("{} · next {}", cron, format_unix_datetime(ts)),
            None => format!("{} · not scheduled", cron),
        }
    } else if let Some(at) = job.at {
        format!("Once at {}", format_unix_datetime(at))
    } else if let Some(ts) = job.next_fire_at {
        format!("Next {}", format_unix_datetime(ts))
    } else {
        "No upcoming run".to_string()
    }
}

/// Last-run badge (CSS class, glyph + label) derived from the live `running`
/// flag and `last_run_status`.
fn run_status_badge(job: &ScheduleJobState) -> (&'static str, String) {
    if job.running {
        return ("badge-running", "▶ running".to_string());
    }
    match job.last_run_status.as_deref() {
        Some("ok") => ("badge-ok", "✓ ok".to_string()),
        Some("error") => ("badge-error", "✗ error".to_string()),
        Some("missed") => ("badge-missed", "⚠ missed".to_string()),
        Some(other) if !other.is_empty() => ("badge-neutral", other.to_string()),
        _ => ("badge-neutral", "— never run".to_string()),
    }
}

/// Full-panel view listing all scheduled jobs.
#[component]
pub fn JobsPanel() -> Element {
    let ctx = use_app_context();

    // Fetch the authoritative list whenever the panel becomes visible. Sticky
    // events alone can leave map entries without name/cron, so a full
    // `schedule.list` on open guarantees complete cards.
    use_effect(move || {
        if *ctx.show_jobs_panel.read() {
            spawn_local(async move {
                match crate::messaging::schedule_list().await {
                    Ok(jobs) => reconcile_schedule_jobs(ctx, jobs),
                    Err(e) => tracing::warn!("schedule.list on open failed: {}", e),
                }
            });
        }
    });

    if !*ctx.show_jobs_panel.read() {
        return rsx! {};
    }

    let mut jobs: Vec<ScheduleJobState> = ctx
        .schedule_jobs
        .read()
        .values()
        .filter(|j| j.status != "cancelled")
        .cloned()
        .collect();
    // Soonest fire first, then name for stability.
    jobs.sort_by(|a, b| {
        a.next_fire_at
            .unwrap_or(i64::MAX)
            .cmp(&b.next_fire_at.unwrap_or(i64::MAX))
            .then_with(|| a.name.cmp(&b.name))
    });

    rsx! {
        div {
            class: "jobs-panel",
            role: "dialog",
            aria_modal: "true",
            aria_label: "Scheduled jobs",

            JobsPanelHeader {}

            div { class: "jobs-panel-list",
                if jobs.is_empty() {
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
                            rect { x: "3", y: "4", width: "18", height: "18", rx: "2" }
                            line { x1: "16", y1: "2", x2: "16", y2: "6" }
                            line { x1: "8", y1: "2", x2: "8", y2: "6" }
                            line { x1: "3", y1: "10", x2: "21", y2: "10" }
                        }
                        p { "No scheduled jobs." }
                        p { class: "jobs-empty-hint", "Ask the agent to schedule one." }
                    }
                } else {
                    for job in jobs.iter() {
                        JobCard { key: "{job.schedule_id}", job: job.clone() }
                    }
                }
            }
        }
    }
}

/// Header bar: back, title, refresh.
#[component]
fn JobsPanelHeader() -> Element {
    let mut ctx = use_app_context();
    let mut refreshing = use_signal(|| false);

    let handle_back = move |_| {
        ctx.show_jobs_panel.set(false);
    };

    let handle_refresh = move |_| {
        if *refreshing.read() {
            return;
        }
        refreshing.set(true);
        spawn_local(async move {
            match crate::messaging::schedule_list().await {
                Ok(jobs) => reconcile_schedule_jobs(ctx, jobs),
                Err(e) => tracing::warn!("schedule.list refresh failed: {}", e),
            }
            refreshing.set(false);
        });
    };

    let refresh_class = if *refreshing.read() {
        "jobs-refresh-btn spinning"
    } else {
        "jobs-refresh-btn"
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

            h2 { class: "jobs-panel-title", "Jobs" }

            button {
                class: "{refresh_class}",
                onclick: handle_refresh,
                aria_label: "Refresh jobs",
                title: "Refresh",
                svg {
                    width: "16",
                    height: "16",
                    view_box: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    stroke_width: "2",
                    stroke_linecap: "round",
                    stroke_linejoin: "round",
                    path { d: "M23 4v6h-6" }
                    path { d: "M1 20v-6h6" }
                    path { d: "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" }
                }
            }
        }
    }
}

/// One schedule rendered as a card.
#[component]
fn JobCard(job: ScheduleJobState) -> Element {
    let ctx = use_app_context();
    let mut confirm_cancel = use_signal(|| false);
    let mut expanded = use_signal(|| false);
    let mut runs = use_signal(Vec::<serde_json::Value>::new);
    let mut runs_loading = use_signal(|| false);

    let id = job.schedule_id.clone();
    let cadence = cadence_line(&job);
    let (badge_class, badge_text) = run_status_badge(&job);
    let status = job.status.clone();
    let is_active = status == "active";
    let is_paused = status == "paused";
    let run_suffix = if job.run_count == 1 { "" } else { "s" };

    // Read local UI signals unconditionally (keeps the card reactive).
    let is_expanded = *expanded.read();
    let is_runs_loading = *runs_loading.read();
    let is_confirming = *confirm_cancel.read();
    let run_list: Vec<serde_json::Value> = runs.read().clone();

    let pause = {
        let id = id.clone();
        move |_| {
            let id = id.clone();
            spawn_local(async move {
                if let Err(e) = crate::messaging::schedule_pause(&id).await {
                    tracing::warn!("schedule.pause failed: {}", e);
                }
                if let Ok(jobs) = crate::messaging::schedule_list().await {
                    reconcile_schedule_jobs(ctx, jobs);
                }
            });
        }
    };

    let resume = {
        let id = id.clone();
        move |_| {
            let id = id.clone();
            spawn_local(async move {
                if let Err(e) = crate::messaging::schedule_resume(&id).await {
                    tracing::warn!("schedule.resume failed: {}", e);
                }
                if let Ok(jobs) = crate::messaging::schedule_list().await {
                    reconcile_schedule_jobs(ctx, jobs);
                }
            });
        }
    };

    let run_now = {
        let id = id.clone();
        move |_| {
            let id = id.clone();
            spawn_local(async move {
                if let Err(e) = crate::messaging::schedule_run_now(&id).await {
                    tracing::warn!("schedule.run_now failed: {}", e);
                }
                if let Ok(jobs) = crate::messaging::schedule_list().await {
                    reconcile_schedule_jobs(ctx, jobs);
                }
            });
        }
    };

    let cancel_start = move |_| {
        confirm_cancel.set(true);
    };
    let cancel_dismiss = move |_| {
        confirm_cancel.set(false);
    };
    let cancel_confirmed = {
        let id = id.clone();
        move |_| {
            confirm_cancel.set(false);
            let id = id.clone();
            spawn_local(async move {
                if let Err(e) = crate::messaging::schedule_cancel(&id).await {
                    tracing::warn!("schedule.cancel failed: {}", e);
                }
                if let Ok(jobs) = crate::messaging::schedule_list().await {
                    reconcile_schedule_jobs(ctx, jobs);
                }
            });
        }
    };

    let toggle_history = {
        let id = id.clone();
        move |_| {
            let opening = !*expanded.read();
            expanded.set(opening);
            if opening {
                runs_loading.set(true);
                let id = id.clone();
                spawn_local(async move {
                    match crate::messaging::schedule_runs(&id, 20).await {
                        Ok(r) => runs.set(r),
                        Err(e) => tracing::warn!("schedule.runs failed: {}", e),
                    }
                    runs_loading.set(false);
                });
            }
        }
    };

    rsx! {
        div { class: "job-card",
            div { class: "job-card-header",
                span { class: "job-card-name", title: "{job.name}", "{job.name}" }
                span { class: "job-status-chip status-{status}", "{status}" }
            }

            div { class: "job-card-cadence", "{cadence}" }

            div { class: "job-card-badges",
                span { class: "job-run-badge {badge_class}", "{badge_text}" }
                if job.run_count > 0 {
                    span { class: "job-run-count", "{job.run_count} run{run_suffix}" }
                }
                if !job.browser.is_empty() && job.browser != "none" {
                    span { class: "job-browser-chip", "{job.browser}" }
                }
            }

            div { class: "job-card-actions",
                if is_active {
                    button { class: "job-action-btn", onclick: pause, "Pause" }
                } else if is_paused {
                    button { class: "job-action-btn", onclick: resume, "Resume" }
                }
                button { class: "job-action-btn", onclick: run_now, "Run now" }

                if is_confirming {
                    button {
                        class: "job-action-btn job-action-danger",
                        onclick: cancel_confirmed,
                        "Confirm cancel"
                    }
                    button {
                        class: "job-action-btn",
                        onclick: cancel_dismiss,
                        "Keep"
                    }
                } else {
                    button {
                        class: "job-action-btn job-action-danger-ghost",
                        onclick: cancel_start,
                        "Cancel"
                    }
                }
            }

            button {
                class: "job-history-toggle",
                onclick: toggle_history,
                if is_expanded {
                    "Hide run history"
                } else {
                    "Show run history"
                }
            }

            if is_expanded {
                div { class: "job-history",
                    if is_runs_loading {
                        div { class: "job-history-loading",
                            span { class: "loading-spinner" }
                            span { "Loading runs…" }
                        }
                    } else if run_list.is_empty() {
                        div { class: "job-history-empty", "No runs yet." }
                    } else {
                        for (i, run) in run_list.iter().enumerate() {
                            JobRunRow {
                                key: "{run_key(run, i)}",
                                run: run.clone(),
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Stable key for a run row: `run_id` when present, else positional.
fn run_key(run: &serde_json::Value, index: usize) -> String {
    run.get("run_id")
        .and_then(|v| v.as_i64())
        .map(|r| r.to_string())
        .unwrap_or_else(|| format!("run-{index}"))
}

/// One row in a job's expandable run history.
#[component]
fn JobRunRow(run: serde_json::Value) -> Element {
    let status = run
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let started = run
        .get("started_at")
        .and_then(|v| v.as_i64())
        .map(format_unix_datetime)
        .unwrap_or_else(|| "—".to_string());
    let tokens = run.get("tokens_used").and_then(|v| v.as_i64());
    let error = run
        .get("error")
        .and_then(|v| v.as_str())
        .map(String::from)
        .filter(|s| !s.is_empty());

    rsx! {
        div { class: "job-run-row",
            div { class: "job-run-row-top",
                span { class: "job-run-time", "{started}" }
                span { class: "job-run-status status-{status}", "{status}" }
                if let Some(t) = tokens {
                    span { class: "job-run-tokens", "{t} tok" }
                }
            }
            if let Some(err) = error {
                div { class: "job-run-error", "{err}" }
            }
        }
    }
}
