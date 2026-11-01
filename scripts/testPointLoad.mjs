import { applyCustomBCs, analyzeScene } from '../src/scene/applyCustomBCs.js';
import { getCustomFixtureDescriptors } from '../src/scene/fixturesFromScene.js';
import { createEmptyScene, createComponent, normalizeScene } from '../src/scene/types.js';
import { computeAutoWorkingBounds } from '../src/scene/workingVolume.js';
import { defaultPointDirs, pointLoadDirs, sceneLoadCaseCount } from '../src/scene/pointLoad.js';
import { createSolverState } from '../src/topo/solverState.js';
import { stepSIMP } from '../src/topo/simpStep.js';
import { loadCaseCount } from '../src/topo/loadCases.js';

let failed = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'V' : 'X'} ${msg}`);
  if (!ok) failed++;
};

const nx = 20, ny = 20, nz = 20;
const nodes = (nx + 1) * (ny + 1) * (nz + 1);

function load(partial, loadCase = 0) {
  const scene = createEmptyScene();
  scene.components.push(createComponent('point_load', { x: 0.5, y: 0.5, z: 0.5, ...partial }));
  normalizeScene(scene);
  const fixed = new Uint8Array(3 * nodes);
  const F = new Float32Array(3 * nodes);
  applyCustomBCs(fixed, F, nx, ny, nz, scene, loadCase);
  const loaded = [];
  const net = [0, 0, 0];
  let abs = 0;
  for (let n = 0; n < nodes; n++) {
    const a = Math.hypot(F[3 * n], F[3 * n + 1], F[3 * n + 2]);
    if (a > 0) loaded.push({ n, f: [F[3 * n], F[3 * n + 1], F[3 * n + 2]] });
    for (let d = 0; d < 3; d++) net[d] += F[3 * n + d];
    abs += a;
  }
  return { scene, loaded, net, abs };
}

console.log('1. Single axis is unchanged');
{
  const r = load({ fx: 0, fy: -1, fz: 0, magnitude: 2 });
  check(r.loaded.length === 1, 'one loaded node');
  check(Math.abs(r.loaded[0].f[1] + 2) < 1e-6 && r.loaded[0].f[0] === 0, 'force = (0,-2,0)');
  check(sceneLoadCaseCount(r.scene) === 1, 'one load case');
}

console.log('2. Separate load cases (default)');
for (const n of [2, 3, 4, 5, 6]) {
  const probe = load({ axes: n, magnitude: 1.5 });
  check(sceneLoadCaseCount(probe.scene) === n, `${n} axes -> ${n} load cases`);
  const dirs = pointLoadDirs(probe.scene.components[0]);
  let ok = new Set(dirs).size === n;
  for (let k = 0; k < n; k++) {
    const r = load({ axes: n, magnitude: 1.5 }, k);
    // exactly one loaded node (the point itself) carrying |F| along that case's direction
    ok = ok && r.loaded.length === 1 && Math.abs(r.abs - 1.5) < 1e-5;
  }
  check(ok, `${n} axes -> each case = one force of |F| at the point, ${n} unique directions`);
}
{
  const up = load({ axes: 2, dirs: ['y+', 'y-'], magnitude: 1 }, 0);
  const down = load({ axes: 2, dirs: ['y+', 'y-'], magnitude: 1 }, 1);
  check(up.loaded[0].f[1] > 0 && down.loaded[0].f[1] < 0 && up.loaded[0].n === down.loaded[0].n, 'up and down are separate cases on the same node');
  const all6 = [0, 1, 2, 3, 4, 5].map((k) => load({ axes: 6, magnitude: 1 }, k).loaded[0].f.join());
  check(new Set(all6).size === 6, '6 axes = six different directions across the cases');
}

console.log('3. Burst (all at once)');
for (const n of [2, 3, 6]) {
  const r = load({ axes: n, axesMode: 'burst', magnitude: 1.5, radius: 0.1 });
  check(sceneLoadCaseCount(r.scene) === 1, `burst ${n} axes is a single case`);
  check(r.loaded.length === n && Math.abs(r.abs - 1.5 * n) < 1e-4, `burst ${n} axes -> ${n} loaded nodes, total ${1.5 * n}`);
}
{
  const r = load({ axes: 6, axesMode: 'burst', magnitude: 1, radius: 0.1 });
  check(r.net.every((v) => Math.abs(v) < 1e-5), '6-axis burst is self-balanced');
}

console.log('4. Directions');
{
  check(defaultPointDirs({ fy: -1 }, 2).join() === 'y-,y+', '2 axes = pair along the force axis');
  check(defaultPointDirs({ fy: -1 }, 6).length === 6, '6 axes = all');
  const bad = load({ axes: 4, dirs: ['q+', 'x+'] });
  check(pointLoadDirs(bad.scene.components[0]).length === 4, 'invalid direction list is repaired to 4 axes');
}

console.log('5. Glyphs, working volume, analysis');
{
  const six = load({ axes: 6 });
  const d = getCustomFixtureDescriptors(six.scene, nx, ny, nz).filter((x) => x.kind === 'load');
  check(d.length === 6 && d.every((x) => x.lead > 0), 'cases: one arrow per axis, tail at the point');
  const burst = load({ axes: 6, axesMode: 'burst', radius: 0.1 });
  const nodesSet = new Set(
    getCustomFixtureDescriptors(burst.scene, nx, ny, nz).filter((x) => x.kind === 'load').map((x) => `${x.ix},${x.iy},${x.iz}`),
  );
  check(nodesSet.size === 6, 'burst: arrows sit on six different nodes');
  const single = load({});
  check(getCustomFixtureDescriptors(single.scene, nx, ny, nz).filter((x) => x.kind === 'load').length === 1, 'single = one arrow');
  const wide = computeAutoWorkingBounds(burst.scene, 0, { nx, ny, nz });
  const one = computeAutoWorkingBounds(single.scene, 0, { nx, ny, nz });
  check(wide.x1 - wide.x0 > one.x1 - one.x0, 'auto working volume covers a burst');
  const scene = createEmptyScene();
  scene.components.push(createComponent('rest_point', { x: 0.1, y: 0, z: 0.5 }));
  scene.components.push(createComponent('point_load', { axes: 2, dirs: ['y+', 'y-'], x: 0.5, y: 0.5, z: 0.5 }));
  const an = analyzeScene(normalizeScene(scene), { nx, ny, nz });
  check(an.loadedNodes >= 1 && an.fixedNodes > 0, 'analysis handles load cases');
}

console.log('6. Optimization: up/down load with two rests connects to both supports');
{
  const gx = 24, gy = 10, gz = 6;
  const build = (mode) => {
    const scene = createEmptyScene();
    scene.workingVolume = { mode: 'full', padding: 0, bounds: { x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 } };
    scene.components.push(
      createComponent('rest_point', { x: 0.08, y: 0, z: 0.5, radius: 0.06 }),
      createComponent('rest_point', { x: 0.92, y: 0, z: 0.5, radius: 0.06 }),
    );
    scene.components.push(
      createComponent('point_load', { x: 0.5, y: 0.7, z: 0.5, axes: 2, dirs: ['y-', 'y+'], axesMode: mode, magnitude: 1, radius: 0.1 }),
    );
    normalizeScene(scene);
    const state = createSolverState({ nx: gx, ny: gy, nz: gz, volfrac: 0.2, penal: 3, rmin: 1.5, scene });
    return state;
  };
  const connected = (state) => {
    // BFS through elements with density > 0.4 from the load element to a rest element.
    const idx = (x, y, z) => x + gx * (y + gy * z);
    const start = idx(Math.round(0.5 * gx - 0.5), Math.round(0.7 * gy - 0.5), Math.round(0.5 * gz - 0.5));
    const seen = new Uint8Array(gx * gy * gz);
    const q = [];
    // seed from the dense elements nearest the load
    for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = Math.round(0.5 * gx - 0.5) + dx, y = Math.round(0.7 * gy - 0.5) + dy, z = Math.round(0.5 * gz - 0.5) + dz;
      if (x < 0 || y < 0 || z < 0 || x >= gx || y >= gy || z >= gz) continue;
      const i = idx(x, y, z);
      if (state.xPhys[i] > 0.4 && !seen[i]) { seen[i] = 1; q.push([x, y, z]); }
    }
    void start;
    let left = false, right = false;
    while (q.length) {
      const [x, y, z] = q.pop();
      if (y <= 1 && x <= 3) left = true;
      if (y <= 1 && x >= gx - 4) right = true;
      for (const [ax, ay, az] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const X = x + ax, Y = y + ay, Z = z + az;
        if (X < 0 || Y < 0 || Z < 0 || X >= gx || Y >= gy || Z >= gz) continue;
        const i = idx(X, Y, Z);
        if (seen[i] || state.xPhys[i] <= 0.4) continue;
        seen[i] = 1;
        q.push([X, Y, Z]);
      }
    }
    return left && right;
  };

  const cases = build('cases');
  check(loadCaseCount(cases) === 2, 'solver sees 2 load cases');
  let first = 0, last = 0;
  for (let i = 0; i < 40; i++) {
    const r = stepSIMP(cases);
    if (i === 0) first = r.compliance;
    last = r.compliance;
  }
  check(Number.isFinite(last) && last > 0 && last < first, `load-case compliance decreases (${first.toFixed(1)} -> ${last.toFixed(1)})`);
  check(connected(cases), 'load cases: the structure links the load to BOTH rest points');

  const burst = build('burst');
  check(loadCaseCount(burst) === 1, 'burst runs as one case');
  for (let i = 0; i < 40; i++) stepSIMP(burst);
  console.log(`    (burst connects to rests: ${connected(burst)} — a self-balanced load needs no support)`);
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll checks passed.');
