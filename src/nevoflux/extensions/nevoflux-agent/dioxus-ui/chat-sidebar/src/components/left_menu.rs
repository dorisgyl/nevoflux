/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Left menu rail — a narrow vertical navigation rail shown only in the
//! maximized (tab) form. Currently hosts a single Jobs entry that toggles the
//! Jobs panel. `lib.rs` wraps the main column in `.sidebar-row` and mounts
//! this to its left when `ctx.maximize.read().is_maximized`.

use dioxus::prelude::*;

use crate::context::use_app_context;

/// Narrow (48px) vertical rail for maximized mode.
#[component]
pub fn LeftMenu() -> Element {
    let mut ctx = use_app_context();

    // Rendered only in the maximized form.
    if !ctx.maximize.read().is_maximized {
        return rsx! {};
    }

    // Only non-terminal (live) schedules light the rail badge; terminal rows
    // (`cancelled`/`ran`) must not (mirrors the header derivation).
    let has_jobs = ctx
        .schedule_jobs
        .read()
        .values()
        .any(|j| j.status != "cancelled" && j.status != "ran");
    let jobs_open = *ctx.show_jobs_panel.read();

    let toggle_jobs = move |_| {
        let current = *ctx.show_jobs_panel.read();
        ctx.show_jobs_panel.set(!current);
    };

    let item_class = match (jobs_open, has_jobs) {
        (true, true) => "left-menu-item active has-jobs",
        (true, false) => "left-menu-item active",
        (false, true) => "left-menu-item has-jobs",
        (false, false) => "left-menu-item",
    };

    rsx! {
        nav {
            class: "left-menu",
            aria_label: "Jobs navigation",

            button {
                class: "{item_class}",
                onclick: toggle_jobs,
                aria_label: "Jobs",
                title: "Jobs",
                svg {
                    xmlns: "http://www.w3.org/2000/svg",
                    view_box: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    stroke_width: "2",
                    stroke_linecap: "round",
                    stroke_linejoin: "round",
                    width: "20",
                    height: "20",
                    rect { x: "3", y: "4", width: "18", height: "18", rx: "2" }
                    line { x1: "16", y1: "2", x2: "16", y2: "6" }
                    line { x1: "8", y1: "2", x2: "8", y2: "6" }
                    line { x1: "3", y1: "10", x2: "21", y2: "10" }
                    circle { cx: "12", cy: "16", r: "2", fill: "currentColor", stroke: "none" }
                }
            }
        }
    }
}
