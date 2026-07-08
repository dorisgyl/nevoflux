/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Time formatting utilities

/// Format a timestamp as a human-readable time string
pub fn format_time(timestamp: u64) -> String {
    let date = js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(timestamp as f64));
    let hours = date.get_hours();
    let minutes = date.get_minutes();
    let am_pm = if hours >= 12 { "PM" } else { "AM" };
    let hours_12 = if hours == 0 {
        12
    } else if hours > 12 {
        hours - 12
    } else {
        hours
    };
    format!("{}:{:02} {}", hours_12, minutes, am_pm)
}

/// Format a unix-**seconds** timestamp as a local `"Mon D, h:mm AM/PM"` string.
///
/// Schedule timestamps (`next_fire_at`, `last_run_at`, run `started_at`/
/// `ended_at`) are unix seconds, so multiply into the milliseconds that
/// `js_sys::Date` expects.
pub fn format_unix_datetime(unix_secs: i64) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let ms = (unix_secs as f64) * 1000.0;
    let date = js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(ms));
    let month = MONTHS
        .get(date.get_month() as usize)
        .copied()
        .unwrap_or("?");
    let day = date.get_date();
    let hours = date.get_hours();
    let minutes = date.get_minutes();
    let am_pm = if hours >= 12 { "PM" } else { "AM" };
    let hours_12 = if hours == 0 {
        12
    } else if hours > 12 {
        hours - 12
    } else {
        hours
    };
    format!("{} {}, {}:{:02} {}", month, day, hours_12, minutes, am_pm)
}

/// Format a duration in milliseconds as a human-readable string
pub fn format_duration(ms: u64) -> String {
    let seconds = ms / 1000;
    if seconds < 60 {
        format!("{}s", seconds)
    } else {
        let minutes = seconds / 60;
        let secs = seconds % 60;
        format!("{}m {}s", minutes, secs)
    }
}
