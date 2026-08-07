/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Whether the browser currently holds a signed-in session on a NevoFlux
 * account host.
 *
 * Only the extension can answer this: the probe needs the user's cookies, and
 * the daemon has none. better-auth's `/api/auth/get-session` answers HTTP 200
 * with a `null` body when signed out, so a bare status check is not enough —
 * the body decides.
 *
 * Rejects when the request itself fails, so callers can tell "signed out" apart
 * from "could not find out" and word their prompt accordingly.
 *
 * @param {string} origin Scheme + host, e.g. `https://nevoflux.app`.
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<{signed_in: boolean}>}
 */
export async function checkWebSession(origin, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const url = `${String(origin).replace(/\/+$/, '')}/api/auth/get-session`;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      credentials: 'include',
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) return { signed_in: false };
    const body = await res.json().catch(() => null);
    return { signed_in: !!(body && body.user) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
