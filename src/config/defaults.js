/** @typedef {'bridge'|'deck'|'cantilever'|'mbb'|'michell'} PresetKey */

/**
 * Resolution presets matching the studio UI selector.
 * @type {Record<string, { nx: number, ny: number, nz: number, label?: string }>}
 */
export const RESOLUTION_PRESETS = {
  '20x8x4': { nx: 20, ny: 8, nz: 4, label: 'Fast' },
  '24x10x4': { nx: 24, ny: 10, nz: 4, label: 'Balanced' },
  '30x12x6': { nx: 30, ny: 12, nz: 6, label: 'Detailed' },
  '36x15x8': { nx: 36, ny: 15, nz: 8, label: 'High Res' },
  '40x16x10': { nx: 40, ny: 16, nz: 10, label: 'Ultra' },
  '48x20x12': { nx: 48, ny: 20, nz: 12, label: 'GPU Heavy' },
  '64x24x16': { nx: 64, ny: 24, nz: 16, label: 'GPU Max' },
  '48x24x16': { nx: 48, ny: 24, nz: 16, label: 'Vessel' },
  '32x32x32': { nx: 32, ny: 32, nz: 32, label: 'Cube 32' },
  // Large domains (~50k–150k voxels)
  '80x40x16': { nx: 80, ny: 40, nz: 16, label: '50k' },
  '100x40x20': { nx: 100, ny: 40, nz: 20, label: '80k' },
  '100x50x20': { nx: 100, ny: 50, nz: 20, label: '100k' },
  '120x50x25': { nx: 120, ny: 50, nz: 25, label: '150k' },
  '160x50x25': { nx: 160, ny: 50, nz: 25, label: '200k' },
  '200x50x25': { nx: 200, ny: 50, nz: 25, label: '250k' },
  '200x60x25': { nx: 200, ny: 60, nz: 25, label: '300k' },
};

/** SIMP / PCG material and solver constants (parity with inline worker). */
export const FEA_CONSTANTS = {
  Emin: 1e-4,
  E0: 1.0,
  nu: 0.3,
  maxIters: 60,
  cgTol: 1e-4,
  moveLimit: 0.2,
};

/**
 * Factory for default studio CONFIG (UI + worker shared fields).
 * @param {Partial<{
 *   nx: number, ny: number, nz: number,
 *   volfrac: number, penal: number, rmin: number,
 *   cutoff: number, defScale: number, batchSize: number,
 *   preset: PresetKey, viewMode: string
 * }>} [overrides]
 */
export function createConfig(overrides = {}) {
  return {
    // Default leans toward GPU-filling work (still interactive).
    nx: 36,
    ny: 15,
    nz: 8,
    volfrac: 0.35,
    penal: 3.0,
    rmin: 1.6,
    cutoff: 0.18,
    defScale: 0.0,
    batchSize: 1,
    preset: 'bridge',
    viewMode: 'density',
    /** @type {import('../scene/types.js').Scene | null} */
    scene: null,
    // Lower iso + fewer Taubin iters keep thin members from tearing open.
    smoothIso: 0.45,
    smoothIters: 4,
    ...overrides,
  };
}

/** Default CONFIG instance (mutable UI mirror). */
export const CONFIG = createConfig();

/**
 * Apply a resolution preset key to a config object.
 * @param {string} presetKey
 * @param {ReturnType<typeof createConfig>} [config=CONFIG]
 */
export function applyResolutionPreset(presetKey, config = CONFIG) {
  const preset = RESOLUTION_PRESETS[presetKey];
  if (!preset) return config;
  config.nx = preset.nx;
  config.ny = preset.ny;
  config.nz = preset.nz;
  return config;
}
