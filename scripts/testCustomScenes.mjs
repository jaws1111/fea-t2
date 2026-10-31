/**
 * Validate the custom-scene model: bolt-hole loads (directional / multi / circular),
 * rigid links, pressure cavities, dims-aware auto working volume, legacy migration,
 * and every shipped example (BCs, passive mask, SIMP iterations).
 *
 * Run: node scripts/testCustomScenes.mjs
 */
import { getNodeIndex } from '../src/fea/indexing.js';
import { analyzeScene, applyCustomBCs } from '../src/scene/applyCustomBCs.js';
import { applyLinksAfterMove, linkFeatures } from '../src/scene/links.js';
import { buildPassiveMask } from '../src/scene/passiveVoids.js';
import { SCENE_EXAMPLES } from '../src/scene/templates.js';
import {
  createEmptyScene,
  createFixation,
  createForce,
  createLoadedHole,
  normalizeScene,
} from '../src/scene/types.js';
import { computeAutoWorkingBounds } from '../src/scene/workingVolume.js';
import { createSolverState } from '../src/topo/solverState.js';
import { stepSIMP } from '../src/topo/simpStep.js';

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
};
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

function bcs(scene, dims) {
  const { nx, ny, nz } = dims;
  const nN = (nx + 1) * (ny + 1) * (nz + 1);
  const fixed = new Uint8Array(3 * nN);
  const F = new Float32Array(3 * nN);
  const res = applyCustomBCs(fixed, F, nx, ny, nz, scene);
  return { fixed, F, ...res };
}

function sumF(F, fixed, onlyFree = false) {
  const s = [0, 0, 0];
  for (let i = 0; i < F.length; i++) if (!(onlyFree && fixed[i])) s[i % 3] += F[i];
  return s;
}

const PLATE = { nx: 36, ny: 15, nz: 8 };

/* ------------------------------------------------------------------ */
console.log('\n[hole loads]');
{
  const hole = (extra) =>
    createLoadedHole({ x: 0.5, y: 0.5, z: 0.5, axis: 'z', radius: 0.06, ...extra });

  let sc = createEmptyScene();
  sc.fixations.push(hole({ loadMode: 'directional', fx: 0, fy: -1, fz: 0, magnitude: 2 }));
  let r = bcs(sc, PLATE);
  let s = sumF(r.F, r.fixed);
  ok(near(s[1], -2, 1e-2) && near(s[0], 0, 1e-2), `directional resultant = (0,-2,0) → (${s.map((v) => v.toFixed(3))})`);
  ok(r.loadedNodes > 0, `loads land on ${r.loadedNodes} bore nodes`);

  sc = createEmptyScene();
  sc.fixations.push(
    hole({
      loadMode: 'multi',
      loads: [
        { fx: 0, fy: -1, fz: 0, magnitude: 1 },
        { fx: 1, fy: 0, fz: 0, magnitude: 0.5 },
      ],
    }),
  );
  r = bcs(sc, PLATE);
  s = sumF(r.F, r.fixed);
  ok(near(s[0], 0.5, 1e-2) && near(s[1], -1, 1e-2), `multi resultant = (0.5,-1,0) → (${s.map((v) => v.toFixed(3))})`);

  sc = createEmptyScene();
  sc.fixations.push(hole({ loadMode: 'circular', circMode: 'torque', magnitude: 1 }));
  r = bcs(sc, PLATE);
  s = sumF(r.F, r.fixed);
  ok(Math.hypot(...s) < 1e-3, `torque is self-balanced (net force ≈ 0): ${s.map((v) => v.toFixed(5))}`);
  // moment about hole axis (z): Σ (x−cx)*Fy − (y−cy)*Fx
  const cx = Math.round(0.5 * PLATE.nx);
  const cy = Math.round(0.5 * PLATE.ny);
  let Mz = 0;
  let absF = 0;
  for (let iz = 0; iz <= PLATE.nz; iz++)
    for (let iy = 0; iy <= PLATE.ny; iy++)
      for (let ix = 0; ix <= PLATE.nx; ix++) {
        const n = getNodeIndex(PLATE.nx, PLATE.ny, PLATE.nz, ix, iy, iz);
        Mz += (ix - cx) * r.F[3 * n + 1] - (iy - cy) * r.F[3 * n];
        absF += Math.abs(r.F[3 * n]) + Math.abs(r.F[3 * n + 1]);
      }
  ok(Mz > 0.5 && absF > 0.9, `torque produces CCW moment about axis (Mz=${Mz.toFixed(2)}, Σ|F|=${absF.toFixed(2)})`);

  sc = createEmptyScene();
  sc.fixations.push(hole({ loadMode: 'circular', circMode: 'radial', magnitude: 1 }));
  r = bcs(sc, PLATE);
  s = sumF(r.F, r.fixed);
  ok(Math.hypot(...s) < 1e-3, 'radial press-fit is self-balanced');

  // Clamped hole absorbing its own load must warn
  sc = createEmptyScene();
  sc.fixations.push(createFixation({ type: 'bolt_hole', x: 0.5, y: 0.5, z: 0.5, loadMode: 'directional', fy: -1 }));
  const an = analyzeScene(sc, PLATE);
  ok(an.warnings.some((w) => w.includes('absorbed')), `fixed-axis load warns: "${an.warnings[0]}"`);

  // Axis unfixed along the load → no absorption warning
  sc = createEmptyScene();
  sc.fixations.push(createFixation({ type: 'bolt_hole', x: 0.2, y: 0.5, z: 0.5 }));
  sc.fixations.push(hole({ x: 0.8, loadMode: 'directional', fy: -1 }));
  ok(analyzeScene(sc, PLATE).warnings.length === 0, 'free hole + clamped hole → no warnings');
}

/* ------------------------------------------------------------------ */
console.log('\n[links]');
{
  const sc = createEmptyScene();
  const a = createFixation({ type: 'bolt_hole', x: 0.2, y: 0.5, z: 0.5 });
  const b = createFixation({ type: 'bolt_hole', x: 0.8, y: 0.4, z: 0.5 });
  const c = createFixation({ type: 'bolt_hole', x: 0.5, y: 0.8, z: 0.5 });
  sc.fixations.push(a, b, c);
  const l1 = linkFeatures(sc, a.id, b.id, PLATE);
  linkFeatures(sc, b.id, c.id, PLATE);
  ok(!!l1 && near(l1.dx, 0.6, 0.03) && near(l1.dy, -0.1, 0.07), `offset stored (dx=${l1.dx.toFixed(3)}, dy=${l1.dy.toFixed(3)}) — diagonal allowed`);
  a.x += 0.05;
  a.y += 0.1;
  applyLinksAfterMove(sc, a.id);
  ok(near(b.x - a.x, l1.dx, 1e-9) && near(b.y - a.y, l1.dy, 1e-9), 'partner follows rigidly');
  ok(near(c.x - b.x, 0.5 - 0.8, 0.03), 'chained link follows too');
  a.x = 0.01;
  a.y = 0.01;
  applyLinksAfterMove(sc, a.id);
  ok([a, b, c].every((f) => f.x >= 0 && f.x <= 1 && f.y >= 0 && f.y <= 1), 'group is shifted into the domain');
  ok(near(b.x - a.x, l1.dx, 1e-9), 'offset preserved after shift-to-fit');
}

/* ------------------------------------------------------------------ */
console.log('\n[legacy migration]');
{
  const legacy = {
    version: 1,
    fixations: [
      { id: 'f1', type: 'bolt_hole', x: 0.2, y: 0.5, z: 0.5, radius: 0.05, axis: 'z', fixX: true, fixY: true, fixZ: true },
      { id: 'f2', type: 'bolt_hole', x: 0.8, y: 0.5, z: 0.5, radius: 0.05, axis: 'z', fixX: true, fixY: true, fixZ: true },
    ],
    forces: [
      { id: 'b1', type: 'bolt_bearing', x: 0.8, y: 0.5, z: 0.5, radius: 0.05, axis: 'z', fx: 0, fy: -1, fz: 0, magnitude: 1 },
    ],
    links: [{ id: 'l1', type: 'distance', aId: 'f1', bId: 'b1', distance: 0.6, axis: 'x' }],
  };
  const sc = normalizeScene(legacy);
  const f2 = sc.fixations.find((f) => f.id === 'f2');
  ok(!sc.forces.some((f) => f.type === 'bolt_bearing'), 'bolt_bearing removed');
  ok(f2.loadMode === 'directional' && f2.fixY === false && f2.fixX === true, 'bearing merged into colocated hole; load axis freed');
  ok(sc.links.length === 1 && sc.links[0].type === 'rigid' && sc.links[0].bId === 'f2', 'distance link → rigid link on the hole');
  const again = JSON.stringify(normalizeScene(JSON.parse(JSON.stringify(sc))));
  ok(again === JSON.stringify(sc), 'normalizeScene is idempotent');
}

/* ------------------------------------------------------------------ */
console.log('\n[auto working volume]');
{
  const dims = { nx: 32, ny: 32, nz: 32 };
  const sc = createEmptyScene();
  sc.forces.push(createForce({ type: 'pressure', shape: 'sphere', x: 0.5, y: 0.8, z: 0.5, radius: 0.2, wall: 3 }));
  const b = computeAutoWorkingBounds(sc, 0, dims);
  const maxDim = 32;
  const R = 0.2 * maxDim + 3; // cavity + wall (cells)
  ok(
    b.y1 * 32 >= 0.8 * 32 + R - 1e-6 || b.y1 >= 1 - 1e-9,
    `volume reaches cavity+wall top (y1=${b.y1.toFixed(3)} ≥ ${((0.8 * 32 + R) / 32).toFixed(3)})`,
  );
  ok(b.x0 * 32 <= 16 - R + 1e-6, `volume reaches cavity+wall side (x0=${b.x0.toFixed(3)})`);
}

/* ------------------------------------------------------------------ */
console.log('\n[examples]');
for (const ex of SCENE_EXAMPLES) {
  console.log(`\n— ${ex.title} (${ex.resolution ?? 'default'}) —`);
  const [nx, ny, nz] = (ex.resolution ?? '36x15x8').split('x').map(Number);
  const dims = { nx, ny, nz };
  const scene = normalizeScene(ex.build());
  scene.workingVolume.mode = 'auto';

  ok(!scene.forces.some((f) => f.type === 'bolt_bearing'), 'no legacy bearing forces');
  const an = analyzeScene(scene, dims);
  ok(an.warnings.length === 0, `no warnings${an.warnings.length ? `: ${an.warnings.join(' | ')}` : ''}`);
  ok(an.absorbed < 0.02, `load absorbed by fixed DOFs: ${(an.absorbed * 100).toFixed(1)}%`);

  // Everything passive (computed on the FULL domain) must lie inside the auto working volume.
  const full = JSON.parse(JSON.stringify(scene));
  full.workingVolume.mode = 'full';
  const mFull = buildPassiveMask(nx, ny, nz, full);
  const wb = computeAutoWorkingBounds(scene, scene.workingVolume.padding ?? 0.06, dims);
  let outside = 0;
  let passive = 0;
  if (mFull) {
    for (let ez = 0; ez < nz; ez++)
      for (let ey = 0; ey < ny; ey++)
        for (let ex = 0; ex < nx; ex++) {
          if (!mFull[ex + nx * (ey + ny * ez)]) continue;
          passive++;
          const inside =
            ex + 0.5 >= wb.x0 * nx && ex + 0.5 <= wb.x1 * nx &&
            ey + 0.5 >= wb.y0 * ny && ey + 0.5 <= wb.y1 * ny &&
            ez + 0.5 >= wb.z0 * nz && ez + 0.5 <= wb.z1 * nz;
          if (!inside) outside++;
        }
  }
  ok(passive > 0 && outside === 0, `working volume encloses all ${passive} passive (hole/cavity/wall/pad) elements`);

  // Every fixed or loaded node must touch at least one non-void element (material to act on).
  const mask = buildPassiveMask(nx, ny, nz, scene);
  // (Wall pads fix whole face patches incl. nodes inside a bore that crosses the face; those
  //  carry no material and are harmless, so they are excluded from this check.)
  const noPads = JSON.parse(JSON.stringify(scene));
  noPads.fixations = noPads.fixations.filter((f) => f.type !== 'wall_pad');
  const r = bcs(noPads, dims);
  let detached = 0;
  let touched = 0;
  for (let iz = 0; iz <= nz; iz++)
    for (let iy = 0; iy <= ny; iy++)
      for (let ix = 0; ix <= nx; ix++) {
        const n = getNodeIndex(nx, ny, nz, ix, iy, iz);
        const active = r.F[3 * n] || r.F[3 * n + 1] || r.F[3 * n + 2] || r.fixed[3 * n] || r.fixed[3 * n + 1] || r.fixed[3 * n + 2];
        if (!active) continue;
        touched++;
        let solid = false;
        for (let ez = iz - 1; ez <= iz; ez++)
          for (let ey = iy - 1; ey <= iy; ey++)
            for (let ex = ix - 1; ex <= ix; ex++) {
              if (ex < 0 || ey < 0 || ez < 0 || ex >= nx || ey >= ny || ez >= nz) continue;
              if (!mask || mask[ex + nx * (ey + ny * ez)] !== 1) solid = true;
            }
        if (!solid) detached++;
      }
  ok(touched > 0 && detached === 0, `all ${touched} BC nodes are attached to material (${detached} floating)`);

  const net = sumF(r.F, r.fixed, true);
  console.log(`  net free load = (${net.map((v) => v.toFixed(2)).join(', ')})`);

  if (ex.id === 'gas_cylinder') {
    ok(net[1] > 0.5, 'lid thrust gives the bolts a net axial load');
    const hasPressure = scene.forces.filter((f) => f.type === 'pressure').length === 2;
    ok(hasPressure, 'radial + lid-thrust pressure objects present');
  }

  const state = createSolverState({
    nx, ny, nz, volfrac: ex.volfrac ?? 0.3, penal: 3, rmin: 1.5, preset: 'custom', scene,
  });
  let last;
  for (let i = 0; i < 4; i++) last = stepSIMP(state);
  let bossOk = 0;
  let bossN = 0;
  let voidOk = 0;
  let voidN = 0;
  for (let e = 0; e < mask.length; e++) {
    if (mask[e] === 2) {
      bossN++;
      if (state.xPhys[e] > 0.99) bossOk++;
    } else if (mask[e] === 1) {
      voidN++;
      if (state.xPhys[e] < 0.01) voidOk++;
    }
  }
  ok(Number.isFinite(last.compliance) && last.compliance > 0, `SIMP ok: C=${last.compliance.toFixed(2)}`);
  ok(bossOk >= bossN * 0.99 && voidOk >= voidN * 0.99, `passive regions held (solid ${bossOk}/${bossN}, void ${voidOk}/${voidN})`);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
