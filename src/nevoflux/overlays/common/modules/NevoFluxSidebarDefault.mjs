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
