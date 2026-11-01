/**
 * Stage Optimizer core: grid sizing, density transfer, warm-started solver state.
 * Run: node scripts/testStages.mjs
 */
import { dimsForVoxelTarget, resampleDensity } from '../src/topo/resample.js';
import { createSolverState, resetSolverState } from '../src/topo/solverState.js';
import { stepSIMP } from '../src/topo/simpStep.js';
import { buildPassiveMask } from '../src/scene/passiveVoids.js';
import { createTwoBoltBracketScene } from '../src/scene/templates.js';
import { normalizeScene } from '../src/scene/types.js';

let failures = 0;
const ok = (c, m) => {
  console.log(`  ${c ? '✓' : '✗'} ${m}`);
  if (!c) failures++;
};

console.log('[grid sizing]');
const base = { nx: 36, ny: 15, nz: 8 };
for (const t of [24_000, 50_000, 100_000]) {
  const d = dimsForVoxelTarget(base, t);
  const aspectErr = Math.max(
    Math.abs(d.nx / d.ny - base.nx / base.ny) / (base.nx / base.ny),
    Math.abs(d.ny / d.nz - base.ny / base.nz) / (base.ny / base.nz),
  );
  ok(Math.abs(d.total - t) / t < 0.06, `${t} → ${d.nx}×${d.ny}×${d.nz} = ${d.total}`);
  ok(aspectErr < 0.12, `aspect kept (err ${(aspectErr * 100).toFixed(1)}%)`);
}

console.log('\n[resample]');
{
  const sx = 8, sy = 4, sz = 4;
  const src = new Float32Array(sx * sy * sz).fill(0.37);
  const up = resampleDensity(src, sx, sy, sz, 20, 10, 10);
  ok(up.every((v) => Math.abs(v - 0.37) < 1e-6), 'constant field preserved');

  // x-gradient (cell-centred): value = (i + 0.5) / sx  → must stay linear in the interior
  const grad = new Float32Array(sx * sy * sz);
  for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) grad[i + sx * (j + sy * k)] = (i + 0.5) / sx;
  const dx = 16;
  const g2 = resampleDensity(grad, sx, sy, sz, dx, 8, 8);
  let maxErr = 0;
  for (let i = 1; i < dx - 1; i++) maxErr = Math.max(maxErr, Math.abs(g2[i] - (i + 0.5) / dx));
  ok(maxErr < 1e-5, `linear gradient reproduced (max err ${maxErr.toExponential(1)})`);

  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const step = new Float32Array(sx * sy * sz);
  for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) step[i + sx * (j + sy * k)] = i < 4 ? 1 : 0;
  const s2 = resampleDensity(step, sx, sy, sz, 24, 12, 12);
  ok(Math.abs(mean(s2) - 0.5) < 0.02, `volume fraction preserved (${mean(s2).toFixed(3)})`);
  ok(resampleDensity(step, sx, sy, sz, sx, sy, sz).every((v, i) => v === step[i]), 'identity on same grid');
}

console.log('\n[warm start]');
{
  const scene = normalizeScene(createTwoBoltBracketScene());
  const a = { nx: 36, ny: 15, nz: 8 };
  const sA = createSolverState({ ...a, volfrac: 0.3, penal: 3, rmin: 1.6, scene });
  let r;
  for (let i = 0; i < 6; i++) r = stepSIMP(sA);
  const cA = r.compliance;
  const b = dimsForVoxelTarget(a, 24_000);
  const sB = createSolverState({ ...b, volfrac: 0.3, penal: 3, rmin: 3, scene });
  // reuse path (worker RESET on existing state)
  resetSolverState(sB, {
    ...b, volfrac: 0.3, penal: 3, rmin: 3, scene,
    initDensity: { ...a, data: Float32Array.from(sA.xPhys), sharpen: 0.25 },
  });
  const mask = buildPassiveMask(b.nx, b.ny, b.nz, scene);
  let solidOk = 0, solidN = 0, voidOk = 0, voidN = 0;
  for (let e = 0; e < mask.length; e++) {
    if (mask[e] === 2) { solidN++; if (sB.xPhys[e] > 0.99) solidOk++; }
    if (mask[e] === 1) { voidN++; if (sB.xPhys[e] < 0.01) voidOk++; }
  }
  ok(solidOk === solidN && voidOk === voidN, 'passive regions re-applied on the fine grid');
  // The seeded field must NOT be uniform volfrac any more
  let varSum = 0;
  for (let i = 0; i < sB.x.length; i++) varSum += (sB.x[i] - 0.3) ** 2;
  ok(varSum / sB.x.length > 0.02, 'seeded field carries the coarse design');
  const r0 = stepSIMP(sB);
  ok(Number.isFinite(r0.compliance) && r0.compliance > 0, `fine-grid iteration 1 ok (C=${r0.compliance.toFixed(2)}; coarse C=${cA.toFixed(2)})`);
  for (let i = 0; i < 3; i++) stepSIMP(sB);
  ok(Math.abs(sB.xPhys.reduce((s, v) => s + v, 0) / sB.xPhys.length - 0.3) < 0.15, 'volume fraction remains sane');

  // fresh start from uniform for comparison: warm start should begin with lower compliance
  const sC = createSolverState({ ...b, volfrac: 0.3, penal: 3, rmin: 3, scene });
  const rc = stepSIMP(sC);
  ok(r0.compliance < rc.compliance, `warm start beats uniform start (${r0.compliance.toFixed(2)} < ${rc.compliance.toFixed(2)})`);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
