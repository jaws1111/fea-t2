// Smooth-body mesher invariants: closed, consistently wound OUTWARD, vertex normals agree
// with the winding, small speckle is removed. Run: node scripts/testSmoothMesh.mjs
import { buildSmoothMesh, cleanSpeckle } from '../src/viz/smoothMeshCore.js';

let failed = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'V' : 'X'} ${msg}`); if (!ok) failed++; };

const nx = 40, ny = 24, nz = 12;
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const d = new Float32Array(nx * ny * nz);
for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
  const arch = Math.abs(Math.hypot((x - 20) / 18, (y - 2) / 20) - 0.8) < 0.18 ? 1 : 0;
  d[x + nx * (y + ny * z)] = Math.min(1, arch * (0.3 + 0.9 * rnd()) + (rnd() < 0.1 ? 0.6 : 0));
}
const lut = new Float32Array(768).fill(0.5);

for (const smoothIters of [0, 4]) {
  console.log(`smoothIters=${smoothIters}`);
  const r = buildSmoothMesh(d, { nx, ny, nz, iso: 0.45, smoothIters, lut });
  const { positions: P, indices: I, normals: N } = r;
  const dir = new Set();
  for (let i = 0; i < I.length; i += 3) for (let k = 0; k < 3; k++) dir.add(`${I[i + k]},${I[i + (k + 1) % 3]}`);
  let open = 0;
  for (const key of dir) { const [a, b] = key.split(','); if (!dir.has(`${b},${a}`)) open++; }
  check(open === 0, `closed + consistently wound (${open} unmatched edges)`);

  let vol = 0, disagree = 0;
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
    vol += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    const ax = P[b] - P[a], ay = P[b + 1] - P[a + 1], az = P[b + 2] - P[a + 2];
    const bx = P[c] - P[a], by = P[c + 1] - P[a + 1], bz = P[c + 2] - P[a + 2];
    const fx = ay * bz - az * by, fy = az * bx - ax * bz, fz = ax * by - ay * bx;
    const dot = fx * (N[a] + N[b] + N[c]) + fy * (N[a + 1] + N[b + 1] + N[c + 1]) + fz * (N[a + 2] + N[b + 2] + N[c + 2]);
    if (dot < 0) disagree++;
  }
  check(vol > 0, `outward orientation (signed volume ${vol.toFixed(0)})`);
  check(disagree / (I.length / 3) < 0.01, `normals follow winding (${disagree} of ${I.length / 3} disagree)`);
  check(r.colors && r.colors.length === P.length, 'one colour per vertex');
}

// Speckle: a 3-cell pocket in a solid block is filled; a big void is kept.
{
  const w = 40, h = 20, t = 10;
  const f = new Float32Array(w * h * t).fill(1);
  const id = (x, y, z) => x + w * (y + h * z);
  f[id(5, 5, 0)] = 0.2; f[id(6, 5, 0)] = 0.2; f[id(5, 6, 0)] = 0.1;
  for (let y = 3; y < 17; y++) for (let x = 20; x < 30; x++) for (let z = 0; z < t; z++) f[id(x, y, z)] = 0;
  const c = cleanSpeckle(f, w, h, t, 0.45);
  check(c.filled.length === 3, `small pocket filled (${c.filled.length})`);
  check(c.dens[id(25, 8, 4)] === 0, 'large void kept open');
}

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nAll checks passed.');
