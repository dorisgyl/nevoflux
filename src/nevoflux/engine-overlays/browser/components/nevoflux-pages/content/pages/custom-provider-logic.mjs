/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * DOM-free logic backing the Custom Providers group on nevoflux://settings.
 *
 * Kept separate from settings.js so it can be unit-tested without a browser.
 * settings.js imports it dynamically from chrome://nevoflux/content/pages/.
 */

/** Wire protocols the daemon's CustomWire enum accepts. */
const WIRES = ['openai', 'anthropic'];

/** Which grid a config.llm.list entry belongs in. */
export function routeProviderToGrid(provider) {
  if (provider.is_custom) {
    return 'custom';
  }
  if (provider.type === 'cli' || provider.type === 'agent') {
    return 'agents';
  }
  return 'llm';
}

/**
 * Validate the custom-provider form.
 *
 * The API key is deliberately optional: a local OpenAI-compatible server
 * (llama.cpp, vLLM, LM Studio) usually has no auth. The base URL is what makes
 * the provider usable, so that is the required field — and it is what the
 * daemon's `is_provider_configured` checks for a custom provider.
 */
export function validateCustomForm(form) {
  const errors = {};

  if (!String(form.displayName || '').trim()) {
    errors.displayName = 'Name is required.';
  }
  if (!WIRES.includes(form.wire)) {
    errors.wire = 'Pick an API type.';
  }

  const baseUrl = String(form.baseUrl || '').trim();
  if (!baseUrl) {
    errors.baseUrl = 'Base URL is required.';
  } else if (!/^https?:\/\/./i.test(baseUrl)) {
    errors.baseUrl = 'Base URL must start with http:// or https://';
  }

  const cw = String(form.contextWindow ?? '').trim();
  if (cw && !/^\d+$/.test(cw)) {
    errors.contextWindow = 'Context window must be a whole number.';
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Map the form onto config.llm.custom.create / .update params.
 *
 * A blank API key is omitted rather than sent as an empty string, so the
 * daemon keeps whatever key is already stored — the same "leave blank to keep
 * current" contract the builtin provider modal uses.
 */
export function buildCustomParams(form, { isCreate, id } = {}) {
  const params = {
    display_name: String(form.displayName || '').trim(),
    wire: form.wire,
    base_url: String(form.baseUrl || '').trim(),
    model: String(form.model || '').trim(),
    use_streaming: !!form.useStreaming,
    set_active: !!form.setActive,
  };

  if (!isCreate && id) {
    params.id = id;
  }

  const apiKey = String(form.apiKey || '').trim();
  if (apiKey) {
    params.api_key = apiKey;
  }

  const cw = String(form.contextWindow ?? '').trim();
  if (cw) {
    params.context_window = Number(cw);
  }

  const accent = String(form.accent || '').trim();
  if (accent) {
    params.accent = accent;
  }

  return params;
}

/** First character of the display name, for the icon tile. */
export function providerInitial(displayName) {
  const name = String(displayName || '').trim();
  if (!name) {
    return '?';
  }
  return [...name][0].toUpperCase();
}

/** Human-readable label for a wire protocol. */
export function wireLabel(wire) {
  return wire === 'anthropic' ? 'anthropic' : 'openai-compatible';
}

/**
 * What the delete confirmation needs to say.
 *
 * Mirrors the daemon's fallback rule (first other configured provider, in the
 * order config.llm.list returns them) so the dialog names the provider that
 * will actually become active.
 */
export function deleteWarning(provider, providers) {
  if (!provider.active) {
    return { active: false, fallbackName: null };
  }
  const fallback = providers.find((p) => p.id !== provider.id && p.configured);
  return {
    active: true,
    fallbackName: fallback ? fallback.display_name || fallback.id : null,
  };
}
