import { getNodeIndex } from '../fea/indexing.js';
import { componentDef, orderedFeatures } from './components/index.js';
import { sceneLoadCaseCount } from './pointLoad.js';
import { resolveWorkingBounds } from './workingVolume.js';

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
 * Supports run before loads. Within a migrated scene that is every fixation, then
 * every bolt load, then every free load.
 *
 * @param {Uint8Array} fixedDofs  length 3 * nNodes
 * @param {Float32Array} F        length 3 * nNodes
 * @param {number} [loadCase]     which load case's multi-axis point loads to apply (see pointLoad.js)
 * @returns {{ fixedNodes: number, loadedNodes: number, warnings: string[] }}
 */
export function applyCustomBCs(fixedDofs, F, nx, ny, nz, scene, loadCase = 0) {
  /** @type {string[]} */
  const warnings = [];
  if (!scene) return { fixedNodes: 0, loadedNodes: 0, warnings };

  const dims = { nx, ny, nz };
  const ctx = {
    fixedDofs,
    F,
    dims,
    maxDim: Math.max(nx, ny, nz),
    wb: resolveWorkingBounds(scene, dims),
    idx: (ix, iy, iz) => getNodeIndex(nx, ny, nz, ix, iy, iz),
    loadCase,
    warnings,
    count: { fixedNodes: 0, loadedNodes: 0 },
  };
  const list = orderedFeatures(scene);
  for (const c of list) componentDef(c?.type)?.fix?.(c, ctx);
  for (const c of list) componentDef(c?.type)?.load?.(c, ctx);
  return { fixedNodes: ctx.count.fixedNodes, loadedNodes: ctx.count.loadedNodes, warnings };
}
