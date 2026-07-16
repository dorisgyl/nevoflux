/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use dioxus::prelude::*;
use crate::context::AppContext;

/// Auto-dismiss delay in milliseconds.
const TOAST_TTL_MS: u32 = 5000;

#[component]
pub fn EventBusListener() -> Element {
    let ctx = use_context::<AppContext>();

    // Auto-dismiss whenever a notification is present. The signal is read
    // *inside* the effect closure so the effect actually subscribes to it and
    // re-runs every time a notification is added or removed. (The previous
    // version captured a `count` computed outside the closure, so the effect
    // subscribed to nothing, ran once at mount with `count == 0`, and never
    // scheduled a dismissal again — leaving toasts on screen indefinitely.)
    use_effect(move || {
        let is_empty = ctx.event_notifications.read().is_empty();
        if is_empty {
            return;
        }
        spawn(async move {
            crate::messaging::sleep_ms(TOAST_TTL_MS).await;
            let mut sig = ctx.event_notifications;
            let mut notifs = sig.write();
            // Remove the oldest notification (the one that just expired). Any
            // surplus timers scheduled while several toasts were queued are
            // absorbed by this emptiness guard as harmless no-ops.
            if !notifs.is_empty() {
                notifs.remove(0);
            }
        });
    });

    let notifications = ctx.event_notifications.read();
    let visible: Vec<_> = notifications.iter().rev().take(3).collect();

    rsx! {
        if !visible.is_empty() {
            div { class: "nevo-event-toasts",
                for notif in visible {
                    div {
                        class: "nevo-event-toast",
                        key: "{notif.id}",
                        button {
                            class: "nevo-event-toast-close",
                            aria_label: "Dismiss notification",
                            onclick: {
                                let id = notif.id.clone();
                                move |_| {
                                    let mut sig = ctx.event_notifications;
                                    sig.write().retain(|n| n.id != id);
                                }
                            },
                            "\u{00D7}"
                        }
                        div { class: "nevo-event-toast-title", "{notif.title}" }
                        if !notif.body.is_empty() {
                            div { class: "nevo-event-toast-body", "{notif.body}" }
                        }
                    }
                }
            }
        }
    }
}
