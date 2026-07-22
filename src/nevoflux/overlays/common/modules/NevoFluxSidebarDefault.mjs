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
  const { behavior, firstRunDone } = state;

  // Intent only — NOT the live sidebar state. At apply time the extension
  // sidebar has not registered/restored yet, so isOpen/currentID are unreliable
  // (that snapshot said "closed" even when the restore was about to reopen our
  // sidebar). The imperative layer reconciles against the real, post-restore
  // state: 'show' polls until registered then shows; 'hide' watches for the
  // restore and closes our sidebar if it reappears.
  if (behavior === 'auto') {
    return { action: 'show', markFirstRun: false };
  }
  if (behavior === 'manual') {
    return { action: 'hide', markFirstRun: false };
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

/**
 * Open the NevoFlux sidebar once its WebExtension command is registered.
 *
 * SidebarController.show(id) silently returns false (no throw) when `id` is not
 * yet in the sidebars registry — and the nevoflux-agent extension registers its
 * `sidebar_action` command AFTER window load, so an immediate show() no-ops.
 * Poll the registry (SidebarItemAdded also fires, but polling is simplest and
 * robust across registration paths) and show as soon as it appears.
 */
async function showWhenRegistered(sc, id) {
  // Wait for the extension sidebar command to register (show() silently no-ops
  // for an unregistered id).
  const regDeadline = Date.now() + 15000;
  while (Date.now() < regDeadline && !(sc.sidebars && sc.sidebars.has(id))) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!(sc.sidebars && sc.sidebars.has(id))) {
    console.warn('[NevoFluxSidebarDefault] sidebar not registered within 15s — not shown');
    return;
  }
  // Show repeatedly until the sidebar has stayed open for a stable stretch. Two
  // reasons a single show() is not enough:
  //  - the native restore can override it in a burst over the first ~2s;
  //  - the FIRST sc.show() promise sometimes never resolves (a panel-load race),
  //    so fire WITHOUT awaiting (awaiting stalls the whole loop) and just re-check
  //    state next tick — a subsequent show() call then opens it.
  // Stop once stably open so we don't fight a user who closes it right after.
  const STABLE_TICKS = 6; // ~6 * 250ms = 1.5s continuously open
  const hardDeadline = Date.now() + 10000;
  let stableOpen = 0;
  while (Date.now() < hardDeadline && stableOpen < STABLE_TICKS) {
    if (sc.currentID === id && sc.isOpen) {
      stableOpen++;
    } else {
      stableOpen = 0;
      try {
        Promise.resolve(sc.show(id)).catch(() => {});
      } catch (_e) {}
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Keep the NevoFlux sidebar closed for "Manual only".
 *
 * The extension sidebar registers AND the native session-restore reopens it
 * AFTER window load — so at apply time our sidebar is not open yet, but it may
 * become open a beat later. Wait for registration, then watch briefly and close
 * OUR sidebar if the restore reopens it. The watch window is short so we don't
 * fight a user who opens it themselves right after startup.
 */
async function suppressNevofluxSidebar(sc, id) {
  // Wait for the extension sidebar to register (its restore happens around then).
  const regDeadline = Date.now() + 15000;
  while (Date.now() < regDeadline && !(sc.sidebars && sc.sidebars.has(id))) {
    await new Promise((r) => setTimeout(r, 200));
  }
  // The native session-restore reopens our sidebar in a BURST over the first
  // ~2s after registration, and a single hide gets re-overridden (observed:
  // 3 reopens ~400ms apart, then stable). So hide repeatedly until it has stayed
  // closed for a stable stretch, then stop — so we don't fight a user who opens
  // it themselves later. Hard cap as a backstop.
  const STABLE_TICKS = 6; // ~6 * 250ms = 1.5s continuously closed
  const hardDeadline = Date.now() + 10000;
  let stableClosed = 0;
  while (Date.now() < hardDeadline && stableClosed < STABLE_TICKS) {
    if (sc.currentID === id && sc.isOpen) {
      stableClosed = 0;
      // Fire-and-forget (mirrors showWhenRegistered): don't await hide()'s
      // promise, which can hang; re-check state next tick.
      try {
        Promise.resolve(sc.hide()).catch(() => {});
      } catch (_e) {}
    } else {
      stableClosed++;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function applySidebarDefault() {
  const sc = window.SidebarController;
  if (!sc) return;

  // Wait until the sidebar's own init + session restore has finished, so our
  // show()/hide() applies AFTER the restored state rather than being overridden
  // by the native restore that runs during SidebarController.init().
  try {
    if (sc.promiseInitialized) {
      await sc.promiseInitialized;
    }
  } catch (_e) {}

  let behavior = 'default';
  let firstRunDone = false;
  try {
    behavior = Services.prefs.getStringPref(PREF_BEHAVIOR, 'default');
    firstRunDone = Services.prefs.getBoolPref(PREF_FIRST_RUN, false);
  } catch (_e) {}

  const decision = decideSidebarAction({ behavior, firstRunDone });

  if (decision.action === 'show') {
    await showWhenRegistered(sc, NEVOFLUX_SIDEBAR_ID);
  } else if (decision.action === 'hide') {
    await suppressNevofluxSidebar(sc, NEVOFLUX_SIDEBAR_ID);
  }

  if (decision.markFirstRun) {
    try {
      Services.prefs.setBoolPref(PREF_FIRST_RUN, true);
    } catch (_e) {}
  }
}

// Run once the window has loaded. Module scripts are deferred, so
// MozBeforeInitialXULLayout may already have fired by the time this runs —
// don't depend on it; use the load state directly.
// Guarded so importing this module for unit tests (Node, no DOM) is side-effect
// free — only the pure decideSidebarAction export is exercised there.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'complete') {
    applySidebarDefault();
  } else {
    window.addEventListener('load', () => applySidebarDefault(), { once: true });
  }
}
