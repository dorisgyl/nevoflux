/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Pure tri-state agent UI-state machine.
 *
 * Consumes normalized events (kind: stream_start | stream_end | ask_open |
 * ask_close) and derives idle | working | needs-you. Kept wire-format-free so
 * it is unit-testable; the background maps real daemon messages -> events.
 */

export const AgentUiState = Object.freeze({
  IDLE: 'idle',
  WORKING: 'working',
  NEEDS_YOU: 'needs-you',
});

export function createAgentStatusMachine() {
  let streaming = false;
  let openAsks = 0;
  let state = AgentUiState.IDLE;

  function derive() {
    if (openAsks > 0) return AgentUiState.NEEDS_YOU;
    if (streaming) return AgentUiState.WORKING;
    return AgentUiState.IDLE;
  }

  function apply(event) {
    const from = state;
    switch (event && event.kind) {
      case 'stream_start': streaming = true; break;
      case 'stream_end': streaming = false; break;
      case 'ask_open': openAsks += 1; break;
      case 'ask_close': openAsks = Math.max(0, openAsks - 1); break;
      default: break; // ignore unknown
    }
    state = derive();
    return { from, to: state, changed: state !== from };
  }

  return {
    apply,
    getState: () => state,
    reset: () => { streaming = false; openAsks = 0; state = AgentUiState.IDLE; },
  };
}

/** Completion = a working -> idle transition. */
export function isCompletion(t) {
  return t.changed && t.from === AgentUiState.WORKING && t.to === AgentUiState.IDLE;
}

/** needs-you entry = any -> needs-you transition. */
export function isNeedsYouEntry(t) {
  return t.changed && t.to === AgentUiState.NEEDS_YOU;
}
