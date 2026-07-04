/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from './test-runner.mjs';
import { promptFor } from '../../extensions/nevoflux-agent/background/avatar-prompt-policy.mjs';
import { createAgentStatusMachine } from '../../extensions/nevoflux-agent/background/agent-status-machine.mjs';

function completion() {
  const m = createAgentStatusMachine();
  m.apply({ kind: 'stream_start' });
  return m.apply({ kind: 'stream_end' });
}
function needsYou() {
  const m = createAgentStatusMachine();
  m.apply({ kind: 'stream_start' });
  return m.apply({ kind: 'ask_open' });
}

describe('avatar-prompt-policy', () => {
  it('no prompt for a non-notable transition', () => {
    const m = createAgentStatusMachine();
    expect(promptFor(m.apply({ kind: 'stream_start' }), true)).toBe(null);
  });

  it('completion -> bubble only when focused', () => {
    const p = promptFor(completion(), true);
    expect(p.kind).toBe('completion');
    expect(p.bubble).toBe('✓ 任务完成');
    expect(p.os).toBe(false);
  });

  it('completion -> OS escalation when unfocused', () => {
    expect(promptFor(completion(), false).os).toBe(true);
  });

  it('needs-you -> correct copy, escalates when unfocused', () => {
    const p = promptFor(needsYou(), false);
    expect(p.kind).toBe('needs-you');
    expect(p.bubble).toBe('❗ 需要确认');
    expect(p.os).toBe(true);
  });
});
