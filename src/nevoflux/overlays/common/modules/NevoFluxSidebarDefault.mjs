/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * NevoFluxSidebarDefault — per-window startup enforcement of the
 * "Sidebar default" setting.
 *
 * The setting (config:settings → general.sidebarBehavior) is mirrored by
 * ext-nevoflux.js into the pref `extensions.nevoflux.sidebar.behavior`, which
 * this chrome module reads SYNCHRONOUSLY at window init — avoiding the
 * NevofluxContentStore's async-from-daemon load timing.
 *
 * Behaviors:
 *   'default' — first ever launch opens the sidebar once (tracked by the
 *               one-time pref extensions.nevoflux.sidebar.firstRunDone); after
 *               that, defer to Firefox's native per-window sidebar restore.
 *   'auto'    — always open the NevoFlux sidebar when a window opens.
 *   'manual'  — never auto-open; if native restore opened OUR sidebar, close it.
 *
 * The decision is a pure function (decideSidebarAction) so it is unit-testable
 * without a browser; the module tail wires it to SidebarController at window load.
 */

/**
 * @param {{behavior:string, firstRunDone:boolean, isOpen:boolean,
 *          currentID:(string|null), nevofluxSidebarId:string}} state
 * @returns {{action:'show'|'hide'|'none', markFirstRun:boolean}}
 */
export function decideSidebarAction(state) {
  const { behavior, firstRunDone, isOpen, currentID, nevofluxSidebarId } = state;
  const ourSidebarOpen = isOpen && currentID === nevofluxSidebarId;

  if (behavior === 'auto') {
    return ourSidebarOpen
      ? { action: 'none', markFirstRun: false }
      : { action: 'show', markFirstRun: false };
  }

  if (behavior === 'manual') {
    return ourSidebarOpen
      ? { action: 'hide', markFirstRun: false }
      : { action: 'none', markFirstRun: false };
  }

  // 'default' (and any unknown value → default semantics)
  if (!firstRunDone) {
    return { action: 'show', markFirstRun: true };
  }
  return { action: 'none', markFirstRun: false };
}

const PREF_BEHAVIOR = 'extensions.nevoflux.sidebar.behavior';
const PREF_FIRST_RUN = 'extensions.nevoflux.sidebar.firstRunDone';
// Chrome-side command id of the NevoFlux extension sidebar panel (same constant
// as NevoFluxAgentAvatar.mjs): makeWidgetId('agent@nevoflux.com') + '-sidebar-action'.
const NEVOFLUX_SIDEBAR_ID = 'agent_nevoflux_com-sidebar-action';

function applySidebarDefault() {
  const sc = window.SidebarController;
  if (!sc) return;

  let behavior = 'default';
  let firstRunDone = false;
  try {
    behavior = Services.prefs.getStringPref(PREF_BEHAVIOR, 'default');
    firstRunDone = Services.prefs.getBoolPref(PREF_FIRST_RUN, false);
  } catch (_e) {}

  const decision = decideSidebarAction({
    behavior,
    firstRunDone,
    isOpen: !!sc.isOpen,
    currentID: sc.currentID || null,
    nevofluxSidebarId: NEVOFLUX_SIDEBAR_ID,
  });

  try {
    if (decision.action === 'show') {
      sc.show(NEVOFLUX_SIDEBAR_ID);
    } else if (decision.action === 'hide') {
      sc.hide();
    }
  } catch (_e) {}

  if (decision.markFirstRun) {
    try {
      Services.prefs.setBoolPref(PREF_FIRST_RUN, true);
    } catch (_e) {}
  }
}

// Apply after the window's own session restore has settled. `load` mirrors the
// timing NevoFluxSidebarResize uses; SidebarController state is populated by then.
// Guarded so importing this module for unit tests (Node, no DOM) is side-effect
// free — only the pure decideSidebarAction export is exercised there.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  document.addEventListener(
    'MozBeforeInitialXULLayout',
    () => {
      window.addEventListener('load', () => applySidebarDefault(), { once: true });
    },
    { once: true }
  );
}
