// Classic problems are library recipes. Their supports and loads are compared with
// the boundary-condition masks captured from the old preset code
// (scripts/fixtures/archetype-bc.json).
// Run: node scripts/testArchetypes.mjs
import { readFileSync } from 'node:fs';
import { applyCustomBCs } from '../src/scene/applyCustomBCs.js';
import { buildPassiveMask } from '../src/scene/passiveVoids.js';
import { createComponent, normalizeScene } from '../src/scene/types.js';
import { resolveRecipe } from '../src/library/apply.js';
import { getRecipe } from '../src/library/store.js';
import { createSolverState } from '../src/topo/solverState.js';
import { stepSIMP } from '../src/topo/simpStep.js';

const oracle = JSON.parse(readFileSync(new URL('./fixtures/archetype-bc.json', import.meta.url), 'utf8'));
const EXACT = new Set(['bridge', 'cantilever', 'mbb']);

let failed = 0;
const check = (ok, msg) => {
  if (!ok) {
    failed++;
    console.log(`  X ${msg}`);
  }
};

function f32bits(x) {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = x;
  return new Uint32Array(buf)[0];
}

function nodeOf(dof, nx, ny) {
  const node = Math.floor(dof / 3);
  const stride = (nx + 1) * (ny + 1);
  const iz = Math.floor(node / stride);
  const rem = node - iz * stride;
  const iy = Math.floor(rem / (nx + 1));
  const ix = rem - iy * (nx + 1);
  return { ix, iy, iz, comp: dof % 3 };
}

function applyRecipe(key, budget) {
  const resolved = resolveRecipe(getRecipe(`builtin:${key}`), budget);
  const { nx, ny, nz } = resolved.dims;
  const n = (nx + 1) * (ny + 1) * (nz + 1);
  const fixed = new Uint8Array(3 * n);
  const F = new Float32Array(3 * n);
  applyCustomBCs(fixed, F, nx, ny, nz, resolved.scene);
  const fixedIdx = [];
  const loads = [];
  let fy = 0;
  for (let i = 0; i < fixed.length; i++) if (fixed[i]) fixedIdx.push(i);
  for (let i = 0; i < F.length; i++) {
    if (F[i] === 0) continue;
    loads.push([i, f32bits(F[i])]);
    if (i % 3 === 1) fy += F[i];
  }
  return { ...resolved.dims, fixedIdx, loads, fy, scene: resolved.scene };
}

const sameIdx = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameLoads = (a, b) => a.length === b.length && a.every((v, i) => v[0] === b[i][0] && v[1] === b[i][1]);

const SIMP = { volfrac: 0.3, penal: 3, rmin: 1.5, iters: 4 };

function oracleBC(row) {
  const n = (row.nx + 1) * (row.ny + 1) * (row.nz + 1);
  const fixedDofs = new Uint8Array(3 * n);
  const F = new Float32Array(3 * n);
  const buf = new ArrayBuffer(4);
  const bits = new Uint32Array(buf);
  const value = new Float32Array(buf);
  for (const i of row.fixedIdx) fixedDofs[i] = 1;
  for (const [dof, word] of row.loads) {
    bits[0] = word;
    F[dof] = value[0];
  }
  return { fixedDofs, F };
}

function compliance4(dims, scene, bc) {
  const state = createSolverState({
    nx: dims.nx,
    ny: dims.ny,
    nz: dims.nz,
    volfrac: SIMP.volfrac,
    penal: SIMP.penal,
    rmin: SIMP.rmin,
    scene,
  });
  let last;
  for (let i = 0; i < SIMP.iters; i++) last = stepSIMP(state, bc);
  return last.compliance;
}

for (const [key, rows] of Object.entries(oracle)) {
  for (const row of rows) {
    const got = applyRecipe(key, row.budget);
    check(
      got.nx === row.nx && got.ny === row.ny && got.nz === row.nz,
      `${key} @${row.budget}: grid ${got.nx}x${got.ny}x${got.nz}, oracle ${row.nx}x${row.ny}x${row.nz}`,
    );
    check(sameIdx(got.fixedIdx, row.fixedIdx), `${key} @${row.budget}: fixed DOFs differ (${got.fixedIdx.length} vs ${row.fixedIdx.length})`);
    if (EXACT.has(key) || key === 'deck') {
      check(sameLoads(got.loads, row.loads), `${key} @${row.budget}: load vector is not the captured preset`);
    }
    if (key === 'deck') {
      check(
        buildPassiveMask(got.nx, got.ny, got.nz, got.scene) == null,
        `${key} @${row.budget}: recipe adds passive material`,
      );
      const presetC = compliance4(got, got.scene, oracleBC(row));
      const recipeC = compliance4(got, got.scene);
      const rel = Math.abs(recipeC - presetC) / Math.abs(presetC);
      console.log(
        `  deck @${row.budget}: compliance ${recipeC} vs preset ${presetC} (${(rel * 100).toFixed(4)}%, ${SIMP.iters} iters, volfrac ${SIMP.volfrac}, penal ${SIMP.penal}, rmin ${SIMP.rmin})`,
      );
      check(
        rel <= 0.01,
        `${key} @${row.budget}: compliance ${(rel * 100).toFixed(2)}% off the preset (${recipeC} vs ${presetC})`,
      );
    } else if (key === 'michell') {
      check(Math.abs(got.fy - row.fy) < 1e-6, `${key} @${row.budget}: resultant ${got.fy} vs ${row.fy}`);
      const cols = new Map();
      for (const [dof] of got.loads) {
        const p = nodeOf(dof, got.nx, got.ny);
        cols.set(p.ix, (cols.get(p.ix) ?? 0) + 1);
      }
      const xs = [...cols.keys()].sort((a, b) => a - b);
      check(xs.length === 2, `${key} @${row.budget}: expected 2 load lines, got ${xs.join(',')}`);
      if (xs.length === 2) {
        check(Math.abs(xs[0] - 1) <= 1 && Math.abs(xs[1] - (got.nx - 1)) <= 1,
          `${key} @${row.budget}: load columns ${xs.join(',')} are more than one cell off 1 and ${got.nx - 1}`);
      }
      if (!sameLoads(got.loads, row.loads)) {
        console.log(`  ~ ${key} @${row.budget}: load columns ${xs.join(',')} (preset is 1 and ${got.nx - 1})`);
      }
    }
  }
}

const bridge = resolveRecipe(getRecipe('builtin:bridge'), 4320);
check(bridge.dims.nx === 36 && bridge.dims.ny === 15 && bridge.dims.nz === 8, `bridge default grid ${bridge.dims.nx}x${bridge.dims.ny}x${bridge.dims.nz}`);
check(bridge.scene.workingVolume.mode === 'full', 'bridge recipe keeps the whole domain designable');
check(buildPassiveMask(bridge.dims.nx, bridge.dims.ny, bridge.dims.nz, bridge.scene) == null, 'bridge recipe adds no passive solid');

const domains = ['bridge', 'deck', 'cantilever', 'mbb', 'michell'].map((k) => {
  const d = getRecipe(`builtin:${k}`).meta.domain;
  return `${d.x}:${d.y}:${d.z}`;
});
check(new Set(domains).size === 5, 'every classic recipe has its own domain shape');

const solid = normalizeScene({
  version: 3,
  components: [createComponent('rest_line', { x: 0, y: 0, z: 0.5, axis: 'z', len: 1, solid: true })],
  links: [],
  workingVolume: { shape: 'box', mode: 'full', padding: 0.06, bounds: { x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 } },
});
const painted = buildPassiveMask(8, 6, 4, solid);
check(painted != null && painted.some((v) => v === 2), 'a solid rest line paints passive material');

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('All checks passed.');
