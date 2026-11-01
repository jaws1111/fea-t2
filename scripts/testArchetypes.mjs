// Every problem archetype meshes its own working-volume shape with cubic voxels.
// Run: node scripts/testArchetypes.mjs
import { ARCHETYPES, archetypeDims } from '../src/presets/archetypes.js';
import { applyBCs } from '../src/presets/boundaryConditions.js';

let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.log(`  X ${msg}`); } };

const budgets = [640, 4320, 11520, 24576, 100000, 300000];
for (const [key, a] of Object.entries(ARCHETYPES)) {
  for (const budget of budgets) {
    const d = archetypeDims(key, budget);
    const total = d.nx * d.ny * d.nz;
    const tol = budget < 2000 ? 0.45 : 0.15; // tiny grids are limited by whole cells
    check(Math.abs(total - budget) / budget < tol, `${key} @${budget}: ${d.nx}x${d.ny}x${d.nz} = ${total}`);
    if (budget >= 4320) {
      const k = d.ny / a.volume.y; // cells per unit length
      check(Math.abs(d.nx / (a.volume.x * k) - 1) < 0.12 && Math.abs(d.nz / (a.volume.z * k) - 1) < 0.2,
        `${key} @${budget}: voxels not cubic for ${JSON.stringify(a.volume)} → ${d.nx}x${d.ny}x${d.nz}`);
    }
    // the static boundary conditions still produce supports and loads on this grid
    const n = (d.nx + 1) * (d.ny + 1) * (d.nz + 1);
    const fixed = new Uint8Array(3 * n);
    const F = new Float32Array(3 * n);
    applyBCs(fixed, F, d.nx, d.ny, d.nz, key);
    const nf = fixed.reduce((s, v) => s + v, 0);
    const nl = F.reduce((s, v) => s + (v !== 0 ? 1 : 0), 0);
    check(nf > 0 && nl > 0, `${key} @${budget}: supports ${nf}, loads ${nl}`);
  }
}
// the original default grid is exactly the Bridge Arch shape at 4,320 cells
const b = archetypeDims('bridge', 4320);
check(b.nx === 36 && b.ny === 15 && b.nz === 8, `bridge default grid ${b.nx}x${b.ny}x${b.nz}`);
// shapes are individually defined
const sig = new Set(Object.values(ARCHETYPES).map((a) => `${a.volume.x}:${a.volume.y}:${a.volume.z}`));
check(sig.size === Object.keys(ARCHETYPES).length, 'every archetype has its own volume shape');

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('All checks passed.');
