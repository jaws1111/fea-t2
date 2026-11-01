import { componentDef, orderedFeatures } from './components/index.js';
import { resolveFitBounds } from './workingVolume.js';
import { createEmptyScene, isSceneEmpty } from './types.js';

/**
 * Fit the FEA grid to the scene's working volume.
 *
 * Everything outside the working volume is permanent void, but the solver still pays
 * for those cells. So for custom scenes the voxel presets are treated as CELL BUDGETS:
 * the grid is chosen with the proportions of the working volume (cubic cells), and when
 * the working volume is smaller than the domain the scene is cropped + re-normalised so
 * the domain IS the working volume. Features keep their physical size and position.
 */

const MIN_CELLS_PER_AXIS = 2;

/**
 * Grid dims with the given physical proportions and about `budget` cells in total.
 * @param {{ x: number, y: number, z: number }} size  any positive extents (same unit)
 * @param {number} budget
 * @returns {{ nx: number, ny: number, nz: number }}
 */
export function fitDimsForBudget(size, budget) {
  const sx = Math.max(1e-6, size.x);
  const sy = Math.max(1e-6, size.y);
  const sz = Math.max(1e-6, size.z);
  const h = Math.cbrt(Math.max(1, budget) / (sx * sy * sz));
  const m = (s) => Math.max(MIN_CELLS_PER_AXIS, Math.round(s * h));
  return { nx: m(sx), ny: m(sy), nz: m(sz) };
}

/**
 * Physical size (in cells of the given grid) of the volume the domain gets fitted to:
 * the working volume, grown where a pressure cavity pokes out of the domain.
 * @returns {{ x: number, y: number, z: number }}
 */
export function workingVolumeSize(scene, dims) {
  const b = resolveFitBounds(scene, dims);
  return {
    x: Math.max(1, (b.x1 - b.x0) * dims.nx),
    y: Math.max(1, (b.y1 - b.y0) * dims.ny),
    z: Math.max(1, (b.z1 - b.z0) * dims.nz),
  };
}

const isFull = (b) =>
  Math.abs(b.x0) <= 1e-9 && Math.abs(b.x1 - 1) <= 1e-9 &&
  Math.abs(b.y0) <= 1e-9 && Math.abs(b.y1 - 1) <= 1e-9 &&
  Math.abs(b.z0) <= 1e-9 && Math.abs(b.z1 - 1) <= 1e-9;

/**
 * Crop a scene to its working volume: returns a deep copy whose normalised coordinates
 * refer to the working volume (which becomes the whole domain, mode 'full').
 * Sizes stored as a fraction of an axis scale by 1 / (extent of that axis); radii (a
 * fraction of the longest axis) by oldMax / newMax; sizes in cells are unchanged.
 *
 * @param {import('./types.js').Scene} scene
 * @param {{ nx: number, ny: number, nz: number }} dims  grid the scene is currently on
 * @returns {{ scene: import('./types.js').Scene, size: { x: number, y: number, z: number } }}
 */
export function cropSceneToWorkingVolume(scene, dims) {
  const b = resolveFitBounds(scene, dims);
  const size = workingVolumeSize(scene, dims);
  const out = JSON.parse(JSON.stringify(scene));
  const rx = Math.max(1e-6, b.x1 - b.x0);
  const ry = Math.max(1e-6, b.y1 - b.y0);
  const rz = Math.max(1e-6, b.z1 - b.z0);
  const range = { x: rx, y: ry, z: rz };
  const oldMax = Math.max(dims.nx, dims.ny, dims.nz);
  const newMax = Math.max(size.x, size.y, size.z);
  const radiusK = oldMax / newMax;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  const pos = (f) => {
    if (Number.isFinite(f.x)) f.x = clamp01((f.x - b.x0) / rx);
    if (Number.isFinite(f.y)) f.y = clamp01((f.y - b.y0) / ry);
    if (Number.isFinite(f.z)) f.z = clamp01((f.z - b.z0) / rz);
  };

  for (const f of orderedFeatures(out)) {
    if (!f) continue;
    pos(f);
    componentDef(f.type)?.crop?.(f, { b, range, radiusK });
  }
  for (const l of out.links ?? []) {
    if (Number.isFinite(l.dx)) l.dx /= rx;
    if (Number.isFinite(l.dy)) l.dy /= ry;
    if (Number.isFinite(l.dz)) l.dz /= rz;
  }
  out.workingVolume = {
    ...(out.workingVolume ?? {}),
    shape: out.workingVolume?.shape ?? 'box',
    mode: 'full',
    bounds: { x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 },
  };
  return { scene: out, size };
}

/**
 * Resolve a voxel preset for a custom scene.
 *
 * @param {import('./types.js').Scene | null | undefined} scene
 * @param {{ nx: number, ny: number, nz: number }} dims  current grid
 * @param {number} budget  cell count of the chosen preset
 * @returns {{ dims: { nx: number, ny: number, nz: number }, scene: import('./types.js').Scene | null, cropped: boolean }}
 */
export function fitGridForScene(scene, dims, budget) {
  if (!scene || isSceneEmpty(scene)) {
    return { dims: fitDimsForBudget({ x: dims.nx, y: dims.ny, z: dims.nz }, budget), scene: scene ?? null, cropped: false };
  }
  const b = resolveFitBounds(scene, dims);
  if (isFull(b)) {
    // The domain already is the working volume: only the resolution changes.
    return {
      dims: fitDimsForBudget({ x: dims.nx, y: dims.ny, z: dims.nz }, budget),
      scene,
      cropped: false,
    };
  }
  const { scene: cropped, size } = cropSceneToWorkingVolume(scene, dims);
  return { dims: fitDimsForBudget(size, budget), scene: cropped, cropped: true };
}

/**
 * Re-mesh the domain onto a box the user chose (e.g. dragged working-volume corners).
 * The box is given in normalized coordinates of the CURRENT domain and may extend past it.
 * The grid gets the box's proportions with cubic voxels and about `budget` cells; the scene is
 * re-normalised so the box becomes the whole domain (works for an empty scene too).
 *
 * @param {import('./types.js').Scene | null | undefined} scene
 * @param {{ nx: number, ny: number, nz: number }} dims
 * @param {{ x0: number, x1: number, y0: number, y1: number, z0: number, z1: number }} bounds
 * @param {number} budget
 * @returns {{ dims: { nx: number, ny: number, nz: number }, scene: import('./types.js').Scene, cropped: boolean }}
 */
export function fitGridForBounds(scene, dims, bounds, budget) {
  const base = scene ? JSON.parse(JSON.stringify(scene)) : createEmptyScene();
  base.workingVolume = { ...(base.workingVolume ?? {}), mode: 'manual', padding: base.workingVolume?.padding ?? 0.06, bounds: { ...bounds } };
  const b = resolveFitBounds(base, dims);
  if (isFull(b)) {
    base.workingVolume = { ...base.workingVolume, mode: 'full', bounds: { x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 } };
    return { dims: fitDimsForBudget({ x: dims.nx, y: dims.ny, z: dims.nz }, budget), scene: base, cropped: false };
  }
  const { scene: cropped, size } = cropSceneToWorkingVolume(base, dims);
  return { dims: fitDimsForBudget(size, budget), scene: cropped, cropped: true };
}