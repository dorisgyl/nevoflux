/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Sidebar state for the `/schedule` skill (routines-style background jobs).
//!
//! Populated from two sources:
//!   - `schedule.list` (authoritative full snapshot) — deserialized directly
//!     into [`ScheduleJobState`] via serde; field names mirror the daemon
//!     tool output (`schedule_id`, `name`, `status`, `cron`, `at`,
//!     `next_fire_at`, `last_run_status`, `last_run_at`, `run_count`,
//!     `browser`, `mode`).
//!   - `system:schedule:*` EventBus deliveries — merged field-by-field in
//!     `handler::apply_schedule_event` (their payloads use different keys,
//!     e.g. `cron_expr`/`new_status`, so they are applied manually).

/// Per-schedule sidebar state, keyed by `schedule_id` in `AppContext::schedule_jobs`.
///
/// `running` is derived from `run_start`/`run_end` events and is never present
/// in the `schedule.list` payload, so it is skipped on deserialization and
/// preserved across list reconciliation.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize)]
pub struct ScheduleJobState {
    pub schedule_id: String,
    #[serde(default)]
    pub name: String,
    /// Lifecycle status: `active` | `paused` | `cancelled` | `completed` | ...
    #[serde(default)]
    pub status: String,
    /// Cron expression (recurring jobs). `None` for one-off `at` jobs.
    #[serde(default)]
    pub cron: Option<String>,
    /// One-off fire time as unix seconds. `None` for recurring cron jobs.
    #[serde(default)]
    pub at: Option<i64>,
    /// Next scheduled fire time (unix seconds).
    #[serde(default)]
    pub next_fire_at: Option<i64>,
    /// Outcome of the most recent run: `ok` | `error` | `missed`.
    #[serde(default)]
    pub last_run_status: Option<String>,
    /// Timestamp (unix seconds) of the most recent run.
    #[serde(default)]
    pub last_run_at: Option<i64>,
    /// Total completed runs.
    #[serde(default)]
    pub run_count: i64,
    /// Browser policy: `none` | `headless` | `live` | ...
    #[serde(default)]
    pub browser: String,
    /// Execution mode (`chat`, etc.).
    #[serde(default)]
    pub mode: String,
    /// True while a run is in flight (set by `run_start`, cleared by `run_end`).
    /// Not part of the `schedule.list` payload — preserved across reconciliation.
    #[serde(default, skip_deserializing)]
    pub running: bool,
}
