/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Skills-update dialog: after an update whose bundled default skills changed,
//! offer to replace the user's local skills with the bundled ones or keep them.

use crate::context::use_app_context;
use dioxus::prelude::*;
use wasm_bindgen_futures::spawn_local;

/// Shown when the agent pushes a `skills_update_request` (bundled default skills
/// changed since they were last applied). Reuses the tool-auth modal styling.
#[component]
pub fn SkillsUpdateDialog() -> Element {
    let mut ctx = use_app_context();
    let pending = ctx.pending_skills_update.read();

    let Some(request) = pending.as_ref() else {
        return rsx! {};
    };
    let count = request.bundled_count;

    rsx! {
        div {
            class: "tool-auth-overlay",
            role: "dialog",
            aria_modal: "true",
            aria_label: "Skills update available",

            div { class: "tool-auth-dialog",
                div { class: "tool-auth-header",
                    span { class: "tool-auth-lock", "\u{1F9E9}" }
                    span { class: "tool-auth-title", "Skills update available" }
                }

                div { class: "tool-auth-card",
                    span { class: "tool-auth-detail",
                        "This update ships {count} default skill(s). Replace your local skills with the bundled ones, or keep yours? Your current skills are backed up before replacing."
                    }
                }

                div { class: "tool-auth-options",
                    button {
                        class: "tool-auth-btn tool-auth-btn--persistent",
                        onclick: move |_| {
                            ctx.pending_skills_update.set(None);
                            spawn_local(async move {
                                if let Err(e) = crate::messaging::send_skills_update_response(true).await {
                                    tracing::error!("Failed to send skills update response: {}", e);
                                }
                            });
                        },
                        "Replace"
                    }
                    button {
                        class: "tool-auth-btn",
                        onclick: move |_| {
                            ctx.pending_skills_update.set(None);
                            spawn_local(async move {
                                if let Err(e) = crate::messaging::send_skills_update_response(false).await {
                                    tracing::error!("Failed to send skills update response: {}", e);
                                }
                            });
                        },
                        "Keep mine"
                    }
                }
            }
        }
    }
}
