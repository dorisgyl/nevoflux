/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Per-session "Agent execution" tier chip.
//!
//! Shows what this chat runs at (how much auto-executes without a confirmation)
//! and lets the user override it for THIS session only. The pick is written to
//! `config:session:<id>:agentExecution`, which the daemon's permission gate
//! reads with precedence over the global default — it does not change the
//! global setting or leak to other chats.

use crate::context::use_app_context;
use crate::messaging;
use dioxus::prelude::*;

/// The four tiers, ascending privilege. Values match the settings page and the
/// daemon's `ExecutionTier::from_setting`; labels match settings.js.
const TIERS: &[(&str, &str)] = &[
    ("read-only", "Read-only"),
    ("browser-auto", "Browser auto"),
    ("browser-auto-local-read", "Browser auto + reads"),
    ("full-auto", "Full auto"),
];

fn tier_label(value: &str) -> &'static str {
    TIERS
        .iter()
        .find(|(v, _)| *v == value)
        .map(|(_, l)| *l)
        .unwrap_or("Read-only")
}

#[component]
pub fn TierChip() -> Element {
    let ctx = use_app_context();

    // Effective tier for this session; starts at the global default and becomes
    // an explicit override once the user picks.
    let mut tier = use_signal(|| "read-only".to_string());
    let mut is_override = use_signal(|| false);
    let mut open = use_signal(|| false);
    // Tracks which session the current tier state belongs to, so we only reset
    // on an actual session switch (not on unrelated session-signal updates).
    let mut synced_session = use_signal(String::new);

    // Re-evaluate whenever the ACTIVE SESSION changes: a new session starts at
    // the current global default (config:settings → general.agentExecution) with
    // no per-session override yet. Reading the session id makes this effect
    // reactive to session switches; a same-session re-render returns early so a
    // user's per-session pick is preserved.
    use_effect(move || {
        let sid = ctx.session.read().id.clone();
        if *synced_session.peek() == sid {
            return;
        }
        synced_session.set(sid);
        is_override.set(false);
        wasm_bindgen_futures::spawn_local(async move {
            let global = messaging::fetch_agent_execution_tier()
                .await
                .ok()
                .flatten()
                .unwrap_or_else(|| "read-only".to_string());
            if !*is_override.peek() {
                tier.set(global);
            }
        });
    });

    let session_id = ctx.session.read().id.clone();
    let current = tier.read().clone();
    let overridden = *is_override.read();
    let is_open = *open.read();

    let chip_class = if overridden {
        "tier-chip tier-chip-override"
    } else {
        "tier-chip"
    };

    rsx! {
        div { class: "tier-chip-wrap",
            button {
                class: "{chip_class}",
                title: "Agent execution — what runs without confirmation this session",
                onclick: move |_| {
                    let next = !*open.read();
                    open.set(next);
                },
                if overridden {
                    span { class: "tier-chip-dot" }
                }
                span { class: "tier-chip-name", "{tier_label(&current)}" }
                span { class: "tier-chip-caret", "▾" }
            }

            if is_open {
                div { class: "tier-chip-menu",
                    for (value, label) in TIERS.iter().copied() {
                        button {
                            class: if value == current {
                                "tier-chip-item tier-chip-item-active"
                            } else {
                                "tier-chip-item"
                            },
                            onclick: {
                                let session_id = session_id.clone();
                                let value = value.to_string();
                                move |_| {
                                    let session_id = session_id.clone();
                                    let value = value.clone();
                                    tier.set(value.clone());
                                    is_override.set(true);
                                    open.set(false);
                                    wasm_bindgen_futures::spawn_local(async move {
                                        let key = format!(
                                            "config:session:{}:agentExecution",
                                            session_id
                                        );
                                        if let Err(e) = messaging::send_content_store_set(
                                            &key,
                                            serde_json::Value::String(value),
                                        )
                                        .await
                                        {
                                            tracing::warn!(
                                                "Could not set session execution tier: {}",
                                                e
                                            );
                                        }
                                    });
                                }
                            },
                            "{label}"
                        }
                    }
                }
            }
        }
    }
}
