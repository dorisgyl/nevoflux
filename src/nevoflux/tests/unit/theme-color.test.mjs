/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for wasm/chat-sidebar/theme-color.mjs (pure color math).
 * hslToRgb/rgbToHsl must stay formula-identical to ZenBoostsChild.sys.mjs
 * so the sidebar accent matches what the boost backend paints on the page.
 */

import { describe, it, expect } from './test-runner.mjs';
import {
  hslToRgb,
  rgbToHsl,
  clampLightness,
  computeThemeVars,
} from '../../extensions/nevoflux-agent/wasm/chat-sidebar/theme-color.mjs';

describe('theme-color: hslToRgb (formula parity with ZenBoostsChild)', () => {
  it('converts achromatic (s=0)', () => {
    expect(hslToRgb(0, 0, 0.5)).toEqual([128, 128, 128]);
  });

  it('converts pure red hue', () => {
    expect(hslToRgb(0, 1, 0.5)).toEqual([255, 0, 0]);
  });

  it('converts the default boost hue with boost modifiers applied', () => {
    // h = dotAngleDeg 131.61 / 360, s = 1 - 0.5, l = 0.1 + 0.9 * 0.5
    expect(hslToRgb(131.61 / 360, 0.5, 0.55)).toEqual([83, 198, 105]);
  });

  it('roundtrips through rgbToHsl', () => {
    const [h, s, l] = rgbToHsl(26, 107, 107);
    expect(hslToRgb(h, s, l)).toEqual([26, 107, 107]);
  });
});

describe('theme-color: clampLightness', () => {
  it('raises too-dark accents in dark scheme', () => {
    expect(clampLightness(0.2, 'dark')).toBe(0.55);
  });

  it('caps too-bright accents in dark scheme', () => {
    expect(clampLightness(0.95, 'dark')).toBe(0.8);
  });

  it('lowers too-bright accents in light scheme', () => {
    expect(clampLightness(0.9, 'light')).toBe(0.6);
  });

  it('raises too-dark accents in light scheme', () => {
    expect(clampLightness(0.05, 'light')).toBe(0.3);
  });

  it('passes through in-range values', () => {
    expect(clampLightness(0.5, 'light')).toBe(0.5);
    expect(clampLightness(0.7, 'dark')).toBe(0.7);
  });
});

describe('theme-color: computeThemeVars', () => {
  const baseCtx = {
    colorScheme: 'light',
    domain: 'example.com',
    boost: null,
    spacePrimaryRgb: null,
  };

  it('returns default accent (null vars) when no boost and no space color', () => {
    const v = computeThemeVars(baseCtx);
    expect(v.scheme).toBe('light');
    expect(v.accentSource).toBe('default');
    expect(v.accent).toBe(null);
    expect(v.accentHover).toBe(null);
    expect(v.accentLight).toBe(null);
    expect(v.accentLighter).toBe(null);
  });

  it('derives the boost accent via the ZenBoostsChild formula', () => {
    const v = computeThemeVars({
      ...baseCtx,
      boost: { autoTheme: false, dotAngleDeg: 131.61, saturation: 0.5, brightness: 0.5 },
    });
    expect(v.accentSource).toBe('boost');
    // raw l = 0.1 + 0.9*0.5 = 0.55, inside light range [0.3, 0.6] → unclamped
    expect(v.accent).toBe('#53c669');
    expect(v.accentLight).toBe('rgba(83, 198, 105, 0.12)');
    expect(v.accentLighter).toBe('rgba(83, 198, 105, 0.08)');
  });

  it('hover is a darker variant (l - 0.08)', () => {
    const v = computeThemeVars({
      ...baseCtx,
      boost: { autoTheme: false, dotAngleDeg: 131.61, saturation: 0.5, brightness: 0.5 },
    });
    // l = 0.55 - 0.08 = 0.47
    expect(v.accentHover).toBe('#3cb453');
  });

  it('autoTheme boost takes hue from spacePrimaryRgb but keeps boost s/l modifiers', () => {
    const v = computeThemeVars({
      ...baseCtx,
      boost: { autoTheme: true, dotAngleDeg: 0, saturation: 0.5, brightness: 0.5 },
      spacePrimaryRgb: [26, 107, 107], // teal → hue 0.5
    });
    expect(v.accentSource).toBe('boost');
    expect(v.accent).toBe('#53c6c6');
  });

  it('falls back to the space primary color when no boost', () => {
    const v = computeThemeVars({ ...baseCtx, spacePrimaryRgb: [26, 107, 107] });
    expect(v.accentSource).toBe('space');
    // rgb(26,107,107) → l ≈ 0.26 → light clamp to 0.3
    expect(v.accent).toBe('#1e7b7b');
  });

  it('clamps dark-scheme accents brighter', () => {
    const v = computeThemeVars({
      ...baseCtx,
      colorScheme: 'dark',
      boost: { autoTheme: false, dotAngleDeg: 200, saturation: 0.2, brightness: 0.1 },
    });
    expect(v.scheme).toBe('dark');
    // s = 1-0.2 = 0.8, raw l = 0.1+0.9*0.1 = 0.19 → dark clamp to 0.55
    expect(v.accent).toBe('#30abe8');
  });

  it('normalizes out-of-range hue degrees', () => {
    const a = computeThemeVars({
      ...baseCtx,
      boost: { autoTheme: false, dotAngleDeg: 491.61, saturation: 0.5, brightness: 0.5 },
    });
    const b = computeThemeVars({
      ...baseCtx,
      boost: { autoTheme: false, dotAngleDeg: 131.61, saturation: 0.5, brightness: 0.5 },
    });
    expect(a.accent).toBe(b.accent);
  });

  it('smartInvert forces dark scheme over Website appearance', () => {
    const v = computeThemeVars({
      ...baseCtx,
      colorScheme: 'light',
      boost: { enableColorBoost: false, smartInvert: true },
    });
    expect(v.scheme).toBe('dark');
  });

  it('boost with enableColorBoost=false falls back to space accent but keeps font/zoom', () => {
    const v = computeThemeVars({
      ...baseCtx,
      spacePrimaryRgb: [26, 107, 107],
      boost: {
        enableColorBoost: false,
        smartInvert: false,
        fontFamily: 'Comic Sans MS',
        sizeOverride: 1.2,
      },
    });
    expect(v.accentSource).toBe('space');
    expect(v.overrides['--nevo-font-family']).toBe('Comic Sans MS');
    expect(v.overrides['--nf-zoom']).toBe('1.2');
    // tint/contrast are color-boost-only
    expect(v.overrides['--nevo-background']).toBe(undefined);
    expect(v.overrides['--nevo-text']).toBe(undefined);
  });

  it('tints surfaces toward the accent when color boost is on (light bases)', () => {
    const v = computeThemeVars({
      ...baseCtx,
      boost: {
        enableColorBoost: true,
        autoTheme: false,
        dotAngleDeg: 131.61,
        saturation: 0.5,
        brightness: 0.5,
        contrast: 0.75,
      },
    });
    // accent #53c669; bg 6% / surface 8% / hover 10% / active 12%
    expect(v.overrides['--nevo-background']).toBe('#f5fcf6');
    expect(v.overrides['--nevo-surface']).toBe('#e6f0eb');
    expect(v.overrides['--nevo-surface-hover']).toBe('#d6e4de');
    expect(v.overrides['--nevo-surface-active']).toBe('#c2d3cd');
    // contrast 0.75 is neutral → no text/border overrides
    expect(v.overrides['--nevo-text']).toBe(undefined);
    expect(v.overrides['--nevo-border']).toBe(undefined);
  });

  it('contrast gain pushes text/border toward the pole (light, c=1)', () => {
    const v = computeThemeVars({
      ...baseCtx,
      boost: {
        enableColorBoost: true,
        autoTheme: false,
        dotAngleDeg: 131.61,
        saturation: 0.5,
        brightness: 0.5,
        contrast: 1,
      },
    });
    expect(v.overrides['--nevo-text']).toBe('#141b24');
    expect(v.overrides['--nevo-text-secondary']).toBe('#353c45');
    expect(v.overrides['--nevo-border']).toBe('#acadb0');
  });

  it('contrast loss pulls text toward mid-gray on dark bases (smartInvert + c=0.25)', () => {
    const v = computeThemeVars({
      ...baseCtx,
      colorScheme: 'light',
      boost: {
        enableColorBoost: true,
        autoTheme: false,
        dotAngleDeg: 131.61,
        saturation: 0.5,
        brightness: 0.5,
        contrast: 0.25,
        smartInvert: true,
      },
    });
    expect(v.scheme).toBe('dark');
    expect(v.overrides['--nevo-text']).toBe('#ced0d1');
    expect(v.overrides['--nevo-text-secondary']).toBe('#aaaeb5');
    expect(v.overrides['--nevo-border']).toBe('#34393e');
  });

  it('clamps zoom to [0.5, 2] and drops no-op zoom', () => {
    const mk = (sizeOverride) =>
      computeThemeVars({ ...baseCtx, boost: { enableColorBoost: false, sizeOverride } });
    expect(mk(3).overrides['--nf-zoom']).toBe('2');
    expect(mk(0.3).overrides['--nf-zoom']).toBe('0.5');
    expect(mk(1).overrides['--nf-zoom']).toBe(undefined);
    expect(mk(1.005).overrides['--nf-zoom']).toBe(undefined);
  });

  it('returns empty overrides without a boost', () => {
    const v = computeThemeVars({ ...baseCtx, spacePrimaryRgb: [26, 107, 107] });
    expect(Object.keys(v.overrides).length).toBe(0);
  });

  it('survives malformed ctx without throwing', () => {
    expect(computeThemeVars(null).scheme).toBe('light');
    expect(computeThemeVars(null).accentSource).toBe('default');
    expect(computeThemeVars({}).accentSource).toBe('default');
    expect(
      computeThemeVars({ colorScheme: 'dark', boost: { dotAngleDeg: NaN } }).accentSource
    ).toBe('default');
    expect(
      computeThemeVars({ colorScheme: 'dark', spacePrimaryRgb: [1, 2] }).accentSource
    ).toBe('default');
  });
});
