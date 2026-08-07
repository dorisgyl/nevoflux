/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from './test-runner.mjs';
import { checkWebSession } from '../../extensions/nevoflux-agent/background/web-session.mjs';

const respond = (body, ok = true) => async () => ({ ok, json: async () => body });

describe('web-session', () => {
  it('reports signed in when the session body carries a user', async () => {
    const r = await checkWebSession('https://nevoflux.app', {
      fetchImpl: respond({ user: { id: 'u1' } }),
    });
    expect(r.signed_in).toBe(true);
  });

  it('reports signed out when the session body is null', async () => {
    const r = await checkWebSession('https://nevoflux.app', { fetchImpl: respond(null) });
    expect(r.signed_in).toBe(false);
  });

  it('reports signed out on a non-ok response', async () => {
    const r = await checkWebSession('https://nevoflux.app', { fetchImpl: respond(null, false) });
    expect(r.signed_in).toBe(false);
  });

  it('reports signed out when the body is not JSON', async () => {
    const r = await checkWebSession('https://nevoflux.app', {
      fetchImpl: async () => ({
        ok: true,
        json: async () => {
          throw new Error('not json');
        },
      }),
    });
    expect(r.signed_in).toBe(false);
  });

  it('propagates a fetch failure so the caller can fall back', async () => {
    let threw = false;
    try {
      await checkWebSession('https://nevoflux.app', {
        fetchImpl: async () => {
          throw new Error('network down');
        },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('hits get-session on the given origin with credentials', async () => {
    let seenUrl = null;
    let seenOpts = null;
    await checkWebSession('https://staging.example.com/', {
      fetchImpl: async (url, opts) => {
        seenUrl = url;
        seenOpts = opts;
        return { ok: true, json: async () => null };
      },
    });
    expect(seenUrl).toBe('https://staging.example.com/api/auth/get-session');
    expect(seenOpts.credentials).toBe('include');
  });
});
