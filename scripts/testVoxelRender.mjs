// Voxel renderer: compaction (culling), neighbour masks (AO input), LOD, smooth-body AO.
// Run: node scripts/testVoxelRender.mjs
import { updateVisualization, OPAQUE_RHO } from '../src/viz/updateVisualization.js';
import { LOD_THRESHOLDS } from '../src/viz/voxelShared.js';
import { buildSmoothMesh } from '../src/viz/smoothMeshCore.js';
import { buildColorLut } from '../src/viz/updateVisualization.js';

let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.log(`  X ${msg}`); } };

function fakeMesh(total) {
  const mk = (n) => ({
    array: new Float32Array(total * n),
    itemSize: n,
    ranges: [],
    clearUpdateRanges() { this.ranges = []; },
    addUpdateRange(s, c) { this.ranges.push([s, c]); },
    needsUpdate: false,
  });
  const geoms = [{ instanceCount: 0 }, { instanceCount: 0 }, { instanceCount: 0 }];
  return {
    visible: false,
    geometry: geoms[0],
    material: { userData: {}, metalness: 0.25, roughness: 0.38 },
    userData: {
      voxels: {
        cells: total,
        geoms,
        attrs: { aPos: mk(3), aColor: mk(3), aScale: mk(1), aOcc: mk(2) },
        solid: new Uint8Array(total),
        opaque: new Uint8Array(total),
        visible: 0,
      },
    },
  };
}
const cfg = (nx, ny, nz, extra = {}) => ({ nx, ny, nz, cutoff: 0.18, defScale: 0, viewMode: 'cubes', colorMode: 'density', ao: true, ...extra });
const bit = (lo, hi, dx, dy, dz) => {
  const n = (dx + 1) + 3 * (dy + 1) + 9 * (dz + 1);
  const b = n < 13 ? n : n - 1;
  return b < 13 ? (lo >> b) & 1 : (hi >> (b - 13)) & 1;
};

console.log('1. Compaction');
{
  const n = 10;
  const mesh = fakeMesh(n * n * n);
  const d = new Float32Array(n * n * n).fill(1);
  updateVisualization({ mesh, densities: d, config: cfg(n, n, n) });
  const v = mesh.userData.voxels;
  check(v.visible === n ** 3 - (n - 2) ** 3, `solid block: ${v.visible} visible, expected ${n ** 3 - (n - 2) ** 3} (shell only)`);
  check(mesh.userData.voxels.geoms.every((g) => g.instanceCount === v.visible), 'instanceCount follows the visible count');
  check(v.attrs.aPos.ranges[0][1] === v.visible * 3, 'only the used prefix is uploaded');

  // voids are not submitted
  const e = new Float32Array(n ** 3).fill(0.05);
  updateVisualization({ mesh, densities: e, config: cfg(n, n, n) });
  check(v.visible === 0, `void field: ${v.visible} visible`);

  // loose "mini element" interior (density below OPAQUE_RHO) must stay visible: gaps show it
  const loose = new Float32Array(n ** 3).fill(OPAQUE_RHO - 0.1);
  updateVisualization({ mesh, densities: loose, config: cfg(n, n, n) });
  check(v.visible === n ** 3, `loose block keeps all ${n ** 3} voxels (got ${v.visible})`);

  // cutoff hides sparse voxels
  const half = new Float32Array(n ** 3).fill(0.3);
  updateVisualization({ mesh, densities: half, config: cfg(n, n, n, { cutoff: 0.4 }) });
  check(v.visible === 0, 'cutoff above density hides everything');
}

console.log('2. Neighbour masks');
{
  const nx = 4, ny = 4, nz = 4;
  const mesh = fakeMesh(nx * ny * nz);
  const d = new Float32Array(nx * ny * nz);
  // L shape: floor slab (y=0) plus one wall column at x=0
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) d[x + nx * 0 + nx * ny * z] = 1;
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) d[0 + nx * y + nx * ny * z] = 1;
  updateVisualization({ mesh, densities: d, config: cfg(nx, ny, nz) });
  const v = mesh.userData.voxels;
  const pos = v.attrs.aPos.array, occ = v.attrs.aOcc.array;
  // find the voxel at cell (1,0,1) (floor next to the wall) → centre (1 - 2 + 0.5, 0 - 2 + 0.5, 1 - 2 + 0.5)
  let found = -1;
  for (let k = 0; k < v.visible; k++) {
    if (pos[k * 3] === 1 - 1.5 && pos[k * 3 + 1] === 0 - 1.5 && pos[k * 3 + 2] === 1 - 1.5) found = k;
  }
  check(found >= 0, 'voxel (1,0,1) is visible');
  if (found >= 0) {
    const lo = occ[found * 2], hi = occ[found * 2 + 1];
    check(bit(lo, hi, -1, 0, 0) === 1, 'wall neighbour (-1,0,0) set');
    check(bit(lo, hi, -1, 1, 0) === 1, 'wall neighbour above-left (-1,1,0) set');
    check(bit(lo, hi, 1, 0, 0) === 1, 'floor neighbour (+1,0,0) set');
    check(bit(lo, hi, 0, 1, 0) === 0, 'air above (0,1,0) clear');
    check(bit(lo, hi, 1, 1, 0) === 0, 'air above-right (1,1,0) clear');
    check(bit(lo, hi, 0, -1, 0) === 0, 'below the domain is empty');
  }
  // masks fit exactly in float32 (13 bits each)
  let ok = true;
  for (let k = 0; k < v.visible * 2; k++) if (occ[k] < 0 || occ[k] >= 8192 || !Number.isInteger(occ[k])) ok = false;
  check(ok, 'masks are integers below 2^13');
}

console.log('3. Level of detail');
{
  const n = 50; // 125k loose voxels → coarsest cube mesh
  const mesh = fakeMesh(n * n * n);
  updateVisualization({ mesh, densities: new Float32Array(n ** 3).fill(0.5), config: cfg(n, n, n, { ao: false }) });
  check(mesh.geometry === mesh.userData.voxels.geoms[2], `125k visible → coarsest mesh (limits ${LOD_THRESHOLDS.rounded1})`);
  const m2 = fakeMesh(10 * 10 * 10);
  updateVisualization({ mesh: m2, densities: new Float32Array(1000).fill(0.5), config: cfg(10, 10, 10) });
  check(m2.geometry === m2.userData.voxels.geoms[0], '1k visible → finest mesh');
}

console.log('4. Smooth-body AO');
{
  const nx = 16, ny = 12, nz = 8;
  const d = new Float32Array(nx * ny * nz);
  // L-shaped solid: slab + wall → inner corner crease along z
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    if (y < 4 || x < 5) d[x + nx * y + nx * ny * z] = 1;
  }
  const lut = buildColorLut('metal');
  const base = { nx, ny, nz, iso: 0.45, smoothIters: 3, lut, colorMode: 'metal' };
  const off = buildSmoothMesh(d, { ...base, ao: false });
  const on = buildSmoothMesh(d, { ...base, ao: true });
  check(on.colors && off.colors && on.colors.length === off.colors.length, 'colours present');
  let darker = 0, same = 0, brighter = 0, crease = 0, creaseDark = 0, topSame = 0, topN = 0;
  for (let v = 0; v < on.colors.length / 3; v++) {
    const a = on.colors[v * 3], b = off.colors[v * 3];
    if (a < b - 1e-6) darker++; else if (a > b + 1e-6) brighter++; else same++;
    const x = on.positions[v * 3], y = on.positions[v * 3 + 1];
    // inner corner of the L: x ≈ 5 - nx/2, y ≈ 4 - ny/2
    if (Math.abs(x - (4.5 - nx / 2 + 0.5)) < 1.2 && Math.abs(y - (3.5 - ny / 2 + 0.5)) < 1.2 && on.normals[v * 3 + 2] < 0.3 && on.normals[v * 3 + 2] > -0.3) {
      crease++;
      if (a < b * 0.85) creaseDark++;
    }
    if (on.normals[v * 3 + 1] > 0.95 && x > 2 && x < 5 && y > 1 - ny / 2 && y < 4 - ny / 2 + 0.6) { topN++; if (a > b * 0.98) topSame++; }
  }
  check(brighter === 0, `AO never brightens (${brighter})`);
  check(darker > 0, 'AO darkens some vertices');
  check(crease > 0 && creaseDark / crease > 0.4, `inner crease is darkened (${creaseDark}/${crease})`);
  check(topN === 0 || topSame / topN > 0.9, `open flat skin stays bright (${topSame}/${topN})`);
}

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nAll checks passed.');
