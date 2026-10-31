import * as THREE from 'three';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Turbo colormap (Anton Mikhailov polynomial approximation). Returns sRGB in [0,1].
 * @param {number} val
 * @returns {[number, number, number]}
 */
export function turboRGB(val) {
  const x = clamp01(val);
  const x2 = x * x;
  const x3 = x2 * x;
  const x4 = x2 * x2;
  const x5 = x4 * x;
  return [
    clamp01(0.13572138 + 4.6153926 * x - 42.66032258 * x2 + 132.13108234 * x3 - 152.94239396 * x4 + 59.28637943 * x5),
    clamp01(0.09140261 + 2.19418839 * x + 4.84296658 * x2 - 14.18503333 * x3 + 4.27729857 * x4 + 2.82956604 * x5),
    clamp01(0.1066733 + 12.64194608 * x - 60.58204836 * x2 + 110.36276771 * x3 - 89.90310912 * x4 + 27.34824973 * x5),
  ];
}

/**
 * Viridis colormap (6th-order polynomial approximation). Returns sRGB in [0,1].
 * @param {number} val
 * @returns {[number, number, number]}
 */
export function viridisRGB(val) {
  const t = clamp01(val);
  const poly = (c0, c1, c2, c3, c4, c5, c6) =>
    clamp01(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))));
  return [
    poly(0.2777273272234177, 0.1050930431085774, -0.3308618287255563, -4.634230498983486, 6.228269936347081, 4.776384997670288, -5.435455855934631),
    poly(0.005407344544966578, 1.404613529898575, 0.214847559468213, -5.799100973351585, 14.17993336680509, -13.74514537774601, 4.645852612178535),
    poly(0.3340998053353061, 1.384590162594685, 0.09509516302823659, -19.33244095627987, 56.69055260068105, -65.35303263337234, 26.3124352495832),
  ];
}

/**
 * Write turbo(val) into a THREE.Color (value interpreted as sRGB → working space).
 * @param {number} val 0..1
 * @param {THREE.Color} outColor
 * @returns {THREE.Color}
 */
export function getTurboRamp(val, outColor) {
  const [r, g, b] = turboRGB(val);
  return outColor.setRGB(r, g, b, THREE.SRGBColorSpace);
}

/**
 * Write viridis(val) into a THREE.Color (value interpreted as sRGB → working space).
 * @param {number} val 0..1
 * @param {THREE.Color} outColor
 * @returns {THREE.Color}
 */
export function getViridisRamp(val, outColor) {
  const [r, g, b] = viridisRGB(val);
  return outColor.setRGB(r, g, b, THREE.SRGBColorSpace);
}

/** Strain-energy ramp: deep blue → red via HSL sweep (matches studio example). */
export function getEnergyRamp(norm, outColor) {
  return outColor.setHSL(0.66 * (1 - clamp01(norm)), 0.95, 0.5, THREE.SRGBColorSpace);
}

/** @param {[number, number, number]} rgb */
function rgbToCss([r, g, b]) {
  const c = (v) => Math.round(v * 255);
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

/**
 * CSS `linear-gradient` string for a view mode legend.
 * @param {'density'|'viridis'|'metal'|'energy'} mode
 * @param {number} [steps]
 */
export function getRampCssGradient(mode, steps = 12) {
  const stops = [];
  const tmp = new THREE.Color();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let css;
    if (mode === 'viridis') css = rgbToCss(viridisRGB(t));
    else if (mode === 'metal') {
      const tint = 0.45 + 0.5 * t;
      css = rgbToCss([tint * 0.9, tint * 0.95, Math.min(1, tint * 1.05)]);
    } else if (mode === 'energy') {
      css = `#${getEnergyRamp(t, tmp).getHexString(THREE.SRGBColorSpace)}`;
    } else css = rgbToCss(turboRGB(t));
    stops.push(`${css} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
