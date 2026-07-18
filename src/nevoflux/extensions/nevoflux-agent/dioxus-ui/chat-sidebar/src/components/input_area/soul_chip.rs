/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Shows which assistant is answering, and lets the user undo a temporary pick.

use crate::context::use_app_context;
use crate::state::soul::derive_active_soul;
use dioxus::prelude::*;

/// The soul answering right now.
///
/// Two states, because they mean different things: the soul this Space always
/// uses is just a fact (shown quietly, nothing to undo), while a soul the user
/// called on with `@` is a choice they can take back.
///
/// Nothing is shown when no soul is bound — an unbound Space works exactly as it
/// did before souls existed, and a chip saying "default" would only add noise.
#[component]
pub fn SoulChip() -> Element {
    let mut ctx = use_app_context();

    let container = ctx.tab_context.read().cookie_store_id.clone();
    let picked = ctx.active_soul.read().as_ref().and_then(|a| {
        a.is_override.then(|| a.slug.clone())
    });

    let active = derive_active_soul(
        &ctx.souls.read(),
        &ctx.soul_bindings.read(),
        &container,
        picked.as_deref(),
    );

    let Some(active) = active else {
        return rsx! {};
    };

    let session_id = ctx.session.read().id.clone();
    let mode = ctx.chat_mode.read().clone();

    // Going back to the Space's own soul is a message, not a local toggle: the
    // pin lives in the session, so only the daemon can drop it.
    let handle_clear = move |_| {
        let session_id = session_id.clone();
        let mode = mode.clone();
        ctx.active_soul.set(None);
        wasm_bindgen_futures::spawn_local(async move {
            if let Err(e) = crate::messaging::send_chat_message(
                &session_id,
                String::new(),
                mode,
                vec![],
                vec![],
                None,
                vec![],
                Some(shared_protocol::SoulMention::clear()),
            )
            .await
            {
                tracing::warn!("Could not go back to this Space's soul: {}", e);
            }
        });
    };

    let class = if active.is_override {
        "soul-chip soul-chip-override"
    } else {
        "soul-chip"
    };

    rsx! {
        div { class: "{class}",
            if let Some(ref avatar) = active.avatar {
                img { class: "soul-chip-avatar", src: "{avatar}", alt: "", width: "16", height: "16" }
            }

            span { class: "soul-chip-name", "{active.name}" }

            if active.is_override {
                button {
                    class: "soul-chip-clear",
                    onclick: handle_clear,
                    aria_label: "Go back to this Space's assistant",
                    title: "Go back to this Space's assistant",
                    "×"
                }
            } else {
                span { class: "soul-chip-note", "this Space" }
            }
        }
    }
}
