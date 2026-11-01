import { edgeTable, triTable } from './marchingCubes.js';

/**
 * Smooth-body mesher: padded node field → box blur → marching cubes (indexed, vertices
 * shared through a typed-array edge cache) → Taubin smoothing on CSR adjacency →
 * area-weighted normals. Pure function over typed arrays, so it runs unchanged in a
 * Web Worker (see smoothWorker.js) or in Node tests.
 *
 * Replaces the old pipeline that welded the triangle soup twice with string-keyed maps
 * (the dominant cost of the Smooth Body view).
 */

const CORNER_DX = [0, 1, 1, 0, 0, 1, 1, 0];
const CORNER_DY = [0, 0, 1, 1, 0, 0, 1, 1];
const CORNER_DZ = [0, 0, 0, 0, 1, 1, 1, 1];
const EDGE_CORNERS = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/** Per edge: lower corner offset, axis (0=x,1=y,2=z), and the two corner ids low→high. */
const EDGE_INFO = EDGE_CORNERS.map(([a, b]) => {
  const ax = CORNER_DX[a] !== CORNER_DX[b] ? 0 : CORNER_DY[a] !== CORNER_DY[b] ? 1 : 2;
  const lowIsA = [CORNER_DX, CORNER_DY, CORNER_DZ][ax][a] < [CORNER_DX, CORNER_DY, CORNER_DZ][ax][b];
  const low = lowIsA ? a : b;
  const high = lowIsA ? b : a;
  return { axis: ax, dx: CORNER_DX[low], dy: CORNER_DY[low], dz: CORNER_DZ[low], low, high };
});

/**
 * Element-centred densities → node field with a 1-node void pad (closed surface) and a
 * 3³ box blur (separable: three 1-D passes).
 */
/**
 * Remove speckle that would otherwise show up as scales / pits in the surface: small
 * enclosed void pockets (grey, sub-threshold elements the surface merely grazes) are
 * filled and tiny floating solid islands are dropped. Components are 6-connected on the
 * element grid, the domain outside is NOT counted as void, so a pit on a boundary face
 * is a small pocket, while real openings (arch spans, bolt holes) are large components
 * and stay open. The size limit scales with the grid.
 *
 * @returns {{ dens: Float32Array, filled: Int32Array }} cleaned densities + filled void elements
 */
export function cleanSpeckle(densities, nx, ny, nz, iso) {
  const n = nx * ny * nz;
  const maxHole = Math.max(6, Math.min(80, Math.round(n / 1500)));
  const maxIsland = Math.max(4, Math.round(maxHole / 2));
  const dens = new Float32Array(densities);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  const filledList = [];
  const sy = nx;
  const sz = nx * ny;
  let qs = 0;
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    const solid = densities[s] >= iso;
    let qe = qs;
    queue[qe++] = s;
    seen[s] = 1;
    for (let h = qs; h < qe; h++) {
      const e = queue[h];
      const x = e % nx;
      const y = ((e / nx) | 0) % ny;
      const z = (e / sz) | 0;
      if (x > 0 && !seen[e - 1] && (densities[e - 1] >= iso) === solid) { seen[e - 1] = 1; queue[qe++] = e - 1; }
      if (x < nx - 1 && !seen[e + 1] && (densities[e + 1] >= iso) === solid) { seen[e + 1] = 1; queue[qe++] = e + 1; }
      if (y > 0 && !seen[e - sy] && (densities[e - sy] >= iso) === solid) { seen[e - sy] = 1; queue[qe++] = e - sy; }
      if (y < ny - 1 && !seen[e + sy] && (densities[e + sy] >= iso) === solid) { seen[e + sy] = 1; queue[qe++] = e + sy; }
      if (z > 0 && !seen[e - sz] && (densities[e - sz] >= iso) === solid) { seen[e - sz] = 1; queue[qe++] = e - sz; }
      if (z < nz - 1 && !seen[e + sz] && (densities[e + sz] >= iso) === solid) { seen[e + sz] = 1; queue[qe++] = e + sz; }
    }
    const size = qe - qs;
    if (solid && size <= maxIsland) {
      for (let h = qs; h < qe; h++) dens[queue[h]] = 0;
    } else if (!solid && size <= maxHole) {
      for (let h = qs; h < qe; h++) {
        dens[queue[h]] = 1;
        filledList.push(queue[h]);
      }
    }
    qs = qe;
  }
  return { dens, filled: Int32Array.from(filledList) };
}

/** Value of the void pad ring. Strongly negative so the closing surface hugs the domain face. */
const PAD_VALUE = -10;

function buildField(densities, nx, ny, nz) {
  // Core node grid (nodes sit on element corners, including the domain faces).
  const cnx = nx + 1;
  const cny = ny + 1;
  const cnz = nz + 1;
  const cStrideY = cnx;
  const cStrideZ = cnx * cny;
  const cTotal = cnx * cny * cnz;
  const node = new Float32Array(cTotal);
  const count = new Uint8Array(cTotal);

  // Each element contributes to its 8 corner nodes; node value = mean of touching elements.
  for (let ez = 0; ez < nz; ez++) {
    for (let ey = 0; ey < ny; ey++) {
      let e = nx * (ey + ny * ez);
      for (let ex = 0; ex < nx; ex++, e++) {
        const rho = densities[e];
        const base = ex + ey * cStrideY + ez * cStrideZ;
        for (let c = 0; c < 8; c++) {
          const i = base + CORNER_DX[c] + CORNER_DY[c] * cStrideY + CORNER_DZ[c] * cStrideZ;
          node[i] += rho;
          count[i] += 1;
        }
      }
    }
  }
  for (let i = 0; i < cTotal; i++) if (count[i] > 1) node[i] /= count[i];

  // Separable 3-tap box blur with clamped (replicated) borders: faces on the domain
  // boundary keep their value instead of being eroded towards the void pad, which is
  // what used to punch pits into flat faces.
  const tmp = new Float32Array(cTotal);
  const blurAxis = (src, dst, stride, n, strideA, nA, strideB, nB) => {
    for (let b = 0; b < nB; b++) {
      for (let a = 0; a < nA; a++) {
        const base = a * strideA + b * strideB;
        for (let k = 0; k < n; k++) {
          const i = base + k * stride;
          const lo = k > 0 ? src[i - stride] : src[i];
          const hi = k < n - 1 ? src[i + stride] : src[i];
          dst[i] = (lo + src[i] + hi) * (1 / 3);
        }
      }
    }
  };
  blurAxis(node, tmp, 1, cnx, cStrideY, cny, cStrideZ, cnz);
  blurAxis(tmp, node, cStrideY, cny, 1, cnx, cStrideZ, cnz);
  blurAxis(node, tmp, cStrideZ, cnz, 1, cnx, cStrideY, cny);

  // Embed in a 1-node void ring so the iso surface is always closed.
  const snx = nx + 3;
  const sny = ny + 3;
  const snz = nz + 3;
  const field = new Float32Array(snx * sny * snz).fill(PAD_VALUE);
  for (let z = 0; z < cnz; z++) {
    for (let y = 0; y < cny; y++) {
      const src = y * cStrideY + z * cStrideZ;
      const dst = 1 + (y + 1) * snx + (z + 1) * snx * sny;
      for (let x = 0; x < cnx; x++) field[dst + x] = tmp[src + x];
    }
  }
  return { field, snx, sny, snz };
}

/**
 * @param {Float32Array} densities nx·ny·nz, ex fastest
 * @param {{
 *   nx: number, ny: number, nz: number, iso?: number, smoothIters?: number,
 *   energies?: Float32Array | null, colorMode?: string, lut?: Float32Array | null,
 * }} opts
 * @returns {{ positions: Float32Array, normals: Float32Array, indices: Uint32Array, colors: Float32Array | null }}
 */
export function buildSmoothMesh(densities, opts) {
  const { nx, ny, nz, iso = 0.45, smoothIters = 4 } = opts;
  const empty = {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
    colors: null,
  };
  if (!densities || densities.length !== nx * ny * nz || nx < 1 || ny < 1 || nz < 1) return empty;

  const { dens: cleaned, filled } = cleanSpeckle(densities, nx, ny, nz, iso);
  const { field, snx, sny, snz } = buildField(cleaned, nx, ny, nz);
  const strideY = snx;
  const strideZ = snx * sny;
  const nodeCount = snx * sny * snz;

  const cornerOff = new Int32Array(8);
  for (let c = 0; c < 8; c++) cornerOff[c] = CORNER_DX[c] + CORNER_DY[c] * strideY + CORNER_DZ[c] * strideZ;

  const edgeCache = new Int32Array(nodeCount * 3).fill(-1);
  let vCap = 4096;
  let verts = new Float32Array(vCap * 3);
  let vCount = 0;
  let iCap = 8192;
  let tris = new Uint32Array(iCap);
  let iCount = 0;
  const cornerVal = new Float32Array(8);
  const vertList = new Int32Array(12);
  const ox = nx / 2 + 1;
  const oy = ny / 2 + 1;
  const oz = nz / 2 + 1;

  for (let cz = 0; cz < snz - 1; cz++) {
    for (let cy = 0; cy < sny - 1; cy++) {
      let cell = cy * strideY + cz * strideZ;
      for (let cx = 0; cx < snx - 1; cx++, cell++) {
        let cube = 0;
        for (let c = 0; c < 8; c++) {
          const v = field[cell + cornerOff[c]];
          cornerVal[c] = v;
          if (v < iso) cube |= 1 << c;
        }
        const edges = edgeTable[cube];
        if (edges === 0) continue;

        for (let e = 0; e < 12; e++) {
          if ((edges & (1 << e)) === 0) continue;
          const info = EDGE_INFO[e];
          const node = cell + info.dx + info.dy * strideY + info.dz * strideZ;
          const key = node * 3 + info.axis;
          let vi = edgeCache[key];
          if (vi < 0) {
            const vLow = cornerVal[info.low];
            const vHigh = cornerVal[info.high];
            const d = vHigh - vLow;
            let t = d === 0 ? 0.5 : (iso - vLow) / d;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            if (vCount === vCap) {
              vCap *= 2;
              const nv = new Float32Array(vCap * 3);
              nv.set(verts);
              verts = nv;
            }
            // Padded node (cx+dx, cy+dy, cz+dz) → world (minus pad offset and half-size).
            const px = cx + info.dx - ox + (info.axis === 0 ? t : 0);
            const py = cy + info.dy - oy + (info.axis === 1 ? t : 0);
            const pz = cz + info.dz - oz + (info.axis === 2 ? t : 0);
            const o = vCount * 3;
            verts[o] = px;
            verts[o + 1] = py;
            verts[o + 2] = pz;
            vi = vCount++;
            edgeCache[key] = vi;
          }
          vertList[e] = vi;
        }

        const row = cube * 16;
        for (let i = 0; i < 16; i += 3) {
          const i0 = triTable[row + i];
          if (i0 === -1) break;
          if (iCount + 3 > iCap) {
            iCap *= 2;
            const nt = new Uint32Array(iCap);
            nt.set(tris);
            tris = nt;
          }
          // Table order gives outward-facing (solid → void) triangles for the "bit set
          // when value < iso" convention used above (verified by signed volume in
          // scripts/testSmoothMesh.mjs). Do not reverse it: the old reversed winding made
          // most triangles back-facing, so lighting was inverted except in scattered
          // patches whose vertex normals had been hand-flipped (the "scales").
          tris[iCount++] = vertList[i0];
          tris[iCount++] = vertList[triTable[row + i + 1]];
          tris[iCount++] = vertList[triTable[row + i + 2]];
        }
      }
    }
  }

  if (iCount === 0) return empty;

  let positions = verts.slice(0, vCount * 3);
  const indices = tris.slice(0, iCount);

  if (smoothIters > 0) positions = taubinIndexed(positions, indices, smoothIters);
  const normals = vertexNormals(positions, indices);

  // Colours sample the undeformed design, so compute them before the Deform offset.
  const colors = vertexColors(positions, normals, densities, opts, filled);
  if (colors && opts.ao !== false) bakeVertexAO(colors, positions, normals, cleaned, nx, ny, nz);

  // Deform modifier: same vertical displacement field the cube view uses, sampled
  // trilinearly at each vertex (the cubes shift each element by dispY[e] * defScale).
  const { dispY = null, defScale = 0 } = opts;
  if (dispY && defScale > 0 && dispY.length === densities.length) {
    applyDeform(positions, dispY, nx, ny, nz, defScale);
    return { positions, normals: vertexNormals(positions, indices), indices, colors };
  }
  return { positions, normals, indices, colors };
}

/** Add `scale * dispY(p)` to every vertex's Y (trilinear over element-centred values). */
export function applyDeform(positions, dispY, nx, ny, nz, scale) {
  const n = positions.length / 3;
  const sy = nx;
  const sz = nx * ny;
  const hx = nx / 2 - 0.5;
  const hy = ny / 2 - 0.5;
  const hz = nz / 2 - 0.5;
  for (let v = 0; v < n; v++) {
    const o = v * 3;
    let u = positions[o] + hx;
    let w = positions[o + 1] + hy;
    let q = positions[o + 2] + hz;
    u = u < 0 ? 0 : u > nx - 1 ? nx - 1 : u;
    w = w < 0 ? 0 : w > ny - 1 ? ny - 1 : w;
    q = q < 0 ? 0 : q > nz - 1 ? nz - 1 : q;
    const x0 = Math.min(Math.max(nx - 2, 0), Math.floor(u));
    const y0 = Math.min(Math.max(ny - 2, 0), Math.floor(w));
    const z0 = Math.min(Math.max(nz - 2, 0), Math.floor(q));
    const x1 = Math.min(nx - 1, x0 + 1);
    const y1 = Math.min(ny - 1, y0 + 1);
    const z1 = Math.min(nz - 1, z0 + 1);
    const fx = u - x0;
    const fy = w - y0;
    const fz = q - z0;
    const b00 = dispY[x0 + y0 * sy + z0 * sz] * (1 - fx) + dispY[x1 + y0 * sy + z0 * sz] * fx;
    const b10 = dispY[x0 + y1 * sy + z0 * sz] * (1 - fx) + dispY[x1 + y1 * sy + z0 * sz] * fx;
    const b01 = dispY[x0 + y0 * sy + z1 * sz] * (1 - fx) + dispY[x1 + y0 * sy + z1 * sz] * fx;
    const b11 = dispY[x0 + y1 * sy + z1 * sz] * (1 - fx) + dispY[x1 + y1 * sy + z1 * sz] * fx;
    positions[o + 1] += ((b00 * (1 - fy) + b10 * fy) * (1 - fz) + (b01 * (1 - fy) + b11 * fy) * fz) * scale;
  }
}

/**
 * Per-vertex colours. The scalar shown is the element field (density, or normalised
 * strain energy) sampled trilinearly slightly *inside* the surface: right on the iso
 * surface density is constant by construction, so the sample is pulled inwards along
 * the normal to show how solid / how stressed the material behind the skin is.
 *
 * @returns {Float32Array | null} linear RGB, 3 per vertex (null without a LUT)
 */
function vertexColors(positions, normals, densities, opts, filled) {
  const { nx, ny, nz, energies = null, colorMode = 'density', lut = null } = opts;
  if (!lut || lut.length < 6) return null;
  const steps = lut.length / 3 - 1;

  let values = densities;
  let inward = 1.0;
  if (colorMode === 'energy' && energies && energies.length === densities.length) {
    let maxE = 1e-7;
    for (let i = 0; i < energies.length; i++) if (energies[i] > maxE) maxE = energies[i];
    const inv = 1 / maxE;
    values = new Float32Array(energies.length);
    for (let i = 0; i < energies.length; i++) values[i] = Math.min(1, Math.pow(energies[i] * inv, 0.45));
    inward = 0.6;
  }

  // Filled pockets take the mean value of their solid neighbours, so the pit that was
  // closed doesn't leave a dark patch on the skin.
  if (filled && filled.length) {
    if (values === densities) values = new Float32Array(densities);
    const iso = opts.iso ?? 0.45;
    const fx = nx;
    const fz = nx * ny;
    const patched = new Float32Array(filled.length);
    for (let k = 0; k < filled.length; k++) {
      const e = filled[k];
      const x = e % nx;
      const y = ((e / nx) | 0) % ny;
      const z = (e / fz) | 0;
      let sum = 0;
      let cnt = 0;
      const tryAdd = (j) => {
        if (densities[j] >= iso) { sum += values[j]; cnt++; }
      };
      if (x > 0) tryAdd(e - 1);
      if (x < nx - 1) tryAdd(e + 1);
      if (y > 0) tryAdd(e - fx);
      if (y < ny - 1) tryAdd(e + fx);
      if (z > 0) tryAdd(e - fz);
      if (z < nz - 1) tryAdd(e + fz);
      patched[k] = cnt ? sum / cnt : values[e];
    }
    for (let k = 0; k < filled.length; k++) values[filled[k]] = patched[k];
  }

  const n = positions.length / 3;
  const colors = new Float32Array(n * 3);
  const sy = nx;
  const sz = nx * ny;
  const hx = nx / 2 - 0.5;
  const hy = ny / 2 - 0.5;
  const hz = nz / 2 - 0.5;
  for (let v = 0; v < n; v++) {
    const o = v * 3;
    // Continuous element-centre coordinates of the inward sample point.
    let u = positions[o] - normals[o] * inward + hx;
    let w = positions[o + 1] - normals[o + 1] * inward + hy;
    let q = positions[o + 2] - normals[o + 2] * inward + hz;
    u = u < 0 ? 0 : u > nx - 1 ? nx - 1 : u;
    w = w < 0 ? 0 : w > ny - 1 ? ny - 1 : w;
    q = q < 0 ? 0 : q > nz - 1 ? nz - 1 : q;
    const x0 = Math.min(nx - 2 < 0 ? 0 : nx - 2, Math.floor(u));
    const y0 = Math.min(ny - 2 < 0 ? 0 : ny - 2, Math.floor(w));
    const z0 = Math.min(nz - 2 < 0 ? 0 : nz - 2, Math.floor(q));
    const x1 = Math.min(nx - 1, x0 + 1);
    const y1 = Math.min(ny - 1, y0 + 1);
    const z1 = Math.min(nz - 1, z0 + 1);
    const fx = u - x0;
    const fy = w - y0;
    const fz = q - z0;
    const b00 = values[x0 + y0 * sy + z0 * sz] * (1 - fx) + values[x1 + y0 * sy + z0 * sz] * fx;
    const b10 = values[x0 + y1 * sy + z0 * sz] * (1 - fx) + values[x1 + y1 * sy + z0 * sz] * fx;
    const b01 = values[x0 + y0 * sy + z1 * sz] * (1 - fx) + values[x1 + y0 * sy + z1 * sz] * fx;
    const b11 = values[x0 + y1 * sy + z1 * sz] * (1 - fx) + values[x1 + y1 * sy + z1 * sz] * fx;
    const val = (b00 * (1 - fy) + b10 * fy) * (1 - fz) + (b01 * (1 - fy) + b11 * fy) * fz;
    const k = val <= 0 ? 0 : val >= 1 ? steps : Math.round(val * steps);
    colors[o] = lut[k * 3];
    colors[o + 1] = lut[k * 3 + 1];
    colors[o + 2] = lut[k * 3 + 2];
  }
  return colors;
}

/** Hemisphere sample pattern (unit offsets in the vertex frame: tangent, bitangent, normal; distance). */
const AO_SAMPLES = (() => {
  const s = [[0, 0, 1, 2.0]];
  // Three rings, wider and further out: creases are already filleted by the field blur, so the
  // occluding walls sit 1-3 cells away from the vertex.
  const rings = [[35, 1.5], [55, 2.5], [70, 3.5]];
  rings.forEach(([deg, dist], r) => {
    const th = (deg * Math.PI) / 180;
    for (let a = 0; a < 4; a++) {
      const phi = (a + 0.5 * (r % 2)) * (Math.PI / 2);
      s.push([Math.cos(phi) * Math.sin(th), Math.sin(phi) * Math.sin(th), Math.cos(th), dist]);
    }
  });
  return s;
})();

/**
 * Ambient occlusion baked into the vertex colours: how much solid material sits in the
 * hemisphere above each vertex (13 trilinear density probes). Open skin stays at 1, creases,
 * bolt-hole bores and the underside of overhangs darken. Outside the domain counts as empty.
 */
function bakeVertexAO(colors, positions, normals, dens, nx, ny, nz, strength = 1.7, floor = 0.32) {
  const sy = nx;
  const sz = nx * ny;
  const hx = nx / 2 - 0.5;
  const hy = ny / 2 - 0.5;
  const hz = nz / 2 - 0.5;
  const lo = 0.15;
  const inv = 1 / 0.5;
  const n = positions.length / 3;

  const val = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? 0 : dens[x + y * sy + z * sz]);
  const occAt = (u, w, q) => {
    const x0 = Math.floor(u);
    const y0 = Math.floor(w);
    const z0 = Math.floor(q);
    const fx = u - x0;
    const fy = w - y0;
    const fz = q - z0;
    const b00 = val(x0, y0, z0) * (1 - fx) + val(x0 + 1, y0, z0) * fx;
    const b10 = val(x0, y0 + 1, z0) * (1 - fx) + val(x0 + 1, y0 + 1, z0) * fx;
    const b01 = val(x0, y0, z0 + 1) * (1 - fx) + val(x0 + 1, y0, z0 + 1) * fx;
    const b11 = val(x0, y0 + 1, z0 + 1) * (1 - fx) + val(x0 + 1, y0 + 1, z0 + 1) * fx;
    const d = (b00 * (1 - fy) + b10 * fy) * (1 - fz) + (b01 * (1 - fy) + b11 * fy) * fz;
    const o = (d - lo) * inv;
    return o <= 0 ? 0 : o >= 1 ? 1 : o;
  };

  for (let v = 0; v < n; v++) {
    const o = v * 3;
    const nxv = normals[o];
    const nyv = normals[o + 1];
    const nzv = normals[o + 2];
    // Tangent frame around the normal.
    let tx;
    let ty;
    let tz;
    if (Math.abs(nyv) < 0.9) { tx = nzv; ty = 0; tz = -nxv; } else { tx = 0; ty = -nzv; tz = nyv; }
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const bx = nyv * tz - nzv * ty;
    const by = nzv * tx - nxv * tz;
    const bz = nxv * ty - nyv * tx;

    const px = positions[o] + hx;
    const py = positions[o + 1] + hy;
    const pz = positions[o + 2] + hz;
    let sum = 0;
    for (let s = 0; s < AO_SAMPLES.length; s++) {
      const [a, b, c, d] = AO_SAMPLES[s];
      sum += occAt(
        px + (a * tx + b * bx + c * nxv) * d,
        py + (a * ty + b * by + c * nyv) * d,
        pz + (a * tz + b * bz + c * nzv) * d,
      );
    }
    const ao = Math.max(floor, 1 - (strength * sum) / AO_SAMPLES.length);
    colors[o] *= ao;
    colors[o + 1] *= ao;
    colors[o + 2] *= ao;
  }
}

/** Volume-preserving Taubin (λ|μ) smoothing on an indexed mesh with CSR neighbour lists. */
export function taubinIndexed(positions, indices, iterations = 4, lambda = 0.5, mu = -0.53) {
  const n = positions.length / 3;
  // CSR adjacency (neighbours listed once per incident triangle; closed meshes → uniform).
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < indices.length; i += 3) {
    start[indices[i] + 1] += 2;
    start[indices[i + 1] + 1] += 2;
    start[indices[i + 2] + 1] += 2;
  }
  for (let v = 0; v < n; v++) start[v + 1] += start[v];
  const fill = start.slice(0, n);
  const nbr = new Uint32Array(start[n]);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    nbr[fill[a]++] = b; nbr[fill[a]++] = c;
    nbr[fill[b]++] = a; nbr[fill[b]++] = c;
    nbr[fill[c]++] = a; nbr[fill[c]++] = b;
  }

  let cur = new Float32Array(positions);
  let buf = new Float32Array(positions.length);
  const step = (src, dst, w) => {
    for (let v = 0; v < n; v++) {
      const s = start[v];
      const e = start[v + 1];
      const o = v * 3;
      if (e === s) {
        dst[o] = src[o]; dst[o + 1] = src[o + 1]; dst[o + 2] = src[o + 2];
        continue;
      }
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let k = s; k < e; k++) {
        const q = nbr[k] * 3;
        sx += src[q]; sy += src[q + 1]; sz += src[q + 2];
      }
      const inv = 1 / (e - s);
      dst[o] = src[o] + w * (sx * inv - src[o]);
      dst[o + 1] = src[o + 1] + w * (sy * inv - src[o + 1]);
      dst[o + 2] = src[o + 2] + w * (sz * inv - src[o + 2]);
    }
  };
  for (let it = 0; it < iterations; it++) {
    step(cur, buf, lambda);
    step(buf, cur, mu);
  }
  return cur;
}

/** Area-weighted vertex normals on an indexed mesh. */
export function vertexNormals(positions, indices) {
  const n = positions.length / 3;
  const acc = new Float32Array(n * 3);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ax = positions[b] - positions[a];
    const ay = positions[b + 1] - positions[a + 1];
    const az = positions[b + 2] - positions[a + 2];
    const bx = positions[c] - positions[a];
    const by = positions[c + 1] - positions[a + 1];
    const bz = positions[c + 2] - positions[a + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    acc[a] += nx; acc[a + 1] += ny; acc[a + 2] += nz;
    acc[b] += nx; acc[b + 1] += ny; acc[b + 2] += nz;
    acc[c] += nx; acc[c + 1] += ny; acc[c + 2] += nz;
  }
  for (let v = 0; v < n; v++) {
    const o = v * 3;
    const len = Math.hypot(acc[o], acc[o + 1], acc[o + 2]);
    if (len > 1e-12) {
      acc[o] /= len; acc[o + 1] /= len; acc[o + 2] /= len;
    }
  }
  return acc;
}
