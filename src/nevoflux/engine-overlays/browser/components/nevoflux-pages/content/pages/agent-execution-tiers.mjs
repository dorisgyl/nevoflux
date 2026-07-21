/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Canonical definition of the "Agent execution" setting's tiers
 * (config:settings → general.agentExecution) plus a migration/normalizer.
 *
 * Tiers, in ascending order of what they auto-approve (each is cumulative):
 *   read-only               — browse/navigate/fetch freely; confirm every change
 *   browser-auto            — + auto-run browser interactions (click/type/…)
 *   browser-auto-local-read — + auto-read local files
 *   full-auto               — auto-run everything (no confirmations)
 *
 * This module is a node-unit-testable ES module. settings.js is a classic
 * (non-module) page script and cannot import it, so it inlines the same tier
 * list; this module is the canonical spec that the unit tests pin down.
 */

export const AGENT_EXECUTION_TIERS = Object.freeze([
  'read-only',
  'browser-auto',
  'browser-auto-local-read',
  'full-auto',
]);

export const DEFAULT_AGENT_EXECUTION_TIER = 'read-only';

/**
 * Coerce any stored/legacy value to a valid tier.
 *
 * Legacy dead-stub values ('confirm', 'auto') and anything unrecognized fall
 * back to the safest tier. Critically, the old 'auto' (Auto-execute) does NOT
 * map to 'full-auto': that setting never took effect, so preserving it would be
 * a silent, unexpected grant of full permissions.
 *
 * @param {unknown} value
 * @returns {string} one of AGENT_EXECUTION_TIERS
 */
export function normalizeAgentExecutionTier(value) {
  return AGENT_EXECUTION_TIERS.includes(value) ? value : DEFAULT_AGENT_EXECUTION_TIER;
}
