/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert';
import { test } from 'node:test';
import { decideSidebarAction } from '../../overlays/common/modules/NevoFluxSidebarDefault.mjs';

// decideSidebarAction is intent-only: it maps (behavior, firstRunDone) to an
// action. The live sidebar state is intentionally NOT an input — at apply time
// the extension sidebar has not registered/restored yet, so the imperative
// layer reconciles against the real post-restore state.

test('auto → show', () => {
  assert.deepStrictEqual(decideSidebarAction({ behavior: 'auto', firstRunDone: true }), {
    action: 'show',
    markFirstRun: false,
  });
  // firstRunDone does not affect auto.
  assert.deepStrictEqual(decideSidebarAction({ behavior: 'auto', firstRunDone: false }), {
    action: 'show',
    markFirstRun: false,
  });
});

test('manual → hide', () => {
  assert.deepStrictEqual(decideSidebarAction({ behavior: 'manual', firstRunDone: true }), {
    action: 'hide',
    markFirstRun: false,
  });
  assert.deepStrictEqual(decideSidebarAction({ behavior: 'manual', firstRunDone: false }), {
    action: 'hide',
    markFirstRun: false,
  });
});

test('default: first run → show and mark', () => {
  assert.deepStrictEqual(decideSidebarAction({ behavior: 'default', firstRunDone: false }), {
    action: 'show',
    markFirstRun: true,
  });
});

test('default: non-first run → none (defer to native restore)', () => {
  assert.deepStrictEqual(decideSidebarAction({ behavior: 'default', firstRunDone: true }), {
    action: 'none',
    markFirstRun: false,
  });
});

test('unknown value falls back to default semantics (first run → show)', () => {
  assert.deepStrictEqual(decideSidebarAction({ behavior: 'xxx', firstRunDone: false }), {
    action: 'show',
    markFirstRun: true,
  });
});

test('unknown value, non-first run → none', () => {
  assert.deepStrictEqual(decideSidebarAction({ behavior: 'xxx', firstRunDone: true }), {
    action: 'none',
    markFirstRun: false,
  });
});
