#!/usr/bin/env python3
import re
import os
import sys
import time

def fix_csp(dist_dir):
    # Check if files are in staging directory (trunk behavior)
    stage_dir = os.path.join(dist_dir, '.stage')
    if os.path.exists(os.path.join(stage_dir, 'index.html')):
        dist_dir = stage_dir
        print(f"Using staging directory: {stage_dir}")

    html_file = os.path.join(dist_dir, 'index.html')
    init_js = os.path.join(dist_dir, 'init.js')

    if not os.path.exists(html_file):
        print(f"Error: {html_file} not found")
        sys.exit(1)

    print(f"Fixing CSP for {html_file}...")

    with open(html_file, 'r') as f:
        content = f.read()

    # Find the inline script
    pattern = r'<script type=module>(.*?)</script>'
    match = re.search(pattern, content, re.DOTALL)

    timestamp = int(time.time())

    if match:
        script_content = match.group(1)
        with open(init_js, 'w') as f:
            f.write(script_content)
        print(f"Extracted inline script to {init_js}")

        new_content = re.sub(
            pattern,
            f'<script type="module" src="init.js?v={timestamp}"></script>',
            content,
            flags=re.DOTALL
        )
    else:
        # Try to find existing init.js and update timestamp
        pattern_ext = r'<script type="module" src="init.js(?:\?v=\d+)?"></script>'
        if re.search(pattern_ext, content):
            new_content = re.sub(
                pattern_ext,
                f'<script type="module" src="init.js?v={timestamp}"></script>',
                content
            )
            print(f"Updated existing script tag with timestamp v={timestamp}")
        else:
            print("No suitable script tag found to modify.")
            return

    # Fix relative paths in HTML
    new_content = new_content.replace('href=/', 'href=./')
    new_content = new_content.replace('src=/', 'src=./')

    # Remove legacy bridge.js script tag if present (no longer needed - WASM calls browser.nevoflux.* directly via js_sys)
    bridge_script = '<script src="bridge.js"></script>'
    if bridge_script in new_content:
        new_content = new_content.replace(bridge_script, '')
        print("Removed legacy bridge.js script tag (WASM now calls browser.nevoflux.* directly)")

    with open(html_file, 'w') as f:
        f.write(new_content)

    # Fix paths in init.js
    if os.path.exists(init_js):
        with open(init_js, 'r') as f:
            js_content = f.read()

        # Simple string replacements for common trunk patterns
        js_content = js_content.replace("from '/", "from './")
        js_content = js_content.replace('from "/', 'from "./')
        js_content = js_content.replace("module_or_path: '/", "module_or_path: './")
        js_content = js_content.replace('module_or_path: "/', 'module_or_path: "./')

        # Add maximize/restore button click handlers to preserve user gesture for sidebarAction
        # This must run before WASM to intercept clicks with proper user gesture context
        # CRITICAL: sidebarAction.open/close MUST be called synchronously before any await
        maximize_handler = '''
// Maximize button click handler - MUST be synchronous to preserve user gesture
(function() {
    document.addEventListener('click', function(event) {
        const button = event.target.closest('.maximize-btn');
        if (!button) return;

        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('mode') === 'maximized') return;

        event.preventDefault();
        event.stopPropagation();

        console.log('[NevoFlux] Maximize clicked - synchronous handler');

        // Get data SYNCHRONOUSLY from window globals (set by WASM)
        const sessionId = window.__nevoflux_session_id || '';
        const targetTabId = window.__nevoflux_target_tab_id || 0;

        // Build URL synchronously
        const baseUrl = window.location.href.split('?')[0];
        const newUrl = `${baseUrl}?mode=maximized&session_id=${sessionId}&target_tab_id=${targetTabId}&source_tab_id=${targetTabId}`;

        console.log('[NevoFlux] Opening maximized view:', newUrl);

        // Open tab FIRST using window.open (synchronous, executes before close destroys context)
        window.open(newUrl, '_blank');

        // Then close sidebar (user gesture still valid since no await yet)
        if (browser.sidebarAction && browser.sidebarAction.close) {
            browser.sidebarAction.close().catch(e => console.warn('[NevoFlux] close failed:', e));
        }
    }, true); // capture phase
})();

// Restore button click handler - MUST be synchronous to preserve user gesture
(function() {
    document.addEventListener('click', function(event) {
        const button = event.target.closest('.restore-btn');
        if (!button) return;

        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('mode') !== 'maximized') return;

        event.preventDefault();
        event.stopPropagation();

        console.log('[NevoFlux] Restore clicked - synchronous handler');

        // Get source_tab_id from URL params
        const sourceTabId = parseInt(urlParams.get('source_tab_id')) || 0;

        // Open sidebar FIRST - this requires user gesture
        if (browser.sidebarAction && browser.sidebarAction.open) {
            browser.sidebarAction.open().catch(e => console.warn('[NevoFlux] open failed:', e));
        }

        // Then activate source tab and close this tab (no user gesture needed)
        if (sourceTabId > 0) {
            browser.tabs.update(sourceTabId, { active: true }).catch(e => console.warn('[NevoFlux] activate tab failed:', e));
        }

        // Close current maximized tab
        browser.tabs.getCurrent().then(tab => {
            if (tab && tab.id) {
                browser.tabs.remove(tab.id).catch(e => console.warn('[NevoFlux] close tab failed:', e));
            }
        }).catch(e => console.warn('[NevoFlux] get current tab failed:', e));
    }, true); // capture phase
})();

// Minimize button click handler - MUST be synchronous to preserve user gesture.
// Mirrors the maximize handler above: init.js owns the whole minimize flow in
// plain JS because the extension CSP (script-src 'self' 'wasm-unsafe-eval') blocks
// js_sys::eval, which is why the Rust try_close_sidebar_sync() close was a silent
// no-op. Capture-phase + stopPropagation bypasses the Dioxus onclick so this runs
// once and there is no double-send.
(function() {
    document.addEventListener('click', function(event) {
        const button = event.target.closest('.minimize-btn');
        if (!button) return;

        event.preventDefault();
        event.stopPropagation();

        const urlParams = new URLSearchParams(window.location.search);
        const isMaximized = urlParams.get('mode') === 'maximized';

        console.log('[NevoFlux] Minimize clicked - synchronous handler (maximized=' + isMaximized + ')');

        // Gather session context so the background can restore the right session when
        // the avatar Maximize button is clicked. Window globals cover sidebar mode;
        // URL params cover the maximized-tab mode (mirroring how the maximize handler
        // sources them in the sidebar branch above).
        const sessionId = window.__nevoflux_session_id || urlParams.get('session_id') || '';
        const targetTabId = window.__nevoflux_target_tab_id || parseInt(urlParams.get('target_tab_id') || '0', 10) || 0;

        // Notify the background FIRST to show the floating avatar + start the daemon
        // keepalive. sendMessage returns a Promise, but the send itself is dispatched
        // synchronously to the browser IPC while the gesture is still active, so the
        // message survives the imminent teardown from the close/remove below.
        if (browser.runtime && browser.runtime.sendMessage) {
            browser.runtime.sendMessage({ type: 'bg:agent_minimize', session_id: sessionId, target_tab_id: targetTabId }).catch(e => console.warn('[NevoFlux] minimize sendMessage failed:', e));
        }

        if (isMaximized) {
            // Maximized tab: no sidebar involved. Close the current tab. The tabs API
            // has no user-gesture gating, so this is safe after the async sendMessage.
            console.log('[NevoFlux] Minimize from maximized tab - closing current tab');
            browser.tabs.getCurrent().then(tab => {
                if (tab && tab.id) {
                    browser.tabs.remove(tab.id).catch(e => console.warn('[NevoFlux] close tab failed:', e));
                }
            }).catch(e => console.warn('[NevoFlux] get current tab failed:', e));
        } else {
            // Sidebar: close it (user gesture still valid since no await yet).
            if (browser.sidebarAction && browser.sidebarAction.close) {
                browser.sidebarAction.close().catch(e => console.warn('[NevoFlux] close failed:', e));
            }
        }
    }, true); // capture phase
})();

'''
        # Only add if not already present
        if 'maximize-btn' not in js_content:
            js_content = maximize_handler + js_content
            print("Added maximize button click handler to init.js")

        with open(init_js, 'w') as f:
            f.write(js_content)
        print(f"Fixed paths in {init_js} to be relative")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: fix-csp.py <dist_dir>")
        sys.exit(1)
    fix_csp(sys.argv[1])
