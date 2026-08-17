/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Pre-grants the microphone permission to the NevoFlux agent extension.
 *
 * Why this is code and not a pref
 * -------------------------------
 * The obvious approach — seed the permission from `prefs/` or from Firefox's
 * `permissions.manager.defaultsUrl` file — cannot work. Both match on the
 * *origin string*, and an extension's origin is `moz-extension://<uuid>`
 * where the uuid is generated per profile at first install
 * (`Extension.sys.mjs`: `Services.uuid.generateUUID()`). There is no origin
 * to write down at build time.
 *
 * So the grant has to happen at runtime, once the extension policy exists and
 * its real origin can be read.
 *
 * What this does not do
 * ---------------------
 * It does not hide anything. Firefox's recording indicator is driven by
 * *active streams* (`webrtcUI._streams`, populated from
 * `recording-device-events`), never by how the permission was obtained — so
 * the address-bar and tab indicators behave exactly as they would after a
 * user clicked "Allow". That visibility is the deal: a fork granting its own
 * extension microphone access silently, with no indicator, would be
 * indefensible. The indicator is what makes this honest.
 *
 * It also never overrides a user's explicit block. If someone has denied the
 * microphone, that decision stands — re-granting it on the next window open
 * would make the setting a lie.
 */

const EXTENSION_ID = "agent@nevoflux.com";
const PERMISSION = "microphone";

/** Resolve the extension's content principal, or null if it isn't up yet. */
function extensionPrincipal() {
  const policy = WebExtensionPolicy.getByID(EXTENSION_ID);
  if (!policy) {
    return null;
  }
  try {
    const uri = Services.io.newURI(policy.getURL("/"));
    return Services.scriptSecurityManager.createContentPrincipal(uri, {});
  } catch (e) {
    console.error("[NevoFlux] mic permission: bad extension URI", e);
    return null;
  }
}

function grantOnce() {
  const principal = extensionPrincipal();
  if (!principal) {
    return false;
  }

  const { perms } = Services;
  const existing = perms.testExactPermissionFromPrincipal(principal, PERMISSION);

  // DENY_ACTION — the user said no. Leave it alone; see the note above.
  if (existing === perms.DENY_ACTION) {
    return true;
  }
  // Already granted (by us on a previous run, or by the user clicking Allow).
  if (existing === perms.ALLOW_ACTION) {
    return true;
  }

  perms.addFromPrincipal(
    principal,
    PERMISSION,
    perms.ALLOW_ACTION,
    perms.EXPIRE_NEVER
  );
  console.log(
    `[NevoFlux] microphone pre-granted to ${principal.origin} (indicator unaffected)`
  );
  return true;
}

/**
 * The extension is a built-in addon, so by the time a browser window exists it
 * is normally already started — but "normally" is not "always", and a missed
 * grant would show up as a permission prompt in the middle of a voice session.
 * Retry on the extension-ready notification rather than assuming.
 */
if (!grantOnce()) {
  let attempts = 0;
  const retry = () => {
    if (grantOnce()) {
      return;
    }
    if (++attempts >= 10) {
      console.warn(
        `[NevoFlux] microphone pre-grant gave up: ${EXTENSION_ID} never appeared`
      );
      return;
    }
    setTimeout(retry, 500);
  };
  setTimeout(retry, 500);
}
