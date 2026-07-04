/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * NevoFluxAgentAvatar — floating chrome avatar shown while the chat is
 * minimized. Rendered as a position:fixed element over the content area.
 * State is pushed from the extension background via the nevoflux parent API.
 */
const AVATAR_ID = 'nevoflux-agent-avatar';

export const NevoFluxAgentAvatar = {
  _el: null,

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
    return el;
  },

  show() {
    const el = this._ensure();
    el.hidden = false;
  },

  hide() {
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
