import {
  holeAxialRange,
  holeBossOuterCells,
  holeFrame,
  holeRadiusCells,
  pressureWallCells,
  boxHalfCells,
  sphereRadiusCells,
  toXYZ,
} from './geometry.js';
import { normToNodeIndices } from './tools.js';
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

  /* ---------------- Solids ---------------- */

  for (const fx of scene.fixations ?? []) {
    if (!fx) continue;

    if (fx.type === 'bolt_hole') {
      const frame = holeFrame(fx, dims);
      const range = holeAxialRange(fx, wb, frame.axis, frame.nA);
      if (!range) continue;
      const Rvoid = holeRadiusCells(fx.radius, maxDim);
      const Rsolid = holeBossOuterCells(Rvoid);
      const Rs2 = Rsolid * Rsolid + 1e-9;
      const r = Math.ceil(Rsolid) + 1;
      const xyz = [0, 0, 0];
      for (let a = range[0]; a <= range[1]; a++) {
        for (let e2 = Math.max(0, frame.i2 - r); e2 < Math.min(frame.n2, frame.i2 + r); e2++) {
          for (let e1 = Math.max(0, frame.i1 - r); e1 < Math.min(frame.n1, frame.i1 + r); e1++) {
            const d2 = (e1 + 0.5 - frame.i1) ** 2 + (e2 + 0.5 - frame.i2) ** 2;
            if (d2 > Rs2) continue;
            toXYZ(frame.axis, e1, e2, a, xyz);
            solid[E(xyz[0], xyz[1], xyz[2])] = 1;
            any = true;
          }
        }
      }
    }

    if (fx.type === 'wall_pad') {
      const face = ['x-', 'x+', 'y-', 'y+', 'z-', 'z+'].includes(fx.face) ? fx.face : 'x-';
      const axis = face[0];
      const high = face[1] === '+';
      const layers = Math.max(2, Math.round(fx.depth ?? 2));
      const width = fx.width ?? 1;
      const height = fx.height ?? 1;
      const d = { x: nx, y: ny, z: nz };
      const perp = axis === 'x' ? ['y', 'z'] : axis === 'y' ? ['x', 'z'] : ['x', 'y'];
      const nU = d[perp[0]];
      const nV = d[perp[1]];
      const nA = d[axis];
      const [u, v] = axis === 'x' ? [fx.y, fx.z] : axis === 'y' ? [fx.x, fx.z] : [fx.x, fx.y];
      const u0 = Math.max(0, Math.round((u - Math.max(0, width) / 2) * nU));
      const u1 = Math.min(nU - 1, Math.round((u + Math.max(0, width) / 2) * nU) - 1);
      const v0 = Math.max(0, Math.round((v - Math.max(0, height) / 2) * nV));
      const v1 = Math.min(nV - 1, Math.round((v + Math.max(0, height) / 2) * nV) - 1);
      const xyz = [0, 0, 0];
      for (let l = 0; l < layers; l++) {
        const a = high ? nA - 1 - l : l;
        if (a < 0 || a >= nA) continue;
        for (let pv = v0; pv <= v1; pv++) {
          for (let pu = u0; pu <= u1; pu++) {
            toXYZ(axis, pu, pv, a, xyz);
            // toXYZ maps (p1,p2)=(perp0,perp1) onto the right axes for any face axis
            solid[E(xyz[0], xyz[1], xyz[2])] = 1;
            any = true;
          }
        }
      }
    }

    if (fx.type === 'rest_point') {
      const c = normToNodeIndices(nx, ny, nz, fx.x, fx.y, fx.z);
      const R = Math.max(1.5, (fx.radius ?? 0.03) * maxDim * 1.5);
      const R2 = R * R;
      const r = Math.ceil(R);
      for (let ez = Math.max(0, c.iz - r); ez < Math.min(nz, c.iz + r); ez++) {
        for (let ey = Math.max(0, c.iy - r); ey < Math.min(ny, c.iy + r); ey++) {
          for (let ex = Math.max(0, c.ix - r); ex < Math.min(nx, c.ix + r); ex++) {
            const dx = ex + 0.5 - c.ix;
            const dy = ey + 0.5 - c.iy;
            const dz = ez + 0.5 - c.iz;
            if (dx * dx + dy * dy + dz * dz > R2) continue;
            solid[E(ex, ey, ez)] = 1;
            any = true;
          }
        }
      }
    }
  }

  /* Pressure cavity walls (solid shell) */
  for (const f of scene.forces ?? []) {
    if (f?.type !== 'pressure' || f.cavityVoid === false) continue;
    const c = normToNodeIndices(nx, ny, nz, f.x, f.y, f.z);
    const wall = pressureWallCells(f);
    if (f.shape === 'box') {
      const b = boxHalfCells(f, dims);
      for (let ez = Math.max(0, c.iz - b.rz - wall); ez < Math.min(nz, c.iz + b.rz + wall); ez++) {
        for (let ey = Math.max(0, c.iy - b.ry - wall); ey < Math.min(ny, c.iy + b.ry + wall); ey++) {
          for (let ex = Math.max(0, c.ix - b.rx - wall); ex < Math.min(nx, c.ix + b.rx + wall); ex++) {
            solid[E(ex, ey, ez)] = 1;
            any = true;
          }
        }
      }
    } else {
      const R = sphereRadiusCells(f.radius, maxDim);
      const Ro2 = (R + wall) * (R + wall) + 1e-9;
      const r = Math.ceil(R + wall) + 1;
      for (let ez = Math.max(0, c.iz - r); ez < Math.min(nz, c.iz + r); ez++) {
        for (let ey = Math.max(0, c.iy - r); ey < Math.min(ny, c.iy + r); ey++) {
          for (let ex = Math.max(0, c.ix - r); ex < Math.min(nx, c.ix + r); ex++) {
            const d2 = (ex + 0.5 - c.ix) ** 2 + (ey + 0.5 - c.iy) ** 2 + (ez + 0.5 - c.iz) ** 2;
            if (d2 > Ro2) continue;
            solid[E(ex, ey, ez)] = 1;
            any = true;
          }
        }
      }
    }
  }

  /* ---------------- Voids (override solids) ---------------- */

  // Hole bores
  for (const fx of scene.fixations ?? []) {
    if (fx?.type !== 'bolt_hole') continue;
    const frame = holeFrame(fx, dims);
    const range = holeAxialRange(fx, wb, frame.axis, frame.nA);
    if (!range) continue;
    const Rvoid = holeRadiusCells(fx.radius, maxDim);
    const Rv2 = Rvoid * Rvoid + 1e-9;
    const r = Math.ceil(Rvoid) + 1;
    const xyz = [0, 0, 0];
    for (let a = range[0]; a <= range[1]; a++) {
      for (let e2 = Math.max(0, frame.i2 - r); e2 < Math.min(frame.n2, frame.i2 + r); e2++) {
        for (let e1 = Math.max(0, frame.i1 - r); e1 < Math.min(frame.n1, frame.i1 + r); e1++) {
          const d2 = (e1 + 0.5 - frame.i1) ** 2 + (e2 + 0.5 - frame.i2) ** 2;
          if (d2 > Rv2) continue;
          toXYZ(frame.axis, e1, e2, a, xyz);
          voidm[E(xyz[0], xyz[1], xyz[2])] = 1;
          any = true;
        }
      }
    }
  }

  // Pressure cavities (void interior)
  for (const f of scene.forces ?? []) {
    if (f?.type !== 'pressure' || f.cavityVoid === false) continue;
    const c = normToNodeIndices(nx, ny, nz, f.x, f.y, f.z);
    if (f.shape === 'box') {
      const b = boxHalfCells(f, dims);
      for (let ez = Math.max(0, c.iz - b.rz); ez < Math.min(nz, c.iz + b.rz); ez++) {
        for (let ey = Math.max(0, c.iy - b.ry); ey < Math.min(ny, c.iy + b.ry); ey++) {
          for (let ex = Math.max(0, c.ix - b.rx); ex < Math.min(nx, c.ix + b.rx); ex++) {
            voidm[E(ex, ey, ez)] = 1;
            any = true;
          }
        }
      }
    } else {
      const R = sphereRadiusCells(f.radius, maxDim);
      const R2 = R * R + 1e-9;
      const r = Math.ceil(R) + 1;
      for (let ez = Math.max(0, c.iz - r); ez < Math.min(nz, c.iz + r); ez++) {
        for (let ey = Math.max(0, c.iy - r); ey < Math.min(ny, c.iy + r); ey++) {
          for (let ex = Math.max(0, c.ix - r); ex < Math.min(nx, c.ix + r); ex++) {
            const d2 = (ex + 0.5 - c.ix) ** 2 + (ey + 0.5 - c.iy) ** 2 + (ez + 0.5 - c.iz) ** 2;
            if (d2 > R2) continue;
            voidm[E(ex, ey, ez)] = 1;
            any = true;
          }
        }
      }
    }
  }

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
