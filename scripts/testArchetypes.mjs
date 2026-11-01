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

for (const [key, rows] of Object.entries(oracle)) {
  for (const row of rows) {
    const got = applyRecipe(key, row.budget);
    check(
      got.nx === row.nx && got.ny === row.ny && got.nz === row.nz,
      `${key} @${row.budget}: grid ${got.nx}x${got.ny}x${got.nz}, oracle ${row.nx}x${row.ny}x${row.nz}`,
    );
    check(sameIdx(got.fixedIdx, row.fixedIdx), `${key} @${row.budget}: fixed DOFs differ (${got.fixedIdx.length} vs ${row.fixedIdx.length})`);
    if (EXACT.has(key)) {
      check(sameLoads(got.loads, row.loads), `${key} @${row.budget}: load vector is not the captured preset`);
    } else if (key === 'deck') {
      const gotSet = new Set(got.loads.map((v) => v[0]));
      const missing = row.loads.filter((v) => !gotSet.has(v[0]));
      const oracleSet = new Set(row.loads.map((v) => v[0]));
      const extras = got.loads.filter((v) => !oracleSet.has(v[0])).map((v) => nodeOf(v[0], got.nx, got.ny));
      check(missing.length === 0, `${key} @${row.budget}: recipe dropped ${missing.length} preset load nodes`);
      check(
        extras.every((p) => p.comp === 1 && (p.ix === 0 || p.ix === got.nx) && p.iy === got.ny),
        `${key} @${row.budget}: extra loads are not the two top edge columns`,
      );
      check(Math.abs(got.fy - row.fy) < 1e-6, `${key} @${row.budget}: resultant ${got.fy} vs ${row.fy}`);
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
