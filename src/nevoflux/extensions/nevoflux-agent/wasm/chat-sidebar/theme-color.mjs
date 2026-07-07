/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Pure color math for the sidebar theme-follow feature.
 *
 * hslToRgb / rgbToHsl are formula-identical copies of
 * src/zen/boosts/actors/ZenBoostsChild.sys.mjs (which itself copied them from
 * ZenGradientGenerator.mjs). Keep them in sync: the sidebar accent must match
 * the color the boost backend paints on the page.
 *
 * Zero DOM / zero WebExtension dependencies so node can unit-test it directly
 * (src/nevoflux/tests/unit/theme-color.test.mjs).
 */

/**
 * @param {number} h - Hue in [0, 1]
 * @param {number} s - Saturation in [0, 1]
 * @param {number} l - Lightness in [0, 1]
 * @returns {[number, number, number]} RGB in [0, 255]
 */
export function hslToRgb(h, s, l) {
  const { round } = Math;
  let r, g, b;

  if (s === 0) {
    r = g = b = l; // achromatic
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1 / 3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1 / 3);
  }

  return [round(r * 255), round(g * 255), round(b * 255)];
}

function hueToRgb(p, q, t) {
  if (t < 0) {
    t += 1;
  }
  if (t > 1) {
    t -= 1;
  }
  if (t < 1 / 6) {
    return p + (q - p) * 6 * t;
  }
  if (t < 1 / 2) {
    return q;
  }
  if (t < 2 / 3) {
    return p + (q - p) * (2 / 3 - t) * 6;
  }
  return p;
}

/**
 * @param {number} r - Red in [0, 255]
 * @param {number} g - Green in [0, 255]
 * @param {number} b - Blue in [0, 255]
 * @returns {[number, number, number]} HSL in [0, 1]
 */
export function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h;
  if (d === 0) {
    h = 0;
  } else if (max === r) {
    h = ((g - b) / d) % 6;
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  h /= 6;
  if (h < 0) {
    h += 1;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, s, l];
}

/**
 * Readability clamp: boost accents can be arbitrarily dark/bright; keep the
 * sidebar accent inside a range that stays legible on our surfaces.
 *
 * @param {number} l - Lightness in [0, 1]
 * @param {'light'|'dark'} scheme
 * @returns {number} Clamped lightness
 */
export function clampLightness(l, scheme) {
  if (scheme === 'dark') {
    return Math.min(0.8, Math.max(0.55, l));
  }
  return Math.min(0.6, Math.max(0.3, l));
}

function toHex([r, g, b]) {
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

/**
 * Turn a raw ThemeContext (from browser.nevoflux.getThemeContext) into the
 * CSS variable values the sidebar applies. Never throws: any malformed input
 * degrades to { scheme: 'light'|'dark', accentSource: 'default', accent: null }.
 *
 * Accent precedence: active color boost → space gradient primary → default
 * (null values; nf-theme.css fallbacks keep the built-in teal).
 *
 * @param {?object} ctx - ThemeContext:
 *   { colorScheme, domain, boost: ?{autoTheme, dotAngleDeg, saturation,
 *     brightness}, spacePrimaryRgb: ?[r,g,b] }
 * @returns {{scheme: string, accentSource: string, accent: ?string,
 *            accentHover: ?string, accentLight: ?string, accentLighter: ?string}}
 */
export function computeThemeVars(ctx) {
  const scheme = ctx?.colorScheme === 'dark' ? 'dark' : 'light';

  const boost = ctx?.boost;
  const spaceRgb =
    Array.isArray(ctx?.spacePrimaryRgb) &&
    ctx.spacePrimaryRgb.length === 3 &&
    ctx.spacePrimaryRgb.every((c) => Number.isFinite(c))
      ? ctx.spacePrimaryRgb
      : null;

  let h = null;
  let s = null;
  let l = null;
  let accentSource = 'default';

  const boostUsable =
    boost && ((boost.autoTheme && spaceRgb) || Number.isFinite(boost.dotAngleDeg));
  if (boostUsable) {
    // Same modifiers as ZenBoostsChild.#applyBoostForPageIfAvailable:
    //   s = 1 - boostData.saturation, l = 0.1 + 0.9 * boostData.brightness
    s = 1 - (Number.isFinite(boost.saturation) ? boost.saturation : 0.5);
    l = 0.1 + 0.9 * (Number.isFinite(boost.brightness) ? boost.brightness : 0.5);
    if (boost.autoTheme && spaceRgb) {
      [h] = rgbToHsl(spaceRgb[0], spaceRgb[1], spaceRgb[2]);
    } else {
      h = (((boost.dotAngleDeg % 360) + 360) % 360) / 360;
    }
    accentSource = 'boost';
  } else if (spaceRgb) {
    [h, s, l] = rgbToHsl(spaceRgb[0], spaceRgb[1], spaceRgb[2]);
    accentSource = 'space';
  }

  if (h === null) {
    return {
      scheme,
      accentSource: 'default',
      accent: null,
      accentHover: null,
      accentLight: null,
      accentLighter: null,
    };
  }

  l = clampLightness(l, scheme);
  const accentRgb = hslToRgb(h, s, l);
  const hoverRgb = hslToRgb(h, s, Math.max(0.15, l - 0.08));

  return {
    scheme,
    accentSource,
    accent: toHex(accentRgb),
    accentHover: toHex(hoverRgb),
    accentLight: `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, 0.12)`,
    accentLighter: `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, 0.08)`,
  };
}
