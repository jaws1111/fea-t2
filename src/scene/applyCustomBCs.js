import { getNodeIndex } from '../fea/indexing.js';
import {
  boxHalfCells,
  holeAxialRange,
  holeFrame,
  holeInterfaceNodes2D,
  holeRadiusCells,
  radial3,
  sphereInterfaceNodes,
  sphereRadiusCells,
  tangent3,
  toXYZ,
  validAxis,
} from './geometry.js';
import {
  forNodesInSphere,
  forNodesOnBoxShell,
  forNodesOnFacePatch,
  forNodesOnSphereShell,
  normToNodeIndices,
} from './tools.js';
import { pointLoadComponents, sceneLoadCaseCount } from './pointLoad.js';
import { resolveWorkingBounds } from './workingVolume.js';

const DEFAULT_REST_RADIUS = 0.02;

/** @returns {[number, number, number]} unit vector (−Y if degenerate) */
function normalizeDir(fx, fy, fz) {
  const x = Number(fx) || 0;
  const y = Number(fy) || 0;
  const z = Number(fz) || 0;
  const len = Math.hypot(x, y, z);
  if (len < 1e-12) return [0, -1, 0];
  return [x / len, y / len, z / len];
}

/** Remove the axis component: perpendicular (in-plane) part of a vector. */
function dropAxis(axis, dx, dy, dz) {
  if (axis === 'x') return [0, dy, dz];
  if (axis === 'y') return [dx, 0, dz];
  return [dx, dy, 0];
}

/** Add share-proportional parts of a resultant (dir × magnitude) to nodes. */
function distributeResultant(F, nodes, dir, magnitude) {
  let sum = 0;
  for (const nd of nodes) sum += nd.w;
  if (sum <= 0) return;
  for (const nd of nodes) {
    const s = (magnitude * nd.w) / sum;
    F[3 * nd.n] += dir[0] * s;
    F[3 * nd.n + 1] += dir[1] * s;
    F[3 * nd.n + 2] += dir[2] * s;
  }
}

/**
 * The load vectors a bolt hole carries (signed magnitudes folded into direction).
 * @returns {{ dir: [number, number, number], mag: number }[]}
 */
export function holeLoadVectors(f) {
  const mk = (fx, fy, fz, m) => {
    const mag = Number.isFinite(m) ? m : 1;
    if (mag === 0) return null;
    const d = normalizeDir(fx, fy, fz);
    const s = mag < 0 ? -1 : 1;
    return { dir: /** @type {[number, number, number]} */ ([d[0] * s, d[1] * s, d[2] * s]), mag: Math.abs(mag) };
  };
  if (f.loadMode === 'directional') {
    const v = mk(f.fx, f.fy, f.fz, f.magnitude);
    return v ? [v] : [];
  }
  if (f.loadMode === 'multi') {
    return (f.loads ?? []).map((l) => mk(l.fx, l.fy, l.fz, l.magnitude)).filter(Boolean);
  }
  return [];
}

/**
 * Dry-run the scene on throw-away arrays and report problems the user can fix:
 * missing supports/loads, load absorbed by fixed DOFs, loads outside the working volume.
 *
 * @param {import('./types.js').Scene | null | undefined} scene
 * @param {{ nx: number, ny: number, nz: number }} dims
 * @returns {{ warnings: string[], fixedNodes: number, loadedNodes: number, absorbed: number, net: [number, number, number] }}
 */
export function analyzeScene(scene, dims) {
  const { nx, ny, nz } = dims;
  const nNodes = (nx + 1) * (ny + 1) * (nz + 1);
  const fixed = new Uint8Array(3 * nNodes);
  const F = new Float32Array(3 * nNodes);
  /** @type {string[]} */
  const warnings = [];
  let res = { fixedNodes: 0, loadedNodes: 0, warnings };
  let total = 0;
  let absorbedAbs = 0;
  const net = [0, 0, 0];
  // Every load case is analysed on its own (a scene without multi-axis loads has one).
  const cases = sceneLoadCaseCount(scene);
  for (let k = 0; k < cases; k++) {
    fixed.fill(0);
    F.fill(0);
    const r = applyCustomBCs(fixed, F, nx, ny, nz, scene, k);
    for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
    res = { fixedNodes: r.fixedNodes, loadedNodes: Math.max(res.loadedNodes, r.loadedNodes), warnings };
    for (let i = 0; i < F.length; i++) {
      const a = Math.abs(F[i]);
      if (!a) continue;
      total += a;
      if (fixed[i]) absorbedAbs += a;
      else if (k === 0) net[i % 3] += F[i];
    }
  }
  if (!res.fixedNodes) warnings.push('No supports: add a wall pad, rest point or clamped bolt hole.');
  if (!res.loadedNodes) warnings.push('No loads: add a point load, loaded bolt hole or pressure.');
  if (total > 0 && absorbedAbs / total > 0.05 && !warnings.some((w) => w.includes('absorbed'))) {
    warnings.push(
      `${Math.round((100 * absorbedAbs) / total)}% of the load lands on fixed DOFs and is absorbed by the support.`,
    );
  }
  return { warnings, fixedNodes: res.fixedNodes, loadedNodes: res.loadedNodes, absorbed: total ? absorbedAbs / total : 0, net: /** @type {[number, number, number]} */ (net) };
}

/**
 * Apply a user-defined scene to the DOF mask and load vector (mutates both).
 *
 * Bolt holes constrain and load the SAME interface nodes — the bore wall, i.e. the
 * nodes that touch both the void bore and the locked solid boss — so every fixed /
 * loaded node is guaranteed to be backed by material. A load component along a
 * fixed axis is absorbed by the support (reported in `warnings`).
 *
 * Load normalisation: each load contributes a bounded total — point, directional /
 * multi bearing: resultant = unit direction × |magnitude|; radial / torque / radial
 * pressure: Σ|F_i| = |magnitude| (self-equilibrated). Independent of mesh size.
 *
 * @param {Uint8Array} fixedDofs  length 3 * nNodes
 * @param {Float32Array} F        length 3 * nNodes
 * @param {number} [loadCase]     which load case's multi-axis point loads to apply (see pointLoad.js)
 * @returns {{ fixedNodes: number, loadedNodes: number, warnings: string[] }}
 */
export function applyCustomBCs(fixedDofs, F, nx, ny, nz, scene, loadCase = 0) {
  let fixedNodes = 0;
  let loadedNodes = 0;
  /** @type {string[]} */
  const warnings = [];
  if (!scene) return { fixedNodes, loadedNodes, warnings };

  const dims = { nx, ny, nz };
  const maxDim = Math.max(nx, ny, nz);
  const wb = resolveWorkingBounds(scene, dims);
  const idx = (ix, iy, iz) => getNodeIndex(nx, ny, nz, ix, iy, iz);

  /**
   * Bore-wall nodes of a hole: [{ n, u, v }] with in-plane offsets from the axis.
   * Empty if the hole lies outside the working volume.
   */
  function holeShell(f) {
    const frame = holeFrame(f, dims);
    const range = holeAxialRange(f, wb, frame.axis, frame.nA);
    if (!range) return { frame, nodes: [] };
    const ring = holeInterfaceNodes2D(frame, holeRadiusCells(f.radius, maxDim));
    const xyz = [0, 0, 0];
    const nodes = [];
    for (let a = range[0]; a <= range[1] + 1; a++) {
      for (const rn of ring) {
        toXYZ(frame.axis, rn.p1, rn.p2, a, xyz);
        nodes.push({ n: idx(xyz[0], xyz[1], xyz[2]), u: rn.u, v: rn.v });
      }
    }
    return { frame, nodes };
  }

  /* ------------------------------ Fixations ------------------------------ */
  for (const fx of scene.fixations ?? []) {
    if (!fx) continue;
    const flagX = fx.fixX !== false;
    const flagY = fx.fixY !== false;
    const flagZ = fx.fixZ !== false;
    const fixNode = (n) => {
      if (flagX) fixedDofs[3 * n] = 1;
      if (flagY) fixedDofs[3 * n + 1] = 1;
      if (flagZ) fixedDofs[3 * n + 2] = 1;
      fixedNodes++;
    };
    const anyFlag = flagX || flagY || flagZ;

    switch (fx.type) {
      case 'rest_point': {
        if (!anyFlag) break;
        const r = fx.radius ?? DEFAULT_REST_RADIUS;
        forNodesInSphere(nx, ny, nz, fx.x, fx.y, fx.z, r, (ix, iy, iz) => fixNode(idx(ix, iy, iz)));
        break;
      }
      case 'bolt_hole': {
        if (!anyFlag) break;
        for (const nd of holeShell(fx).nodes) fixNode(nd.n);
        break;
      }
      case 'wall_pad': {
        if (!anyFlag) break;
        const face = ['x-', 'x+', 'y-', 'y+', 'z-', 'z+'].includes(fx.face) ? fx.face : 'x-';
        const axis = face[0];
        const [u, v] =
          axis === 'x' ? [fx.y, fx.z] : axis === 'y' ? [fx.x, fx.z] : [fx.x, fx.y];
        forNodesOnFacePatch(nx, ny, nz, face, u, v, fx.width ?? 1, fx.height ?? 1, fx.depth ?? 1, (ix, iy, iz) =>
          fixNode(idx(ix, iy, iz)),
        );
        break;
      }
      default:
        break;
    }
  }

  /* --------------------------- Bolt-hole loads --------------------------- */
  for (const f of scene.fixations ?? []) {
    if (f?.type !== 'bolt_hole' || !f.loadMode || f.loadMode === 'none') continue;
    const { frame, nodes: shell } = holeShell(f);
    const axis = validAxis(f.axis);
    if (!shell.length) {
      warnings.push(`Bolt hole ${f.id} is outside the working volume — its load is ignored.`);
      continue;
    }
    const free = [f.fixX === false, f.fixY === false, f.fixZ === false];

    if (f.loadMode === 'circular') {
      const mag = Number.isFinite(f.magnitude) ? f.magnitude : 1;
      if (mag === 0) continue;
      const sign = mag < 0 ? -1 : 1;
      const absMag = Math.abs(mag);
      const share = absMag / shell.length;
      let reaches = false;
      for (const nd of shell) {
        const r = radial3(axis, nd.u, nd.v);
        const rl = Math.hypot(r[0], r[1], r[2]);
        if (rl < 1e-9) continue;
        const rhat = [r[0] / rl, r[1] / rl, r[2] / rl];
        const dir = f.circMode === 'radial' ? rhat : tangent3(axis, rhat);
        for (let d = 0; d < 3; d++) {
          F[3 * nd.n + d] += sign * dir[d] * share;
          if (free[d]) reaches = true;
        }
      }
      loadedNodes += shell.length;
      if (!reaches) warnings.push(`Bolt hole ${f.id}: circular load is fully absorbed (all axes fixed).`);
      continue;
    }

    for (const { dir, mag } of holeLoadVectors(f)) {
      const [px, py, pz] = dropAxis(axis, dir[0], dir[1], dir[2]);
      const pLen = Math.hypot(px, py, pz);
      /** @type {{ n: number, w: number }[]} */
      const nodes = [];
      if (pLen < 1e-6) {
        // Pure axial load (along the bore): spread uniformly on the wall.
        for (const nd of shell) nodes.push({ n: nd.n, w: 1 });
      } else {
        for (const nd of shell) {
          const r = radial3(axis, nd.u, nd.v);
          const rl = Math.hypot(r[0], r[1], r[2]);
          if (rl < 1e-9) continue;
          // Bearing: only the wall half facing the load, cosine-weighted.
          const cosT = (r[0] * px + r[1] * py + r[2] * pz) / (rl * pLen);
          if (cosT > 1e-6) nodes.push({ n: nd.n, w: cosT });
        }
        if (!nodes.length) for (const nd of shell) nodes.push({ n: nd.n, w: 1 });
      }
      distributeResultant(F, nodes, dir, mag);
      loadedNodes += nodes.length;
      let reaches = 0;
      for (let d = 0; d < 3; d++) if (free[d]) reaches += Math.abs(dir[d]);
      if (reaches < 1e-6) {
        warnings.push(`Bolt hole ${f.id}: a load vector acts only along fixed axes and is absorbed.`);
      }
    }
  }

  /* --------------------------- Free-standing loads ------------------------ */
  for (const f of scene.forces ?? []) {
    if (!f) continue;
    const mag = Number.isFinite(f.magnitude) ? f.magnitude : 1;
    if (mag === 0) continue;
    const absMag = Math.abs(mag);
    const dir = normalizeDir(f.fx, f.fy, f.fz);
    if (mag < 0) {
      dir[0] = -dir[0];
      dir[1] = -dir[1];
      dir[2] = -dir[2];
    }

    switch (f.type) {
      case 'point_load': {
        const c = normToNodeIndices(nx, ny, nz, f.x, f.y, f.z);
        // 1 axis: the classic single vector at the node. 2-6 axes: a burst, one force per axis
        // direction on the node `spread` cells out along it (see pointLoad.js).
        for (const comp of pointLoadComponents(f, maxDim, loadCase)) {
          const ix = Math.max(0, Math.min(nx, c.ix + comp.off[0]));
          const iy = Math.max(0, Math.min(ny, c.iy + comp.off[1]));
          const iz = Math.max(0, Math.min(nz, c.iz + comp.off[2]));
          const n = idx(ix, iy, iz);
          F[3 * n] += comp.dir[0] * comp.mag;
          F[3 * n + 1] += comp.dir[1] * comp.mag;
          F[3 * n + 2] += comp.dir[2] * comp.mag;
          loadedNodes++;
        }
        break;
      }

      case 'pressure': {
        const c = normToNodeIndices(nx, ny, nz, f.x, f.y, f.z);
        const mode = f.pressureMode === 'directional' ? 'directional' : 'radial';
        const shape = f.shape === 'box' ? 'box' : 'sphere';
        const inwardSign = f.inward ? -1 : 1;
        const useCavity = f.cavityVoid !== false;
        const box = shape === 'box' ? boxHalfCells(f, dims) : null;

        /** Outward unit normal of the cavity wall at a node offset. */
        const outwardNormal = (dx, dy, dz) => {
          let a;
          let b;
          let g;
          if (box) {
            a = Math.abs(dx) === box.rx ? Math.sign(dx) : 0;
            b = Math.abs(dy) === box.ry ? Math.sign(dy) : 0;
            g = Math.abs(dz) === box.rz ? Math.sign(dz) : 0;
          } else {
            a = dx;
            b = dy;
            g = dz;
          }
          const l = Math.hypot(a, b, g);
          if (l < 1e-9) return null;
          return [a / l, b / l, g / l];
        };

        /** @type {{ n: number, w: number, nrm: [number, number, number] }[]} */
        const nodes = [];
        const collect = (ix, iy, iz) => {
          const nrm = outwardNormal(ix - c.ix, iy - c.iy, iz - c.iz);
          if (!nrm) return;
          let w = 1;
          if (mode === 'directional') {
            // Pressure pushes along `dir`; only the wall facing the push is loaded.
            w = nrm[0] * dir[0] + nrm[1] * dir[1] + nrm[2] * dir[2];
            if (w <= 1e-6) return;
          }
          nodes.push({ n: idx(ix, iy, iz), w, nrm: /** @type {[number, number, number]} */ (nrm) });
        };

        if (box) {
          forNodesOnBoxShell(nx, ny, nz, f.x, f.y, f.z, f.hx ?? 0.1, f.hy ?? 0.1, f.hz ?? 0.1, collect);
        } else if (useCavity) {
          // Interface nodes: touch the void cavity AND the solid wall.
          sphereInterfaceNodes(dims, c, sphereRadiusCells(f.radius, maxDim), collect);
        } else {
          forNodesOnSphereShell(nx, ny, nz, f.x, f.y, f.z, f.radius ?? 0.12, collect);
        }

        if (nodes.length === 0) {
          nodes.push({ n: idx(c.ix, c.iy, c.iz), w: 1, nrm: [dir[0], dir[1], dir[2]] });
        }

        if (mode === 'directional') {
          distributeResultant(F, nodes, dir, absMag);
        } else {
          const sign = inwardSign * (mag < 0 ? -1 : 1);
          const share = absMag / nodes.length;
          for (const nd of nodes) {
            F[3 * nd.n] += sign * nd.nrm[0] * share;
            F[3 * nd.n + 1] += sign * nd.nrm[1] * share;
            F[3 * nd.n + 2] += sign * nd.nrm[2] * share;
          }
        }
        loadedNodes += nodes.length;
        break;
      }

      default:
        break;
    }
  }

  return { fixedNodes, loadedNodes, warnings };
}
