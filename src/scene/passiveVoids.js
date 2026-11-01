import { componentDef, orderedFeatures } from './components/index.js';
import { resolveWorkingBounds } from './workingVolume.js';

/**
 * Per-element passive mask:
 *   0 = free (designable)
 *   1 = void  (hole bore, pressure cavity, outside the working volume — always xmin)
 *   2 = solid (bolt boss, pressure wall, wall pad, rest foot — always ρ = 1)
 *
 * Layering: solids are laid down first, then voids overwrite them — so a bore always
 * stays open through its own boss and any overlapping pad, and a cavity is never
 * filled by a neighbouring boss.
 *
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {import('./types.js').Scene | null | undefined} scene
 * @returns {Uint8Array | null} length nx×ny×nz, or null if nothing to force
 */
export function buildPassiveMask(nx, ny, nz, scene) {
  if (!scene) return null;
  const dims = { nx, ny, nz };
  const total = nx * ny * nz;
  const maxDim = Math.max(nx, ny, nz);
  const solid = new Uint8Array(total);
  const voidm = new Uint8Array(total);
  let any = false;
  const E = (ex, ey, ez) => ex + nx * (ey + ny * ez);

  const wb = resolveWorkingBounds(scene, dims);
  const list = orderedFeatures(scene);
  const ctx = { solid, voidm, dims, maxDim, wb, E, any: false };
  for (const c of list) componentDef(c?.type)?.paintSolid?.(c, ctx);
  for (const c of list) componentDef(c?.type)?.paintVoid?.(c, ctx);
  any = ctx.any;

  // Outside the working volume: permanent void.
  const full =
    wb.x0 <= 1e-9 && wb.x1 >= 1 - 1e-9 &&
    wb.y0 <= 1e-9 && wb.y1 >= 1 - 1e-9 &&
    wb.z0 <= 1e-9 && wb.z1 >= 1 - 1e-9;
  if (!full) {
    const ex0 = Math.max(0, Math.floor(wb.x0 * nx));
    const ex1 = Math.min(nx - 1, Math.ceil(wb.x1 * nx) - 1);
    const ey0 = Math.max(0, Math.floor(wb.y0 * ny));
    const ey1 = Math.min(ny - 1, Math.ceil(wb.y1 * ny) - 1);
    const ez0 = Math.max(0, Math.floor(wb.z0 * nz));
    const ez1 = Math.min(nz - 1, Math.ceil(wb.z1 * nz) - 1);
    for (let ez = 0; ez < nz; ez++) {
      for (let ey = 0; ey < ny; ey++) {
        for (let ex = 0; ex < nx; ex++) {
          if (ex < ex0 || ex > ex1 || ey < ey0 || ey > ey1 || ez < ez0 || ez > ez1) {
            voidm[E(ex, ey, ez)] = 1;
            any = true;
          }
        }
      }
    }
  }

  if (!any) return null;
  const mask = new Uint8Array(total);
  for (let i = 0; i < total; i++) mask[i] = voidm[i] ? 1 : solid[i] ? 2 : 0;
  return mask;
}

/**
 * Apply passive void (xmin) and solid (1) regions from the scene.
 * Call after density init and after every OC update.
 *
 * @returns {{ voids: number, solids: number }}
 */
export function applyPassiveRegions(x, xPhys, nx, ny, nz, scene, xmin = 0.001) {
  const total = nx * ny * nz;
  if (!x || x.length !== total) return { voids: 0, solids: 0 };
  const mask = buildPassiveMask(nx, ny, nz, scene);
  if (!mask) return { voids: 0, solids: 0 };

  let voids = 0;
  let solids = 0;
  for (let i = 0; i < total; i++) {
    if (mask[i] === 1) {
      x[i] = xmin;
      xPhys[i] = xmin;
      voids++;
    } else if (mask[i] === 2) {
      x[i] = 1;
      xPhys[i] = 1;
      solids++;
    }
  }
  return { voids, solids };
}

/** @deprecated use applyPassiveRegions */
export function applyPassiveVoids(x, xPhys, nx, ny, nz, scene, xmin = 0.001) {
  return applyPassiveRegions(x, xPhys, nx, ny, nz, scene, xmin).voids;
}
