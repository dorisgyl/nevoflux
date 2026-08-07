/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `/remote-control` device sign-in: open the approval page with the code
//! already filled in, say what the user still has to do, and poll to the end.

use crate::state::Message;
use dioxus::prelude::*;
use shared_protocol::ChatMode;

/// What the browser's session on the account host looks like. `Unknown` is a
/// real state, not an error case — the probe can fail while the sign-in is
/// still perfectly completable, so the copy hedges instead of asserting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebSession {
    SignedIn,
    SignedOut,
    Unknown,
}

/// Scheme + authority of `uri`, e.g. `https://nevoflux.app`. `None` when `uri`
/// has no `://` or no host.
///
/// The session probe must hit the same host the auth server just named, not a
/// hardcoded one: the daemon's base URL comes from `NEVOFLUX_ACCOUNT_URL`, which
/// the background script cannot see, so deriving it is what keeps a dev
/// deployment from drifting between the two sides.
fn origin_of(uri: &str) -> Option<String> {
    let (scheme, rest) = uri.split_once("://")?;
    if scheme.is_empty() {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{authority}"))
}

/// The message shown when a device sign-in is needed. All three variants keep
/// the code visible: the tab may fail to open, or the page's prefill may not
/// take, and then typing it is the only way through.
fn compose_prompt(user_code: &str, uri: &str, state: WebSession) -> String {
    let code_block = if user_code.is_empty() {
        format!("Open **{uri}** and follow the prompts.")
    } else {
        format!("## `{user_code}`")
    };
    match state {
        WebSession::SignedIn => format!(
            "Already signed in to nevoflux.app. I opened the approval page with the device code filled in:\n\n{code_block}\n\nClick **Approve** in the new tab and I will carry on."
        ),
        WebSession::SignedOut => format!(
            "To open remote control you need to sign in to nevoflux.app first.\n\nI opened the approval page with the device code filled in:\n\n{code_block}\n\nThe page will ask you to sign in first — it comes back afterwards with the code **still filled in**, so just click Approve. I will carry on from there."
        ),
        WebSession::Unknown => format!(
            "To open remote control you need to approve this device on nevoflux.app.\n\nI opened the approval page with the device code filled in:\n\n{code_block}\n\nIf the page asks you to sign in, do that first — the code survives the sign-in. Then click Approve and I will carry on."
        ),
    }
}

/// How long to keep polling before giving up. The auth server's code lifetime
/// is 30 minutes (`expires_in`), so this matches it.
const POLL_WINDOW_SECS: u32 = 30 * 60;

/// Open the portal channel and render the pairing code for the user.
async fn open_channel(mut messages: Signal<Vec<Message>>, session_id: &str, mode: ChatMode) {
    match crate::messaging::remote_start(session_id, mode).await {
        Ok((channel_id, pairing)) => {
            messages.write().push(Message::assistant_markdown(format!(
                "✅ Remote control is open.\n\nOn the other device, open this link and sign in to the same account:\n\n**https://portal.nevoflux.app/connect/{channel_id}**\n\nThen enter the pairing code:\n\n## `{pairing}`\n\nKeep this session open — closing the window ends the remote channel."
            )));
        }
        Err(e) => {
            messages.write().push(Message::assistant_markdown(format!(
                "Could not open the remote control channel: {e}"
            )));
        }
    }
}

/// Drive `/remote-control`: reuse the stored account token when there is one,
/// otherwise run a device grant with the approval page opened and prefilled.
pub async fn run(mut messages: Signal<Vec<Message>>, session_id: String, mode: ChatMode) {
    use crate::messaging::{account_device_grant_poll, account_device_grant_start, account_status};

    match account_status().await {
        Ok(true) => {
            open_channel(messages, &session_id, mode).await;
            return;
        }
        Ok(false) => {}
        Err(e) => {
            messages.write().push(Message::assistant_markdown(format!(
                "Could not check sign-in status: {e}"
            )));
            return;
        }
    }

    let grant = match account_device_grant_start().await {
        Ok(g) => g,
        Err(e) => {
            messages.write().push(Message::assistant_markdown(format!(
                "Could not start device sign-in: {e}"
            )));
            return;
        }
    };

    // Probe the browser's session so the prompt can say what is actually left
    // to do. A failed probe is not fatal — it just means hedged wording.
    let state = match origin_of(&grant.verification_uri) {
        Some(origin) => match crate::bindings::nevoflux_api::check_web_session(&origin).await {
            Ok(true) => WebSession::SignedIn,
            Ok(false) => WebSession::SignedOut,
            Err(e) => {
                tracing::warn!("[device_login] session probe failed: {e}");
                WebSession::Unknown
            }
        },
        None => WebSession::Unknown,
    };

    // Prefer the prefilled URL; the device page reads `?user_code=` and fills
    // its input without submitting, which is exactly the hand-off we want.
    let open_url = grant
        .verification_uri_complete
        .clone()
        .unwrap_or_else(|| grant.verification_uri.clone());

    let mut prompt = compose_prompt(&grant.user_code, &grant.verification_uri, state);
    if let Err(e) = crate::bindings::nevoflux_api::open_tab_via_background(&open_url, true).await {
        tracing::warn!("[device_login] could not open the approval tab: {e}");
        prompt.push_str(&format!(
            "\n\n(Could not open the tab automatically — please open {} yourself.)",
            grant.verification_uri
        ));
    }
    messages.write().push(Message::assistant_markdown(prompt));

    let step = grant.interval_secs.max(1);
    for _ in 0..(POLL_WINDOW_SECS / step) {
        crate::messaging::sleep_ms(step * 1000).await;
        match account_device_grant_poll(&grant.device_code).await {
            Ok(outcome) => match outcome.as_str() {
                "token" => {
                    messages.write().push(Message::assistant_markdown(
                        "✅ Signed in. Opening the remote control channel…",
                    ));
                    // ChatMode is Clone but not Copy, and this move sits
                    // inside a loop — clone rather than fight the borrow check.
                    open_channel(messages, &session_id, mode.clone()).await;
                    return;
                }
                "denied" => {
                    messages
                        .write()
                        .push(Message::assistant_markdown("❌ Authorization was denied."));
                    return;
                }
                // pending / slow_down — keep waiting.
                _ => {}
            },
            // A transport error is a blip, not an answer. Aborting here threw
            // away a sign-in the user had minutes left to complete; the CLI has
            // always retried instead (see nevoflux-agent src/main.rs).
            Err(e) => {
                tracing::warn!("[device_login] poll failed, retrying: {e}");
            }
        }
    }

    messages.write().push(Message::assistant_markdown(
        "The sign-in code expired before it was approved. Run `/remote-control` again to get a new one.",
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_of_strips_path_query_and_fragment() {
        assert_eq!(
            origin_of("https://nevoflux.app/device?user_code=ABC#x").as_deref(),
            Some("https://nevoflux.app")
        );
        assert_eq!(
            origin_of("http://localhost:4321/device").as_deref(),
            Some("http://localhost:4321")
        );
    }

    #[test]
    fn origin_of_rejects_input_without_a_scheme() {
        assert_eq!(origin_of("/device?user_code=ABC"), None);
        assert_eq!(origin_of("https://"), None);
    }

    #[test]
    fn every_prompt_shows_the_code_so_it_can_be_typed_by_hand() {
        for state in [WebSession::SignedIn, WebSession::SignedOut, WebSession::Unknown] {
            let out = compose_prompt("LYH57LZR", "https://nevoflux.app/device", state);
            assert!(
                out.contains("LYH57LZR"),
                "{state:?} prompt must still show the code — the tab may not open"
            );
        }
    }

    #[test]
    fn signed_out_prompt_says_to_sign_in_and_that_the_code_survives() {
        let out = compose_prompt("LYH57LZR", "https://nevoflux.app/device", WebSession::SignedOut);
        assert!(out.contains("sign in"), "must tell the user to sign in");
        assert!(
            out.contains("still filled in"),
            "must reassure that the code survives the login round-trip"
        );
    }

    #[test]
    fn signed_in_prompt_does_not_nag_about_signing_in() {
        let out = compose_prompt("LYH57LZR", "https://nevoflux.app/device", WebSession::SignedIn);
        assert!(out.contains("Approve"));
        assert!(
            !out.contains("need to sign in"),
            "already signed in — do not ask for it again"
        );
    }

    #[test]
    fn unknown_prompt_hedges_rather_than_asserting_a_state() {
        let out = compose_prompt("LYH57LZR", "https://nevoflux.app/device", WebSession::Unknown);
        assert!(out.contains("If the page asks you to sign in"));
    }

    #[test]
    fn prompt_without_a_code_still_points_at_the_page() {
        let out = compose_prompt("", "https://nevoflux.app/device", WebSession::Unknown);
        assert!(out.contains("https://nevoflux.app/device"));
    }
}
