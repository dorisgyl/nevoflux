/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Message area components

mod welcome_screen;
mod message_list;
mod message_bubble;
mod error_card;
mod code_block;
mod activity_feed;
mod live_tool_feed;

pub use welcome_screen::WelcomeScreen;
pub use message_list::MessageList;
pub use message_bubble::MessageBubble;
pub use error_card::ErrorCard;
pub use code_block::CodeBlock;
pub use activity_feed::ActivityFeed;
pub use activity_feed::DoneFeed;
pub use live_tool_feed::LiveToolFeed;

use dioxus::prelude::*;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(inline_js = r#"
export function copyTextFallback(text) {
    // execCommand fallback — works in extension sidebar where
    // navigator.clipboard.writeText is blocked by security context
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) return true;
    } catch (_) {}
    return false;
}

export function initCodeCopyDelegation() {
    if (window.__codeCopyInit) return;
    window.__codeCopyInit = true;
    document.addEventListener('click', function(e) {
        const btn = e.target.closest('.markdown-content .code-copy-btn');
        if (!btn) return;
        const codeBlock = btn.closest('.code-block');
        if (!codeBlock) return;
        const pre = codeBlock.querySelector('pre');
        if (!pre) return;
        const text = pre.textContent;
        // execCommand fallback (works in extension sidebar)
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            if (ok) {
                btn.textContent = 'Copied!';
                btn.classList.add('copied');
                setTimeout(function() {
                    btn.textContent = 'Copy';
                    btn.classList.remove('copied');
                }, 2000);
                return;
            }
        } catch (_) {}
        // Async Clipboard API fallback
        navigator.clipboard.writeText(text).then(function() {
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(function() {
                btn.textContent = 'Copy';
                btn.classList.remove('copied');
            }, 2000);
        });
    });
}
"#)]
extern "C" {
    #[wasm_bindgen(js_name = copyTextFallback)]
    pub fn copy_text_fallback(text: &str) -> bool;

    #[wasm_bindgen(js_name = initCodeCopyDelegation)]
    pub fn init_code_copy_delegation();
}
use crate::context::use_app_context;

/// Message area container - shows welcome screen or message list
#[component]
pub fn MessageArea() -> Element {
    let ctx = use_app_context();
    let messages = ctx.messages.read();
    let streaming = ctx.streaming.read();
    let is_empty = messages.is_empty() && streaming.is_none();

    // Set up event delegation for code copy buttons in markdown content (once)
    use_effect(|| { init_code_copy_delegation(); });

    rsx! {
        div { class: "message-area",
            // Sticky stack of /loop cards (spec §2.6).
            // Renders nothing when no active loops exist for this session.
            crate::components::loop_ui::StickyLoopCards {}
            if is_empty {
                WelcomeScreen {}
            } else {
                MessageList {}
            }
        }
    }
}
