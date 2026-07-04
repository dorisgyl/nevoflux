/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for agent-status-machine.mjs — pure tri-state derivation.
 * No DOM, no chrome, no browser.* dependencies.
 */

import { describe, it, expect } from './test-runner.mjs';
import {
  AgentUiState,
  createAgentStatusMachine,
  isCompletion,
  isNeedsYouEntry,
} from '../../extensions/nevoflux-agent/background/agent-status-machine.mjs';

describe('agent-status-machine: derivation', () => {
  it('starts idle', () => {
    const m = createAgentStatusMachine();
    expect(m.getState()).toBe(AgentUiState.IDLE);
  });

  it('idle -> working on stream_start', () => {
    const m = createAgentStatusMachine();
    const t = m.apply({ kind: 'stream_start' });
    expect(t.to).toBe(AgentUiState.WORKING);
    expect(t.changed).toBe(true);
    expect(isCompletion(t)).toBe(false);
  });

  it('working -> idle on stream_end is a completion', () => {
    const m = createAgentStatusMachine();
    m.apply({ kind: 'stream_start' });
    const t = m.apply({ kind: 'stream_end' });
    expect(t.to).toBe(AgentUiState.IDLE);
    expect(isCompletion(t)).toBe(true);
  });

  it('open ask outranks working; entry flagged', () => {
    const m = createAgentStatusMachine();
    m.apply({ kind: 'stream_start' });
    const t = m.apply({ kind: 'ask_open' });
    expect(t.to).toBe(AgentUiState.NEEDS_YOU);
    expect(isNeedsYouEntry(t)).toBe(true);
  });

  it('needs-you persists until every ask closes', () => {
    const m = createAgentStatusMachine();
    m.apply({ kind: 'stream_start' });
    m.apply({ kind: 'ask_open' });
    m.apply({ kind: 'ask_open' });
    expect(m.apply({ kind: 'ask_close' }).to).toBe(AgentUiState.NEEDS_YOU);
    expect(m.apply({ kind: 'ask_close' }).to).toBe(AgentUiState.WORKING);
  });

  it('stream_end while an ask is open stays needs-you (no false completion)', () => {
    const m = createAgentStatusMachine();
    m.apply({ kind: 'stream_start' });
    m.apply({ kind: 'ask_open' });
    const t = m.apply({ kind: 'stream_end' });
    expect(t.to).toBe(AgentUiState.NEEDS_YOU);
    expect(isCompletion(t)).toBe(false);
  });

  it('ignores unknown event kinds', () => {
    const m = createAgentStatusMachine();
    const t = m.apply({ kind: 'garbage' });
    expect(t.changed).toBe(false);
    expect(t.to).toBe(AgentUiState.IDLE);
  });
});
