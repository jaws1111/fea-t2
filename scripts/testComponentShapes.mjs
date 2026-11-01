/**
 * Observable behaviour of the wall, rest, and fix-load shapes added after the
 * line and face loads: active surfaces, passive material, cylinder pressure.
 *
 * Run: node scripts/testComponentShapes.mjs
 */
import * as THREE from 'three';
import { getNodeIndex } from '../src/fea/indexing.js';
import { analyzeScene, applyCustomBCs } from '../src/scene/applyCustomBCs.js';
import { buildPassiveMask } from '../src/scene/passiveVoids.js';
import { getCustomFixtureDescriptors } from '../src/scene/fixturesFromScene.js';
import { createComponent, createEmptyScene, normalizeScene } from '../src/scene/types.js';
import { computeAutoWorkingBounds } from '../src/scene/workingVolume.js';
import { updateBoundaryFixtures } from '../src/viz/boundaryFixtures.js';

const DIMS = { nx: 32, ny: 32, nz: 32 };

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
};

function sceneOf(components, mode = 'full') {
  const scene = createEmptyScene();
  scene.workingVolume.mode = mode;
  scene.components = components;
  return normalizeScene(scene);
}

function bcs(scene) {
  const { nx, ny, nz } = DIMS;
  const nN = (nx + 1) * (ny + 1) * (nz + 1);
  const fixed = new Uint8Array(3 * nN);
  const F = new Float32Array(3 * nN);
  const res = applyCustomBCs(fixed, F, nx, ny, nz, scene);
  return { fixed, F, ...res };
}

function fixedNodes(scene) {
  const { nx, ny, nz } = DIMS;
  const r = bcs(scene);
  /** @type {Set<number>} */
  const set = new Set();
  for (let iz = 0; iz <= nz; iz++) {
    for (let iy = 0; iy <= ny; iy++) {
      for (let ix = 0; ix <= nx; ix++) {
        const n = getNodeIndex(nx, ny, nz, ix, iy, iz);
        if (r.fixed[3 * n] || r.fixed[3 * n + 1] || r.fixed[3 * n + 2]) set.add(n);
      }
    }
  }
  return set;
}

function maskCounts(scene) {
  const { nx, ny, nz } = DIMS;
  const mask = buildPassiveMask(nx, ny, nz, scene);
  let solid = 0;
  let voids = 0;
  if (mask) {
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 2) solid++;
      else if (mask[i] === 1) voids++;
    }
  }
  return { mask, solid, voids };
}

function detachedCount(scene) {
  const { nx, ny, nz } = DIMS;
  const r = bcs(scene);
  const { mask } = maskCounts(scene);
  let touched = 0;
  let detached = 0;
  for (let iz = 0; iz <= nz; iz++) {
    for (let iy = 0; iy <= ny; iy++) {
      for (let ix = 0; ix <= nx; ix++) {
        const n = getNodeIndex(nx, ny, nz, ix, iy, iz);
        const active = r.fixed[3 * n] || r.fixed[3 * n + 1] || r.fixed[3 * n + 2]
          || r.F[3 * n] || r.F[3 * n + 1] || r.F[3 * n + 2];
        if (!active) continue;
        touched++;
        let material = false;
        for (let ez = iz - 1; ez <= iz && !material; ez++) {
          for (let ey = iy - 1; ey <= iy && !material; ey++) {
            for (let ex = ix - 1; ex <= ix && !material; ex++) {
              if (ex < 0 || ey < 0 || ez < 0 || ex >= nx || ey >= ny || ez >= nz) continue;
              if (!mask || mask[ex + nx * (ey + ny * ez)] !== 1) material = true;
            }
          }
        }
        if (!material) detached++;
      }
    }
  }
  return { touched, detached };
}

function enclosed(scene) {
  const { nx, ny, nz } = DIMS;
  const full = JSON.parse(JSON.stringify(scene));
  full.workingVolume.mode = 'full';
  const mask = buildPassiveMask(nx, ny, nz, full);
  const wb = computeAutoWorkingBounds(scene, 0, DIMS);
  let outside = 0;
  let passive = 0;
  if (!mask) return { passive, outside };
  for (let ez = 0; ez < nz; ez++) {
    for (let ey = 0; ey < ny; ey++) {
      for (let ex = 0; ex < nx; ex++) {
        if (!mask[ex + nx * (ey + ny * ez)]) continue;
        passive++;
        const inside =
          ex + 0.5 >= wb.x0 * nx && ex + 0.5 <= wb.x1 * nx &&
          ey + 0.5 >= wb.y0 * ny && ey + 0.5 <= wb.y1 * ny &&
          ez + 0.5 >= wb.z0 * nz && ez + 0.5 <= wb.z1 * nz;
        if (!inside) outside++;
      }
    }
  }
  return { passive, outside };
}

const load = () => createComponent('point_load', { x: 0.08, y: 0.08, z: 0.08, fx: 0, fy: -1, fz: 0, magnitude: 1 });

const NEW_TYPES = ['wall_cylinder', 'wall_prism', 'surround', 'rest_ring', 'rest_pad', 'block'];

console.log('\n[normalize]');
for (const type of NEW_TYPES) {
  const scene = sceneOf([createComponent(type)]);
  const again = JSON.stringify(normalizeScene(JSON.parse(JSON.stringify(scene))));
  ok(again === JSON.stringify(scene), `${type} normalize is idempotent`);
}
const cylP = sceneOf([createComponent('pressure', { shape: 'cylinder', radius: 0.12, len: 0.6 })]);
ok(cylP.components[0].shape === 'cylinder' && cylP.components[0].axis === 'z', 'cylinder pressure keeps shape');
const cylAgain = JSON.stringify(normalizeScene(JSON.parse(JSON.stringify(cylP))));
ok(cylAgain === JSON.stringify(cylP), 'cylinder pressure normalize is idempotent');

console.log('\n[cylinder wall]');
{
  const base = { x: 0.5, y: 0.5, z: 0.5, axis: 'z', len: 1, radius: 0.16, wall: 2, fixX: true, fixY: true, fixZ: true };
  const inner = fixedNodes(sceneOf([createComponent('wall_cylinder', { ...base, active: 'inner' })]));
  const outer = fixedNodes(sceneOf([createComponent('wall_cylinder', { ...base, active: 'outer' })]));
  const both = fixedNodes(sceneOf([createComponent('wall_cylinder', { ...base, active: 'both' })]));
  ok(inner.size > 8 && outer.size > 8, `inner ${inner.size} and outer ${outer.size} both clamp a ring`);
  let shared = 0;
  for (const n of inner) if (outer.has(n)) shared++;
  ok(shared === 0, `inner and outer surfaces share no nodes (${shared})`);
  ok(both.size === inner.size + outer.size, `both is the union (${both.size} vs ${inner.size}+${outer.size})`);
  const hollow = sceneOf([createComponent('wall_cylinder', { ...base, active: 'inner' })]);
  const { solid, voids } = maskCounts(hollow);
  ok(voids > 0 && solid > 0, `hollow cylinder voids the bore (${voids}) and keeps a wall (${solid})`);
  const { touched, detached } = detachedCount(hollow);
  ok(touched > 0 && detached === 0, `cylinder wall nodes sit on material (${detached} floating)`);
  const filled = maskCounts(sceneOf([createComponent('wall_cylinder', { ...base, active: 'outer' })]));
  ok(filled.voids === 0 && filled.solid > solid, 'outer-only cylinder is a solid bar');
  const auto = sceneOf([createComponent('wall_cylinder', { ...base, active: 'both' })], 'auto');
  const box = enclosed(auto);
  ok(box.passive > 0 && box.outside === 0, `auto volume encloses the cylinder wall (${box.outside} outside)`);
}

console.log('\n[prism wall]');
{
  const base = { x: 0.5, y: 0.5, z: 0.5, axis: 'z', len: 1, radius: 0.2, wall: 2, active: 'inner', rotation: 0 };
  const tri = fixedNodes(sceneOf([createComponent('wall_prism', { ...base, n: 3 })]));
  const hex = fixedNodes(sceneOf([createComponent('wall_prism', { ...base, n: 6 })]));
  ok(tri.size > 8 && hex.size > 8, `triangle ${tri.size} and hexagon ${hex.size} both clamp`);
  let onlyTri = 0;
  for (const n of tri) if (!hex.has(n)) onlyTri++;
  ok(onlyTri > 0, `triangle and hexagon clamps differ (${onlyTri} nodes)`);
  const scene = sceneOf([createComponent('wall_prism', base)]);
  const { touched, detached } = detachedCount(scene);
  ok(touched > 0 && detached === 0, `prism wall nodes sit on material (${detached} floating)`);
  const g = getCustomFixtureDescriptors(scene, DIMS.nx, DIMS.ny, DIMS.nz);
  ok(g.length === 1 && g[0].kind === 'shell' && g[0].profile === 'prism' && g[0].n === 6, 'prism glyph names the polygon');
}

console.log('\n[surround]');
{
  const sphere = sceneOf([createComponent('surround', {
    shape: 'sphere', x: 0.5, y: 0.5, z: 0.5, radius: 0.22, wall: 2, active: 'inner',
  })]);
  const sm = maskCounts(sphere);
  ok(sm.voids > 0 && sm.solid > 0, `sphere surround has a cavity (${sm.voids}) and a shell (${sm.solid})`);
  const centre = sm.mask[16 + 32 * (16 + 32 * 16)];
  ok(centre === 1, 'sphere cavity contains the centre element');
  const { touched, detached } = detachedCount(sphere);
  ok(touched > 0 && detached === 0, `sphere surround nodes sit on material (${detached} floating)`);
  const ngon = sceneOf([createComponent('surround', {
    shape: 'ngon', n: 4, x: 0.5, y: 0.5, z: 0.5, radius: 0.2, wall: 2, len: 0.6, active: 'both',
  })]);
  const nm = maskCounts(ngon);
  ok(nm.voids > 0 && nm.solid > 0, `n-gon surround has caps and a wall (${nm.voids} void, ${nm.solid} solid)`);
  const nd = detachedCount(ngon);
  ok(nd.touched > 0 && nd.detached === 0, `n-gon surround nodes sit on material (${nd.detached} floating)`);
  const both = fixedNodes(ngon);
  const innerOnly = fixedNodes(sceneOf([createComponent('surround', {
    shape: 'ngon', n: 4, x: 0.5, y: 0.5, z: 0.5, radius: 0.2, wall: 2, len: 0.6, active: 'inner',
  })]));
  ok(both.size > innerOnly.size, `both clamps more of the closed shell (${both.size} > ${innerOnly.size})`);
}

console.log('\n[rest ring and pad]');
{
  const ring = sceneOf([createComponent('rest_ring', { x: 0.5, y: 0.5, z: 0.35, axis: 'z', radius: 0.15 })]);
  const { nx, ny, nz } = DIMS;
  const r = bcs(ring);
  /** @type {number[]} */
  const axial = [];
  let radialOk = 0;
  let radialN = 0;
  const R = Math.max(1, 0.15 * 32);
  const cx = Math.round(0.5 * nx);
  const cy = Math.round(0.5 * ny);
  for (let iz = 0; iz <= nz; iz++) {
    for (let iy = 0; iy <= ny; iy++) {
      for (let ix = 0; ix <= nx; ix++) {
        const n = getNodeIndex(nx, ny, nz, ix, iy, iz);
        if (!r.fixed[3 * n]) continue;
        axial.push(iz);
        radialN++;
        if (Math.abs(Math.hypot(ix - cx, iy - cy) - R) <= 0.75 + 1e-6) radialOk++;
      }
    }
  }
  ok(radialN > 8 && axial.every((z) => z === axial[0]), `rest ring is one circle (${radialN} nodes, iz ${axial[0]})`);
  ok(radialOk === radialN, `every ring node lies on the radius (${radialOk}/${radialN})`);
  const rd = detachedCount(ring);
  ok(rd.detached === 0, `rest ring nodes sit on material (${rd.detached} floating)`);

  const pad = sceneOf([createComponent('rest_pad', {
    x: 0.5, y: 0.45, z: 0.5, axis: 'y', width: 0.2, height: 0.2, depth: 1,
  })]);
  const pr = bcs(pad);
  let padN = 0;
  let plane = -1;
  let onBoundary = 0;
  const py = Math.round(0.45 * ny);
  for (let iz = 0; iz <= nz; iz++) {
    for (let iy = 0; iy <= ny; iy++) {
      for (let ix = 0; ix <= nx; ix++) {
        const n = getNodeIndex(nx, ny, nz, ix, iy, iz);
        if (!pr.fixed[3 * n]) continue;
        padN++;
        plane = iy;
        if (ix === 0 || ix === nx || iz === 0 || iz === nz || iy === 0 || iy === ny) onBoundary++;
      }
    }
  }
  ok(padN > 4 && padN < 80 && plane === py && onBoundary === 0, `rest pad is an interior patch (${padN} nodes at iy ${plane})`);
  const pd = detachedCount(pad);
  ok(pd.detached === 0, `rest pad nodes sit on material (${pd.detached} floating)`);
}

console.log('\n[block]');
{
  const solid = sceneOf([createComponent('block', { x: 0.5, y: 0.5, z: 0.5, hx: 0.1, hy: 0.1, hz: 0.1 })]);
  const sm = maskCounts(solid);
  const applied = bcs(solid);
  ok(applied.fixedNodes === 0 && applied.loadedNodes === 0, 'a block fixes and loads nothing');
  ok(sm.solid > 0 && sm.voids === 0, `solid block paints ${sm.solid} elements`);
  const hole = sceneOf([createComponent('block', { x: 0.5, y: 0.5, z: 0.5, hx: 0.1, hy: 0.1, hz: 0.1, void: true })]);
  const hm = maskCounts(hole);
  ok(hm.voids === sm.solid && hm.solid === 0, 'void block occupies the same elements as the solid block');
  const g = getCustomFixtureDescriptors(solid, 32, 32, 32);
  ok(g[0]?.kind === 'block' && g[0].void === false, 'block glyph marks a solid');
}

console.log('\n[cylinder pressure]');
{
  const scene = sceneOf([createComponent('pressure', {
    shape: 'cylinder', x: 0.5, y: 0.5, z: 0.5, axis: 'z', radius: 0.12, len: 0.5, wall: 2,
    pressureMode: 'radial', magnitude: 1, cavityVoid: true,
  })]);
  const r = bcs(scene);
  let magSum = 0;
  const net = [0, 0, 0];
  for (let n = 0; n < r.F.length; n += 3) {
    magSum += Math.hypot(r.F[n], r.F[n + 1], r.F[n + 2]);
    net[0] += r.F[n];
    net[1] += r.F[n + 1];
    net[2] += r.F[n + 2];
  }
  ok(Math.abs(magSum - 1) < 1e-4, `radial cylinder pressure resultant is 1 (${magSum.toFixed(4)})`);
  ok(Math.hypot(...net) < 1e-4, `radial cylinder pressure is balanced (${net.map((v) => v.toFixed(4)).join(', ')})`);
  const { solid, voids } = maskCounts(scene);
  ok(voids > 0 && solid > 0, `cylinder cavity is void (${voids}) with a wall (${solid})`);
  const { touched, detached } = detachedCount(scene);
  ok(touched > 0 && detached === 0, `cylinder pressure loads the wall (${detached} floating)`);
  const g = getCustomFixtureDescriptors(scene, 32, 32, 32);
  ok(g[0]?.kind === 'pressure' && g[0].shape === 'cylinder' && g[0].radius > 1, 'cylinder pressure glyph carries a radius');
}

console.log('\n[rigid-body check]');
{
  const point = sceneOf([createComponent('rest_point', { x: 0.5, y: 0.5, z: 0.5, radius: 0.02 })]);
  const pw = analyzeScene(point, DIMS).warnings;
  ok(pw.some((w) => w.includes('rigid-body')), `one rest point is under-restrained (${pw.join(' | ')})`);
  const tube = sceneOf([
    createComponent('wall_cylinder', { active: 'both', radius: 0.16, len: 1, wall: 2 }),
    load(),
  ]);
  const tw = analyzeScene(tube, DIMS).warnings;
  ok(!tw.some((w) => w.includes('rigid-body')), `a clamped tube restrains rigid motion (${tw.join(' | ') || 'none'})`);
}

console.log('\n[glyphs draw]');
{
  const scene = sceneOf([
    createComponent('wall_cylinder', { active: 'both', radius: 0.14 }),
    createComponent('wall_prism', { n: 5, radius: 0.18, x: 0.3 }),
    createComponent('surround', { shape: 'sphere', radius: 0.2 }),
    createComponent('rest_ring', { radius: 0.1, z: 0.3 }),
    createComponent('rest_pad', { y: 0.4, width: 0.2, height: 0.2 }),
    createComponent('block', { x: 0.7, hx: 0.08, hy: 0.08, hz: 0.08 }),
    createComponent('pressure', { shape: 'cylinder', radius: 0.1, len: 0.4, x: 0.7 }),
  ]);
  const group = new THREE.Group();
  updateBoundaryFixtures(group, { ...DIMS, preset: 'custom', scene });
  ok(group.children.length >= 7, `glyph group has a mesh per shape (${group.children.length})`);
}

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nAll component-shape checks passed.');
