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
 *   恢复 (restore), 最大化 (maximize), 关闭 (close).
 * Actions are routed to the extension background via NevofluxBridgeRouter.
 */

const { NevofluxBridgeRouter } = ChromeUtils.importESModule(
  'resource:///modules/NevofluxBridgeRouter.sys.mjs'
);

const AVATAR_ID = 'nevoflux-agent-avatar';
const PREF_X = 'extensions.nevoflux.avatar.x';
const PREF_Y = 'extensions.nevoflux.avatar.y';
const DRAG_THRESHOLD = 4; // pixels

export const NevoFluxAgentAvatar = {
  _el: null,
  _wasDrag: false,
  _menu: null,
  _outsideClickHandler: null,

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
      const x = Services.prefs.getIntPref(PREF_X, -1);
      const y = Services.prefs.getIntPref(PREF_Y, -1);
      if (x >= 0 && y >= 0) {
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
      const x = Math.max(0, e.clientX - ox);
      const y = Math.max(0, e.clientY - oy);
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
   * Items: 恢复 / 最大化 / 关闭 (Chinese labels, per product decision).
   */
  _openMenu() {
    this._closeMenu(); // guard against doubles
    const doc = window.document;
    const menu = doc.createElement('div');
    menu.className = 'nevoflux-agent-avatar-menu';

    const items = [
      {
        label: '恢复',
        handler: () => {
          NevofluxBridgeRouter.request('avatar:restore', {}).catch(() => {});
          this._closeMenu();
        },
      },
      {
        label: '最大化',
        handler: () => {
          NevofluxBridgeRouter.request('avatar:maximize', {}).catch(() => {});
          this._closeMenu();
        },
      },
      {
        label: '关闭',
        handler: () => {
          const state = this._el.getAttribute('data-state');
          if (state === 'working' || state === 'needs-you') {
            // eslint-disable-next-line no-alert
            const ok = Services.prompt.confirm(
              window,
              'NevoFlux',
              'The agent is still working. Close anyway?'
            );
            if (!ok) return;
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
      if (!menu.contains(e.target) && e.target !== this._el) {
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

  setState(raw) {
    const el = this._ensure();
    const state = String(raw || 'idle').split('|')[0];
    if (['idle', 'working', 'needs-you', 'offline'].includes(state)) {
      el.setAttribute('data-state', state);
    }
  },
};

// Expose on the window so the nevoflux parent API can reach it.
window.NevoFluxAgentAvatar = NevoFluxAgentAvatar;
