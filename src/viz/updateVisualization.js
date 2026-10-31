import * as THREE from 'three';
import { getTurboRamp, getViridisRamp, getEnergyRamp } from './colormaps.js';

const colorHelper = new THREE.Color();
const LUT_SIZE = 256;
const lut = new Float32Array(LUT_SIZE * 3);
const HIDDEN_SCALE = 0.0001;

/** Metallic grey ramp keyed by density. */
function metalRamp(rho, out) {
  const tint = 0.45 + 0.5 * rho;
  out.setRGB(tint * 0.9, tint * 0.95, tint * 1.05, THREE.SRGBColorSpace);
}

/** Fill the colour LUT (linear RGB) for the current colour ramp. */
function fillLut(ramp) {
  for (let i = 0; i < LUT_SIZE; i++) {
    ramp(i / (LUT_SIZE - 1), colorHelper);
    lut[i * 3] = colorHelper.r;
    lut[i * 3 + 1] = colorHelper.g;
    lut[i * 3 + 2] = colorHelper.b;
  }
}

/**
 * Push solver fields into the instanced voxel mesh (matrices + colours).
 * Writes straight into the instance arrays (no per-voxel Object3D / Color work) so a
 * 300k-voxel refresh stays cheap.
 *
 * @param {{
 *   mesh: THREE.InstancedMesh | null,
 *   densities: Float32Array | null,
 *   energies?: Float32Array | null,
 *   dispY?: Float32Array | null,
 *   config: { nx: number, ny: number, nz: number, cutoff: number, defScale: number, viewMode: string },
 * }} args
 * @returns {boolean} true if the mesh was updated
 */
export function updateVisualization({ mesh, densities, energies, dispY, config }) {
  if (!mesh || !densities) return false;

  const { nx, ny, nz, cutoff, defScale, viewMode } = config;
  if (densities.length !== nx * ny * nz || mesh.count !== densities.length) return false;

  // Smooth-body mode hides the voxel instances (surface mesh drawn separately).
  if (viewMode === 'smooth') {
    mesh.visible = false;
    return true;
  }
  mesh.visible = true;

  if (!mesh.instanceColor) {
    colorHelper.setRGB(1, 1, 1);
    mesh.setColorAt(0, colorHelper); // allocates the colour attribute
  }
  const mat = /** @type {Float32Array} */ (mesh.instanceMatrix.array);
  const col = /** @type {Float32Array} */ (mesh.instanceColor.array);

  let maxE = 1e-7;
  const useEnergy = viewMode === 'energy' && !!energies;
  if (useEnergy) {
    for (let i = 0; i < energies.length; i++) if (energies[i] > maxE) maxE = energies[i];
  }

  fillLut(
    viewMode === 'metal'
      ? metalRamp
      : viewMode === 'viridis'
        ? getViridisRamp
        : viewMode === 'energy'
          ? getEnergyRamp
          : getTurboRamp,
  );

  const useDefo = !!dispY && defScale > 0;
  const ox = -nx / 2 + 0.5;
  const oy = -ny / 2 + 0.5;
  const oz = -nz / 2 + 0.5;
  const invMaxE = 1 / maxE;

  let i = 0;
  for (let ez = 0; ez < nz; ez++) {
    for (let ey = 0; ey < ny; ey++) {
      for (let ex = 0; ex < nx; ex++, i++) {
        const rho = densities[i];
        const s = rho < cutoff ? HIDDEN_SCALE : 0.5 + 0.5 * rho;
        const m = i * 16;
        mat[m] = s;
        mat[m + 1] = 0;
        mat[m + 2] = 0;
        mat[m + 3] = 0;
        mat[m + 4] = 0;
        mat[m + 5] = s;
        mat[m + 6] = 0;
        mat[m + 7] = 0;
        mat[m + 8] = 0;
        mat[m + 9] = 0;
        mat[m + 10] = s;
        mat[m + 11] = 0;
        mat[m + 12] = ex + ox;
        mat[m + 13] = ey + oy + (useDefo ? dispY[i] * defScale : 0);
        mat[m + 14] = ez + oz;
        mat[m + 15] = 1;

        const c = i * 3;
        let v = rho;
        if (useEnergy) v = Math.min(1.0, Math.pow(energies[i] * invMaxE, 0.45));
        const k = (v < 0 ? 0 : v > 1 ? 1 : v) * (LUT_SIZE - 1);
        const l = ((k + 0.5) | 0) * 3;
        col[c] = lut[l];
        col[c + 1] = lut[l + 1];
        col[c + 2] = lut[l + 2];
      }
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  return true;
}
