/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * NevoFluxAgentAvatar — floating chrome avatar shown while the chat is
 * minimized. Rendered as a position:fixed element over the content area.
 * State is pushed from the extension background via the nevoflux parent API.
 *
 * Supports pointer-drag repositioning with position persisted to prefs:
 *   extensions.nevoflux.avatar.x / extensions.nevoflux.avatar.y
 *
 * _wasDrag is set true when movement during a drag exceeds 4 px; Task 7
 * uses it to distinguish a click (open menu) from a completed drag.
 *
 * Task 7: on a non-drag click, a small context menu appears with three actions:
 *   Restore, Maximize, Close.
 * Actions are routed to the extension background via NevofluxBridgeRouter.
 */

const { NevofluxBridgeRouter } = ChromeUtils.importESModule(
  'resource:///modules/NevofluxBridgeRouter.sys.mjs'
);

const AVATAR_ID = 'nevoflux-agent-avatar';
const PREF_X = 'extensions.nevoflux.avatar.x';
const PREF_Y = 'extensions.nevoflux.avatar.y';
const DRAG_THRESHOLD = 4; // pixels
// Chrome-side command id of the NevoFlux extension sidebar panel: makeWidgetId
// of the extension id `agent@nevoflux.com` (`agent_nevoflux_com`) plus the
// `-sidebar-action` suffix. Opening via the chrome SidebarController runs in the
// browser window context, which has no requireUserInput gating — unlike the
// background's browser.sidebarAction.open() (EventManager fire.async).
const NEVOFLUX_SIDEBAR_ID = 'agent_nevoflux_com-sidebar-action';

export const NevoFluxAgentAvatar = {
  _el: null,
  _wasDrag: false,
  _menu: null,
  _outsideClickHandler: null,
  _bubbleTimer: null,

  _ensure() {
    if (this._el && this._el.isConnected) return this._el;
    const doc = window.document;
    const el = doc.createElement('div');
    el.id = AVATAR_ID;
    el.className = 'nevoflux-agent-avatar';
    el.setAttribute('data-state', 'idle');
    el.hidden = true;
    const img = doc.createElement('div');
    img.className = 'nevoflux-agent-avatar__face';
    el.appendChild(img);
    const badge = doc.createElement('div');
    badge.className = 'nevoflux-agent-avatar__badge';
    el.appendChild(badge);
    doc.documentElement.appendChild(el);
    this._el = el;

    // Restore persisted position (Services is a chrome global — no import needed).
    try {
      let x = Services.prefs.getIntPref(PREF_X, -1);
      let y = Services.prefs.getIntPref(PREF_Y, -1);
      if (x >= 0 && y >= 0) {
        // Clamp to the current viewport so a position saved on a larger window
        // (or another monitor) can't restore the avatar fully off-screen (I3).
        x = Math.max(0, Math.min(x, window.innerWidth - 48));
        y = Math.max(0, Math.min(y, window.innerHeight - 48));
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      }
    } catch (_e) {}

    // Pointer drag — closure state.
    let dragging = false;
    let ox = 0;
    let oy = 0;
    let startX = 0;
    let startY = 0;

    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      this._wasDrag = false;
      el.setPointerCapture(e.pointerId);
      const r = el.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      startX = e.clientX;
      startY = e.clientY;
      el.style.cursor = 'grabbing';
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // Clamp to the viewport (floor AND ceiling) so a drag can't park the
      // avatar off-screen where it could never be clicked again (I3).
      const x = Math.max(0, Math.min(e.clientX - ox, window.innerWidth - 48));
      const y = Math.max(0, Math.min(e.clientY - oy, window.innerHeight - 48));
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      // Mark as a drag once movement exceeds the threshold.
      if (!this._wasDrag) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
          this._wasDrag = true;
        }
      }
    });

    el.addEventListener('pointerup', (_e) => {
      if (!dragging) return;
      dragging = false;
      el.style.cursor = 'grab';
      // Persist final position to prefs.
      try {
        const r = el.getBoundingClientRect();
        Services.prefs.setIntPref(PREF_X, Math.round(r.left));
        Services.prefs.setIntPref(PREF_Y, Math.round(r.top));
      } catch (_e2) {}
    });

    // Click: open menu if this was not a drag.
    el.addEventListener('click', () => {
      if (this._wasDrag) return;
      if (this._menu) {
        this._closeMenu();
      } else {
        this._openMenu();
      }
    });

    return el;
  },

  /**
   * Build and display the context menu near the avatar.
   * Items: Restore / Maximize / Close.
   */
  _openMenu() {
    this._closeMenu(); // guard against doubles
    const doc = window.document;
    const menu = doc.createElement('div');
    menu.className = 'nevoflux-agent-avatar-menu';

    const items = [
      {
        label: 'Restore',
        handler: () => {
          // Open the sidebar DIRECTLY from chrome. Chrome APIs have no
          // requireUserInput gating, so this succeeds where the background's
          // browser.sidebarAction.open() loses the gesture across the bridge
          // round-trip and is rejected.
          try {
            window.SidebarController?.show(NEVOFLUX_SIDEBAR_ID);
          } catch (_e) {}
          // Still notify the background for bookkeeping (stop the keepalive,
          // broadcast the hide); it no longer opens the sidebar itself.
          NevofluxBridgeRouter.request('avatar:restore', {}).catch(() => {});
          // Hide the avatar locally (also closes this menu).
          this.hide();
        },
      },
      {
        label: 'Maximize',
        handler: () => {
          NevofluxBridgeRouter.request('avatar:maximize', {}).catch(() => {});
          this._closeMenu();
        },
      },
      {
        label: 'Close',
        handler: () => {
          const state = this._el.getAttribute('data-state');
          if (state === 'working' || state === 'needs-you') {
            // eslint-disable-next-line no-alert
            const ok = Services.prompt.confirm(
              window,
              'NevoFlux',
              'The agent is still working. Close anyway?'
            );
            if (!ok) {
              this._closeMenu();
              return;
            }
          }
          NevofluxBridgeRouter.request('avatar:close', {}).catch(() => {});
          this._closeMenu();
        },
      },
    ];

    for (const item of items) {
      const btn = doc.createElement('div');
      btn.className = 'nevoflux-agent-avatar-menu__item';
      btn.textContent = item.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        item.handler();
      });
      menu.appendChild(btn);
    }

    // Position the menu above and to the left of the avatar.
    const r = this._el.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.top = `${Math.round(r.top - 8)}px`; // will be shifted up by translateY in CSS

    doc.documentElement.appendChild(menu);
    this._menu = menu;

    // Dismiss on any outside click (captured in the capture phase).
    this._outsideClickHandler = (e) => {
      if (!menu.contains(e.target) && !this._el.contains(e.target)) {
        this._closeMenu();
      }
    };
    doc.addEventListener('click', this._outsideClickHandler, true);
  },

  _closeMenu() {
    if (!this._menu) return;
    this._menu.remove();
    this._menu = null;
    if (this._outsideClickHandler) {
      window.document.removeEventListener('click', this._outsideClickHandler, true);
      this._outsideClickHandler = null;
    }
  },

  show() {
    const el = this._ensure();
    el.hidden = false;
  },

  hide() {
    this._closeMenu();
    if (this._el) this._el.hidden = true;
  },

  /**
   * Set the avatar face image. `url` should be the Identity avatar dataURL,
   * or a chrome:/resource: URL. A falsy value clears the inline background so
   * the CSS fallback (NevoFlux branding logo) applies.
   *
   * Defense-in-depth: this string reaches chrome DOM, so only data:/chrome:/
   * resource: schemes are accepted — http(s)/javascript/etc. are rejected and
   * fall back to the logo rather than being injected.
   */
  setImage(url) {
    const el = this._ensure();
    const face = el.querySelector('.nevoflux-agent-avatar__face');
    if (!face) return;
    if (typeof url === 'string' && url && /^(data:|chrome:|resource:)/.test(url)) {
      face.style.backgroundImage = `url("${url}")`;
    } else {
      // Falsy or disallowed scheme → clear inline style so the CSS fallback applies.
      face.style.backgroundImage = '';
    }
  },

  setState(raw) {
    const el = this._ensure();
    const [state, bubblePart] = String(raw || 'idle').split('|');
    if (['idle', 'working', 'needs-you', 'offline'].includes(state)) {
      el.setAttribute('data-state', state);
    }
    if (bubblePart && bubblePart.startsWith('bubble:')) {
      this._showBubble(bubblePart.slice('bubble:'.length));
    }
  },

  _showBubble(text) {
    const el = this._ensure();
    let b = el.querySelector('.nevoflux-agent-avatar__bubble');
    if (!b) {
      b = window.document.createElement('div');
      b.className = 'nevoflux-agent-avatar__bubble';
      el.appendChild(b);
    }
    b.textContent = text;
    b.classList.add('visible');
    clearTimeout(this._bubbleTimer);
    this._bubbleTimer = setTimeout(() => b.classList.remove('visible'), 4000);
  },
};

// Expose on the window so the nevoflux parent API can reach it.
window.NevoFluxAgentAvatar = NevoFluxAgentAvatar;
