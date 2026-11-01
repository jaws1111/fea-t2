import * as THREE from 'three';
import { getTurboRamp, getViridisRamp, getEnergyRamp } from './colormaps.js';
import { aoUniform, LOD_THRESHOLDS } from './voxelShared.js';

const colorHelper = new THREE.Color();
const LUT_SIZE = 256;
const lut = new Float32Array(LUT_SIZE * 3);

/**
 * A solid voxel this dense (and all six neighbours too) is packed so tightly that its
 * faces can never be seen: it is skipped. Lower values hide more but start to show the
 * interior through the gaps of "mini element" cubes.
 */
export const OPAQUE_RHO = 0.85;

/** Metallic grey ramp keyed by density. */
function metalRamp(rho, out) {
  const tint = 0.45 + 0.5 * rho;
  out.setRGB(tint * 0.9, tint * 0.95, tint * 1.05, THREE.SRGBColorSpace);
}

/** Ramp function for a colour mode ('density' | 'viridis' | 'metal' | 'energy'). */
function rampFor(colorMode) {
  switch (colorMode) {
    case 'metal': return metalRamp;
    case 'viridis': return getViridisRamp;
    case 'energy': return getEnergyRamp;
    default: return getTurboRamp;
  }
}

/** Fill a colour LUT (linear RGB, 256 entries) for a ramp. */
function fillLut(ramp, target = lut) {
  for (let i = 0; i < LUT_SIZE; i++) {
    ramp(i / (LUT_SIZE - 1), colorHelper);
    target[i * 3] = colorHelper.r;
    target[i * 3 + 1] = colorHelper.g;
    target[i * 3 + 2] = colorHelper.b;
  }
}

/** Fresh colour LUT for a colour mode (shared by the cube view and the smooth body). */
export function buildColorLut(colorMode) {
  const out = new Float32Array(LUT_SIZE * 3);
  fillLut(rampFor(colorMode), out);
  return out;
}

/** Surface response per colour mode: Metallic is a real polished-metal material. */
export function applyMaterialLook(material, colorMode) {
  if (!material) return;
  const ud = material.userData;
  if (ud.baseMetalness === undefined) {
    ud.baseMetalness = material.metalness;
    ud.baseRoughness = material.roughness;
  }
  const metal = colorMode === 'metal';
  const metalness = metal ? 0.9 : ud.baseMetalness;
  const roughness = metal ? 0.28 : ud.baseRoughness;
  if (material.metalness !== metalness) material.metalness = metalness;
  if (material.roughness !== roughness) material.roughness = roughness;
}

/**
 * Neighbour-occupancy mask of cell (ex, ey, ez): 26 bits, bit b for offset (dx,dy,dz) with
 * n = (dx+1) + 3(dy+1) + 9(dz+1), b = n < 13 ? n : n - 1. Returned as two 13-bit halves
 * (exact in float32) for the vertex-shader AO.
 */
function neighbourMask(solid, nx, ny, nz, ex, ey, ez, out, o) {
  let lo = 0;
  let hi = 0;
  const nxy = nx * ny;
  let n = 0;
  for (let dz = -1; dz <= 1; dz++) {
    const z = ez + dz;
    for (let dy = -1; dy <= 1; dy++) {
      const y = ey + dy;
      for (let dx = -1; dx <= 1; dx++, n++) {
        if (n === 13) continue; // the voxel itself
        const x = ex + dx;
        if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
        if (!solid[x + nx * y + nxy * z]) continue;
        const b = n < 13 ? n : n - 1;
        if (b < 13) lo |= 1 << b;
        else hi |= 1 << (b - 13);
      }
    }
  }
  out[o] = lo;
  out[o + 1] = hi;
}

/**
 * Push solver fields into the voxel mesh (see instancedVoxels.js).
 *
 * Only visible voxels are written: density ≥ cutoff, minus fully enclosed solid interiors.
 * The instance count follows, so draw cost scales with the visible surface. Buffers are
 * uploaded partially (only the used prefix).
 *
 * @param {{
 *   mesh: THREE.Mesh | null,
 *   densities: Float32Array | null,
 *   energies?: Float32Array | null,
 *   dispY?: Float32Array | null,
 *   config: { nx: number, ny: number, nz: number, cutoff: number, defScale: number, viewMode: string, colorMode?: string, ao?: boolean },
 * }} args
 * @returns {boolean} true if the mesh was updated
 */
export function updateVisualization({ mesh, densities, energies, dispY, config }) {
  const vox = mesh?.userData?.voxels;
  if (!vox || !densities) return false;

  const { nx, ny, nz, cutoff, defScale, viewMode } = config;
  const colorMode = config.colorMode ?? 'density';
  if (densities.length !== nx * ny * nz || vox.cells !== densities.length) return false;

  // Smooth-body mode hides the voxel instances (surface mesh drawn separately).
  if (viewMode === 'smooth') {
    mesh.visible = false;
    return true;
  }
  mesh.visible = true;

  const { attrs, solid, opaque, geoms } = vox;
  const pos = /** @type {Float32Array} */ (attrs.aPos.array);
  const col = /** @type {Float32Array} */ (attrs.aColor.array);
  const scl = /** @type {Float32Array} */ (attrs.aScale.array);
  const occ = /** @type {Float32Array} */ (attrs.aOcc.array);

  const useAO = config.ao !== false;
  aoUniform.value = useAO ? 1 : 0;

  const total = densities.length;
  const opaqueMin = Math.max(cutoff, OPAQUE_RHO);
  let maxE = 1e-7;
  const useEnergy = colorMode === 'energy' && !!energies;
  for (let i = 0; i < total; i++) {
    const rho = densities[i];
    solid[i] = rho >= cutoff ? 1 : 0;
    opaque[i] = rho >= opaqueMin ? 1 : 0;
    if (useEnergy && energies[i] > maxE) maxE = energies[i];
  }

  fillLut(rampFor(colorMode));
  applyMaterialLook(mesh.material, colorMode);

  const useDefo = !!dispY && defScale > 0;
  const ox = -nx / 2 + 0.5;
  const oy = -ny / 2 + 0.5;
  const oz = -nz / 2 + 0.5;
  const invMaxE = 1 / maxE;
  const nxy = nx * ny;

  let k = 0;
  let i = 0;
  for (let ez = 0; ez < nz; ez++) {
    for (let ey = 0; ey < ny; ey++) {
      for (let ex = 0; ex < nx; ex++, i++) {
        if (!solid[i]) continue;
        // Packed interior: every face is covered by an equally dense neighbour.
        if (
          opaque[i] &&
          ex > 0 && ex < nx - 1 && ey > 0 && ey < ny - 1 && ez > 0 && ez < nz - 1 &&
          opaque[i - 1] && opaque[i + 1] && opaque[i - nx] && opaque[i + nx] &&
          opaque[i - nxy] && opaque[i + nxy]
        ) continue;

        const rho = densities[i];
        const p = k * 3;
        pos[p] = ex + ox;
        pos[p + 1] = ey + oy + (useDefo ? dispY[i] * defScale : 0);
        pos[p + 2] = ez + oz;
        scl[k] = 0.5 + 0.5 * rho;

        let v = rho;
        if (useEnergy) v = Math.min(1.0, Math.pow(energies[i] * invMaxE, 0.45));
        const l = (((v < 0 ? 0 : v > 1 ? 1 : v) * (LUT_SIZE - 1) + 0.5) | 0) * 3;
        col[p] = lut[l];
        col[p + 1] = lut[l + 1];
        col[p + 2] = lut[l + 2];

        if (useAO) neighbourMask(solid, nx, ny, nz, ex, ey, ez, occ, k * 2);
        k++;
      }
    }
  }

  // Coarser cube meshes as the visible count grows.
  const lod = k <= LOD_THRESHOLDS.rounded2 ? 0 : k <= LOD_THRESHOLDS.rounded1 ? 1 : 2;
  if (mesh.geometry !== geoms[lod]) mesh.geometry = geoms[lod];
  for (const g of geoms) g.instanceCount = k;
  for (const a of Object.values(attrs)) {
    a.clearUpdateRanges();
    a.addUpdateRange(0, k * a.itemSize);
    a.needsUpdate = true;
  }
  vox.visible = k;
  return true;
}
