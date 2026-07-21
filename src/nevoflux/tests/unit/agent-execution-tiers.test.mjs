/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert';
import { test } from 'node:test';
import {
  AGENT_EXECUTION_TIERS,
  DEFAULT_AGENT_EXECUTION_TIER,
  normalizeAgentExecutionTier,
} from '../../engine-overlays/browser/components/nevoflux-pages/content/pages/agent-execution-tiers.mjs';

test('the four tiers are defined in ascending-privilege order', () => {
  assert.deepStrictEqual(AGENT_EXECUTION_TIERS, [
    'read-only',
    'browser-auto',
    'browser-auto-local-read',
    'full-auto',
  ]);
});

test('default tier is the safest (read-only)', () => {
  assert.strictEqual(DEFAULT_AGENT_EXECUTION_TIER, 'read-only');
});

test('valid tiers pass through unchanged', () => {
  for (const t of AGENT_EXECUTION_TIERS) {
    assert.strictEqual(normalizeAgentExecutionTier(t), t);
  }
});

test('SAFETY: legacy "auto" (old Auto-execute) must NOT become full-auto', () => {
  // The old dead-stub setting had value 'auto'; it never actually took effect,
  // so silently upgrading it to full-auto would be a surprise permission grant.
  assert.strictEqual(normalizeAgentExecutionTier('auto'), 'read-only');
  assert.notStrictEqual(normalizeAgentExecutionTier('auto'), 'full-auto');
});

test('legacy "confirm" maps to read-only', () => {
  assert.strictEqual(normalizeAgentExecutionTier('confirm'), 'read-only');
});

test('unknown / empty / nullish values fall back to read-only', () => {
  assert.strictEqual(normalizeAgentExecutionTier('xxx'), 'read-only');
  assert.strictEqual(normalizeAgentExecutionTier(''), 'read-only');
  assert.strictEqual(normalizeAgentExecutionTier(undefined), 'read-only');
  assert.strictEqual(normalizeAgentExecutionTier(null), 'read-only');
});
