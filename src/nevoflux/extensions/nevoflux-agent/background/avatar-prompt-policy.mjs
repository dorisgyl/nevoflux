/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Decide whether/how to prompt for an avatar state transition. */
import { isCompletion, isNeedsYouEntry } from './agent-status-machine.mjs';

const COPY = { completion: '✓ 任务完成', 'needs-you': '❗ 需要确认' };

export function promptFor(transition, windowFocused) {
  let kind = null;
  if (isNeedsYouEntry(transition)) kind = 'needs-you';
  else if (isCompletion(transition)) kind = 'completion';
  if (!kind) return null;
  return { kind, bubble: COPY[kind], os: windowFocused === false };
}
