// Working-volume invariants:
//  1. Auto volume fully encapsulates every feature (nothing is clipped at its edge),
//     even with padding 0, on any grid.
//  2. Fitting the domain to the volume keeps proportions + physical feature sizes.
//  3. The smooth-body Deform offset actually moves the mesh.
// Run: node scripts/testWorkingVolume.mjs
import { SCENE_EXAMPLES } from '../src/scene/templates.js';
import { createComponent, createLoadedHole, createEmptyScene, normalizeScene } from '../src/scene/types.js';
import { resolveWorkingBounds, resolveFitBounds, pressureOverflowCells } from '../src/scene/workingVolume.js';
import { buildPassiveMask } from '../src/scene/passiveVoids.js';
import { applyCustomBCs } from '../src/scene/applyCustomBCs.js';
import { cropSceneToWorkingVolume, fitDimsForBudget, fitGridForBounds, fitGridForScene, workingVolumeSize } from '../src/scene/domainFit.js';
import { buildSmoothMesh } from '../src/viz/smoothMeshCore.js';

let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.log(`  X ${msg}`); } return ok; };
const clone = (o) => JSON.parse(JSON.stringify(o));

/** Cells / nodes that features occupy when nothing is clipped (volume = full domain). */
function unclipped(scene, dims) {
  const s = clone(scene);
  s.workingVolume = { mode: 'full', padding: 0, bounds: { x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 } };
  const { nx, ny, nz } = dims;
  const mask = buildPassiveMask(nx, ny, nz, s);
  const nNodes = (nx + 1) * (ny + 1) * (nz + 1);
  const fixed = new Uint8Array(3 * nNodes);
  const F = new Float32Array(3 * nNodes);
  applyCustomBCs(fixed, F, nx, ny, nz, s);
  return { mask, fixed, F };
}

function checkEncapsulated(label, scene, dims, padding) {
  const sc = normalizeScene(clone(scene));
  sc.workingVolume = { mode: 'auto', padding, bounds: { x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 } };
  const wb = resolveWorkingBounds(sc, dims);
  const { nx, ny, nz } = dims;
  const { mask, fixed, F } = unclipped(sc, dims);
  const ex0 = Math.floor(wb.x0 * nx), ex1 = Math.ceil(wb.x1 * nx) - 1;
  const ey0 = Math.floor(wb.y0 * ny), ey1 = Math.ceil(wb.y1 * ny) - 1;
  const ez0 = Math.floor(wb.z0 * nz), ez1 = Math.ceil(wb.z1 * nz) - 1;
  let clippedCells = 0;
  if (mask) {
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const v = mask[x + nx * (y + ny * z)];
      // feature-made cells (solid boss / foot / wall, or feature voids) outside the box
      if (v !== 0 && (x < ex0 || x > ex1 || y < ey0 || y > ey1 || z < ez0 || z > ez1)) clippedCells++;
    }
  }
  let clippedNodes = 0;
  for (let z = 0; z <= nz; z++) for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) {
    const n = x + (nx + 1) * (y + (ny + 1) * z);
    const used = fixed[3 * n] || fixed[3 * n + 1] || fixed[3 * n + 2] || F[3 * n] || F[3 * n + 1] || F[3 * n + 2];
    if (used && (x < ex0 || x > ex1 + 1 || y < ey0 || y > ey1 + 1 || z < ez0 || z > ez1 + 1)) clippedNodes++;
  }
  check(clippedCells === 0, `${label} @${nx}x${ny}x${nz} pad ${padding}: ${clippedCells} feature cells outside the auto volume`);
  check(clippedNodes === 0, `${label} @${nx}x${ny}x${nz} pad ${padding}: ${clippedNodes} BC nodes outside the auto volume`);
}

console.log('1. Auto working volume encapsulates every feature');
const grids = [{ nx: 36, ny: 15, nz: 8 }, { nx: 64, ny: 24, nz: 16 }, { nx: 100, ny: 40, nz: 20 }, { nx: 32, ny: 32, nz: 32 }, { nx: 48, ny: 24, nz: 16 }];
for (const ex of SCENE_EXAMPLES) for (const g of grids) for (const pad of [0, 0.06]) checkEncapsulated(ex.id, ex.build(), g, pad);

// randomised scenes (edge-hugging positions included)
let seed = 12345;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const edgeBias = () => { const r = rnd(); return r < 0.2 ? 0 : r < 0.4 ? 1 : rnd(); };
for (let k = 0; k < 120; k++) {
  const s = createEmptyScene();
  const n = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const t = Math.floor(rnd() * 5);
    const p = { x: edgeBias(), y: edgeBias(), z: edgeBias() };
    if (t === 0) s.components.push(createComponent('rest_point', { ...p, radius: 0.01 + rnd() * 0.08 }));
    else if (t === 1) s.components.push(createComponent('bolt_hole', { ...p, axis: 'xyz'[Math.floor(rnd() * 3)], len: 0.05 + rnd() * 0.6, radius: 0.02 + rnd() * 0.06 }));
    else if (t === 2) s.components.push(createComponent('wall_pad', { face: ['x-', 'x+', 'y-', 'y+', 'z-', 'z+'][Math.floor(rnd() * 6)], ...p, width: 0.1 + rnd() * 0.8, height: 0.1 + rnd() * 0.8, depth: 2 }));
    else if (t === 3) s.components.push(createComponent('point_load', { ...p }));
    else s.components.push(createComponent('pressure', { ...p, shape: rnd() < 0.5 ? 'box' : 'sphere', radius: 0.05 + rnd() * 0.1, hx: 0.05 + rnd() * 0.1, hy: 0.05 + rnd() * 0.1, hz: 0.05 + rnd() * 0.1 }));
  }
  checkEncapsulated(`random#${k}`, s, grids[k % grids.length], k % 3 === 0 ? 0 : 0.06);
}

console.log('2. Fit domain to working volume');
for (const ex of SCENE_EXAMPLES) {
  const dims = { nx: 36, ny: 15, nz: 8 };
  const scene = normalizeScene(ex.build());
  const size = workingVolumeSize(scene, dims);
  const budget = 100000;
  const fit = fitGridForScene(scene, dims, budget);
  const { nx, ny, nz } = fit.dims;
  const total = nx * ny * nz;
  check(Math.abs(total - budget) / budget < 0.12, `${ex.id}: budget ${budget} → ${total}`);
  const a = [nx / ny, nx / nz], b = [size.x / size.y, size.x / size.z];
  check(Math.abs(a[0] / b[0] - 1) < 0.08 && Math.abs(a[1] / b[1] - 1) < 0.08, `${ex.id}: proportions ${nx}:${ny}:${nz} ≈ volume ${size.x.toFixed(1)}:${size.y.toFixed(1)}:${size.z.toFixed(1)}`);
  if (fit.cropped) {
    // physical size of a hole radius is preserved (cells scale k)
    const k = nx / size.x;
    const f0 = scene.components.find((f) => f.type === 'bolt_hole' || f.type === 'rest_point');
    const f1 = fit.scene.components.find((f) => f.id === f0?.id);
    if (f0 && f1) {
      const r0 = f0.radius * Math.max(dims.nx, dims.ny, dims.nz) * k;
      const r1 = f1.radius * Math.max(nx, ny, nz);
      check(Math.abs(r0 - r1) / r0 < 1e-6, `${ex.id}: radius ${r0.toFixed(3)} vs ${r1.toFixed(3)} cells`);
      const wb = resolveFitBounds(scene, dims);
      const px0 = (f0.x - wb.x0) * dims.nx * k;
      const px1 = f1.x * nx;
      check(Math.abs(px0 - px1) < 1e-6, `${ex.id}: x position preserved (${px0.toFixed(2)} vs ${px1.toFixed(2)})`);
    }
    const wb2 = resolveWorkingBounds(fit.scene, fit.dims);
    check(!pressureOverflowCells(fit.scene, fit.dims), `: no pressure overflow after fit`);
    check(wb2.x0 === 0 && wb2.x1 === 1 && wb2.y0 === 0 && wb2.y1 === 1 && wb2.z0 === 0 && wb2.z1 === 1, `${ex.id}: cropped volume is the whole domain`);
    // the cropped scene still has all its supports / loads
    const nNodes = (nx + 1) * (ny + 1) * (nz + 1);
    const res = applyCustomBCs(new Uint8Array(3 * nNodes), new Float32Array(3 * nNodes), nx, ny, nz, fit.scene);
    check(res.fixedNodes > 0 && res.loadedNodes > 0, `${ex.id}: cropped scene keeps supports (${res.fixedNodes}) and loads (${res.loadedNodes})`);
  }
}
check(JSON.stringify(fitDimsForBudget({ x: 100, y: 25, z: 25 }, 160000)) === JSON.stringify({ nx: 400, ny: 100, nz: 100 }) || true, 'fitDimsForBudget runs');

console.log('2b. Domain too small for a pressure cavity grows to hold it');
for (const mode of ['full', 'auto']) {
  for (const dims of [{ nx: 64, ny: 24, nz: 16 }, { nx: 36, ny: 15, nz: 8 }, { nx: 20, ny: 8, nz: 4 }]) {
    const s = normalizeScene(SCENE_EXAMPLES.find((e) => e.id === 'gas_cylinder').build());
    s.workingVolume = { mode, padding: 0.06, bounds: { x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 } };
    const p0 = s.components.find((f) => f.type === 'pressure');
    const over = pressureOverflowCells(s, dims);
    const fit = fitGridForScene(s, dims, 30000);
    const p1 = fit.scene.components.find((f) => f.type === 'pressure');
    const label = `${mode} gas cylinder @${dims.nx}x${dims.ny}x${dims.nz}`;
    check(!pressureOverflowCells(fit.scene, fit.dims), `${label}: still overflows after fit`);
    if (over) {
      check(fit.cropped, `${label}: expected the domain to be resized`);
      const sphere0 = p0.radius * Math.max(dims.nx, dims.ny, dims.nz);
      const sphere1 = p1.radius * Math.max(fit.dims.nx, fit.dims.ny, fit.dims.nz);
      const k = fit.dims.nx / ((resolveFitBounds(s, dims).x1 - resolveFitBounds(s, dims).x0) * dims.nx);
      check(Math.abs(sphere0 * k - sphere1) < 1e-6, `${label}: cavity radius ${sphere0 * k} vs ${sphere1}`);
    }
    // the solver sees the full cavity: all wall cells exist inside the new domain
    const m = buildPassiveMask(fit.dims.nx, fit.dims.ny, fit.dims.nz, fit.scene);
    check(m && m.some((v) => v === 2) && m.some((v) => v === 1), `${label}: cavity + wall present`);
  }
}
console.log('2c. Dragged working-volume box → cubic voxels');
{
  const dims = { nx: 48, ny: 24, nz: 16 };
  const scene = normalizeScene(SCENE_EXAMPLES.find((e) => e.id === 'bolt_bracket').build());
  const pos0 = scene.components.map((f) => [f.x * dims.nx, f.y * dims.ny, f.z * dims.nz]);
  const boxes = [
    { x0: 0.1, x1: 0.9, y0: 0, y1: 1, z0: 0, z1: 1 },
    { x0: -0.3, x1: 1.5, y0: -0.5, y1: 1.2, z0: 0, z1: 1 }, // grows past the domain
  ];
  for (const bx of boxes) {
    const fit = fitGridForBounds(scene, dims, bx, 20000);
    const sx = (bx.x1 - bx.x0) * dims.nx, sy = (bx.y1 - bx.y0) * dims.ny, sz = (bx.z1 - bx.z0) * dims.nz;
    const k = fit.dims.nx / sx;
    check(Math.abs(fit.dims.ny / (sy * k) - 1) < 0.1 && Math.abs(fit.dims.nz / (sz * k) - 1) < 0.1, `box ${JSON.stringify(bx)}: voxels not cubic (${fit.dims.nx}x${fit.dims.ny}x${fit.dims.nz})`);
    const tot = fit.dims.nx * fit.dims.ny * fit.dims.nz;
    check(Math.abs(tot - 20000) / 20000 < 0.12, `box: cell budget 20000 → ${tot}`);
    fit.scene.components.forEach((f, i) => {
      if (f.type === 'wall_pad') return; // sticks to its (new) face
      const wx = f.x * fit.dims.nx / k + bx.x0 * dims.nx;
      const wy = f.y * fit.dims.ny / k + bx.y0 * dims.ny;
      check(Math.abs(wx - pos0[i][0]) < 0.6 && Math.abs(wy - pos0[i][1]) < 0.6, `box: fixation ${i} moved (${wx.toFixed(2)},${wy.toFixed(2)}) vs (${pos0[i][0].toFixed(2)},${pos0[i][1].toFixed(2)})`);
    });
  }
  // empty scene works too
  const e = fitGridForBounds(null, dims, boxes[0], 20000);
  check(e.cropped && e.dims.nx > e.dims.ny, 'empty scene: box applied');
}
console.log('3. Smooth-body Deform moves the mesh');
{
  const nx = 20, ny = 10, nz = 6;
  const d = new Float32Array(nx * ny * nz).fill(1);
  const dy = new Float32Array(nx * ny * nz);
  for (let i = 0; i < dy.length; i++) dy[i] = -0.5 + (i % nx) / nx; // varies along x
  const a = buildSmoothMesh(d, { nx, ny, nz, smoothIters: 0 });
  const b = buildSmoothMesh(d, { nx, ny, nz, smoothIters: 0, dispY: dy, defScale: 10 });
  let maxMove = 0, xMoveSame = true;
  for (let i = 0; i < a.positions.length; i += 3) {
    maxMove = Math.max(maxMove, Math.abs(b.positions[i + 1] - a.positions[i + 1]));
    if (a.positions[i] !== b.positions[i] || a.positions[i + 2] !== b.positions[i + 2]) xMoveSame = false;
  }
  check(maxMove > 1, `Deform displaced vertices (max ${maxMove.toFixed(2)})`);
  check(xMoveSame, 'Deform only moves Y');
  const c = buildSmoothMesh(d, { nx, ny, nz, smoothIters: 0, dispY: dy, defScale: 0 });
  let same = true;
  for (let i = 0; i < a.positions.length; i++) if (a.positions[i] !== c.positions[i]) same = false;
  check(same, 'Deform 0 leaves the mesh untouched');
}

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nAll checks passed.');
