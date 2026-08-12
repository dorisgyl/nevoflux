/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for custom-provider-logic.mjs — the DOM-free logic backing the
 * Custom Providers group on nevoflux://settings.
 */

import { describe, it, expect } from './test-runner.mjs';
import {
  routeProviderToGrid,
  validateCustomForm,
  buildCustomParams,
  providerInitial,
  wireLabel,
  deleteWarning,
} from '../../engine-overlays/browser/components/nevoflux-pages/content/pages/custom-provider-logic.mjs';

describe('custom-provider-logic: routeProviderToGrid', () => {
  it('routes custom providers to the custom grid', () => {
    expect(routeProviderToGrid({ id: 'custom:x', is_custom: true, type: 'custom' })).toBe('custom');
  });

  it('routes cli and agent providers to the agents grid', () => {
    expect(routeProviderToGrid({ id: 'claude-code', type: 'cli' })).toBe('agents');
    expect(routeProviderToGrid({ id: 'openclaw', type: 'agent' })).toBe('agents');
  });

  it('routes service and local providers to the llm grid', () => {
    expect(routeProviderToGrid({ id: 'openai', type: 'service' })).toBe('llm');
    expect(routeProviderToGrid({ id: 'ollama', type: 'local' })).toBe('llm');
  });

  it('prefers is_custom over type', () => {
    expect(routeProviderToGrid({ id: 'custom:x', is_custom: true, type: 'service' })).toBe('custom');
  });
});

describe('custom-provider-logic: validateCustomForm', () => {
  const good = {
    displayName: 'My LLM',
    wire: 'openai',
    apiKey: '',
    model: 'gpt-4o',
    baseUrl: 'https://api.example.com/v1',
    contextWindow: '32768',
    useStreaming: true,
    accent: '#7c5cff',
    setActive: true,
  };

  it('accepts a complete form', () => {
    expect(validateCustomForm(good).ok).toBe(true);
  });

  it('accepts an empty API key', () => {
    expect(validateCustomForm({ ...good, apiKey: '' }).ok).toBe(true);
  });

  it('requires a display name', () => {
    const r = validateCustomForm({ ...good, displayName: '   ' });
    expect(r.ok).toBe(false);
    expect(r.errors.displayName).toBeTruthy();
  });

  it('requires a base URL', () => {
    const r = validateCustomForm({ ...good, baseUrl: '' });
    expect(r.ok).toBe(false);
    expect(r.errors.baseUrl).toBeTruthy();
  });

  it('rejects a base URL without a scheme', () => {
    const r = validateCustomForm({ ...good, baseUrl: 'api.example.com/v1' });
    expect(r.ok).toBe(false);
    expect(r.errors.baseUrl).toBeTruthy();
  });

  it('rejects an unknown wire', () => {
    const r = validateCustomForm({ ...good, wire: 'grpc' });
    expect(r.ok).toBe(false);
    expect(r.errors.wire).toBeTruthy();
  });

  it('rejects a non-numeric context window', () => {
    const r = validateCustomForm({ ...good, contextWindow: 'lots' });
    expect(r.ok).toBe(false);
    expect(r.errors.contextWindow).toBeTruthy();
  });

  it('accepts an empty context window', () => {
    expect(validateCustomForm({ ...good, contextWindow: '' }).ok).toBe(true);
  });
});

describe('custom-provider-logic: buildCustomParams', () => {
  const form = {
    displayName: '  My LLM  ',
    wire: 'anthropic',
    apiKey: 'sk-1',
    model: 'claude-sonnet-4',
    baseUrl: ' https://api.example.com ',
    contextWindow: '200000',
    useStreaming: false,
    accent: '#7c5cff',
    setActive: true,
  };

  it('trims and maps every field on create', () => {
    const p = buildCustomParams(form, { isCreate: true });
    expect(p.display_name).toBe('My LLM');
    expect(p.wire).toBe('anthropic');
    expect(p.api_key).toBe('sk-1');
    expect(p.model).toBe('claude-sonnet-4');
    expect(p.base_url).toBe('https://api.example.com');
    expect(p.context_window).toBe(200000);
    expect(p.use_streaming).toBe(false);
    expect(p.accent).toBe('#7c5cff');
    expect(p.set_active).toBe(true);
    expect('id' in p).toBe(false);
  });

  it('omits api_key entirely when blank on update, so the stored key survives', () => {
    const p = buildCustomParams({ ...form, apiKey: '' }, { isCreate: false, id: 'custom:my-llm' });
    expect('api_key' in p).toBe(false);
    expect(p.id).toBe('custom:my-llm');
  });

  it('omits a blank api_key on create too', () => {
    const p = buildCustomParams({ ...form, apiKey: '' }, { isCreate: true });
    expect('api_key' in p).toBe(false);
  });

  it('omits context_window when blank', () => {
    const p = buildCustomParams({ ...form, contextWindow: '' }, { isCreate: true });
    expect('context_window' in p).toBe(false);
  });

  it('omits accent when the default swatch is picked', () => {
    const p = buildCustomParams({ ...form, accent: '' }, { isCreate: true });
    expect('accent' in p).toBe(false);
  });
});

describe('custom-provider-logic: providerInitial and wireLabel', () => {
  it('takes the first character, uppercased', () => {
    expect(providerInitial('My LLM')).toBe('M');
  });

  it('handles a CJK name', () => {
    expect(providerInitial('本地站')).toBe('本');
  });

  it('falls back for an empty name', () => {
    expect(providerInitial('')).toBe('?');
  });

  it('labels the wire for humans', () => {
    expect(wireLabel('openai')).toBe('openai-compatible');
    expect(wireLabel('anthropic')).toBe('anthropic');
  });
});

describe('custom-provider-logic: deleteWarning', () => {
  const providers = [
    { id: 'anthropic', display_name: 'Anthropic', configured: true, active: false },
    { id: 'custom:mine', display_name: 'My LLM', configured: true, active: true, is_custom: true },
  ];

  it('names the fallback when deleting the active provider', () => {
    const w = deleteWarning(providers[1], providers);
    expect(w.active).toBe(true);
    expect(w.fallbackName).toBe('Anthropic');
  });

  it('reports no warning for a non-active provider', () => {
    const w = deleteWarning(providers[0], providers);
    expect(w.active).toBe(false);
    expect(w.fallbackName).toBeNull();
  });

  it('reports a null fallback when nothing else is configured', () => {
    const only = [
      { id: 'custom:mine', display_name: 'My LLM', configured: true, active: true, is_custom: true },
    ];
    const w = deleteWarning(only[0], only);
    expect(w.active).toBe(true);
    expect(w.fallbackName).toBeNull();
  });

  it('skips unconfigured providers when picking the fallback', () => {
    const list = [
      { id: 'openai', display_name: 'OpenAI', configured: false, active: false },
      { id: 'anthropic', display_name: 'Anthropic', configured: true, active: false },
      { id: 'custom:mine', display_name: 'My LLM', configured: true, active: true, is_custom: true },
    ];
    expect(deleteWarning(list[2], list).fallbackName).toBe('Anthropic');
  });
});
