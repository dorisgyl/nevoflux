/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from 'node:assert';
import { test } from 'node:test';
import { decideSidebarAction } from '../../overlays/common/modules/NevoFluxSidebarDefault.mjs';

const ID = 'agent_nevoflux_com-sidebar-action';
const base = { firstRunDone: true, isOpen: false, currentID: null, nevofluxSidebarId: ID };

test('auto: 未开则 show', () => {
  assert.deepStrictEqual(decideSidebarAction({ ...base, behavior: 'auto' }), {
    action: 'show',
    markFirstRun: false,
  });
});

test('auto: 已开我们的侧栏则 none', () => {
  assert.deepStrictEqual(
    decideSidebarAction({ ...base, behavior: 'auto', isOpen: true, currentID: ID }),
    { action: 'none', markFirstRun: false }
  );
});

test('auto: 开着别的侧栏仍 show（切到我们的）', () => {
  assert.deepStrictEqual(
    decideSidebarAction({ ...base, behavior: 'auto', isOpen: true, currentID: 'viewBookmarksSidebar' }),
    { action: 'show', markFirstRun: false }
  );
});

test('manual: 开着我们的侧栏则 hide', () => {
  assert.deepStrictEqual(
    decideSidebarAction({ ...base, behavior: 'manual', isOpen: true, currentID: ID }),
    { action: 'hide', markFirstRun: false }
  );
});

test('manual: 开着别的侧栏则 none（不动别人的）', () => {
  assert.deepStrictEqual(
    decideSidebarAction({ ...base, behavior: 'manual', isOpen: true, currentID: 'viewBookmarksSidebar' }),
    { action: 'none', markFirstRun: false }
  );
});

test('manual: 未开则 none', () => {
  assert.deepStrictEqual(decideSidebarAction({ ...base, behavior: 'manual' }), {
    action: 'none',
    markFirstRun: false,
  });
});

test('default: 首次运行则 show 并标记', () => {
  assert.deepStrictEqual(
    decideSidebarAction({ ...base, behavior: 'default', firstRunDone: false }),
    { action: 'show', markFirstRun: true }
  );
});

test('default: 非首次则 none（交给原生恢复）', () => {
  assert.deepStrictEqual(decideSidebarAction({ ...base, behavior: 'default', firstRunDone: true }), {
    action: 'none',
    markFirstRun: false,
  });
});

test('未知值 fallback 到 default 语义（首次 show）', () => {
  assert.deepStrictEqual(
    decideSidebarAction({ ...base, behavior: 'xxx', firstRunDone: false }),
    { action: 'show', markFirstRun: true }
  );
});
