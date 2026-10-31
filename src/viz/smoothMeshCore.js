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
function buildField(densities, nx, ny, nz) {
  const snx = nx + 3;
  const sny = ny + 3;
  const snz = nz + 3;
  const strideY = snx;
  const strideZ = snx * sny;
  const total = snx * sny * snz;
  const field = new Float32Array(total);
  const count = new Uint8Array(total);

  // Each element contributes to its 8 corner nodes; node value = mean of touching elements.
  for (let ez = 0; ez < nz; ez++) {
    for (let ey = 0; ey < ny; ey++) {
      let e = nx * (ey + ny * ez);
      for (let ex = 0; ex < nx; ex++, e++) {
        const rho = densities[e];
        const base = (ex + 1) + (ey + 1) * strideY + (ez + 1) * strideZ;
        for (let c = 0; c < 8; c++) {
          const i = base + CORNER_DX[c] + CORNER_DY[c] * strideY + CORNER_DZ[c] * strideZ;
          field[i] += rho;
          count[i] += 1;
        }
      }
    }
  }
  for (let i = 0; i < total; i++) if (count[i] > 1) field[i] /= count[i];

  // Separable box blur; the outermost ring stays zero (void pad).
  const tmp = new Float32Array(total);
  const blurAxis = (src, dst, stride, n, strideA, nA, strideB, nB) => {
    dst.fill(0);
    for (let b = 1; b < nB - 1; b++) {
      for (let a = 1; a < nA - 1; a++) {
        const base = a * strideA + b * strideB;
        for (let k = 1; k < n - 1; k++) {
          const i = base + k * stride;
          dst[i] = (src[i - stride] + src[i] + src[i + stride]) * (1 / 3);
        }
      }
    }
  };
  blurAxis(field, tmp, 1, snx, strideY, sny, strideZ, snz);
  blurAxis(tmp, field, strideY, sny, 1, snx, strideZ, snz);
  blurAxis(field, tmp, strideZ, snz, 1, snx, strideY, sny);
  return { field: tmp, snx, sny, snz };
}

/**
 * @param {Float32Array} densities nx·ny·nz, ex fastest
 * @param {{ nx: number, ny: number, nz: number, iso?: number, smoothIters?: number }} opts
 * @returns {{ positions: Float32Array, normals: Float32Array, indices: Uint32Array }}
 */
export function buildSmoothMesh(densities, opts) {
  const { nx, ny, nz, iso = 0.45, smoothIters = 4 } = opts;
  const empty = {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
  };
  if (!densities || densities.length !== nx * ny * nz || nx < 1 || ny < 1 || nz < 1) return empty;

  const { field, snx, sny, snz } = buildField(densities, nx, ny, nz);
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
          // Winding flipped so normals point from solid to void.
          tris[iCount++] = vertList[i0];
          tris[iCount++] = vertList[triTable[row + i + 2]];
          tris[iCount++] = vertList[triTable[row + i + 1]];
        }
      }
    }
  }

  if (iCount === 0) return empty;

  let positions = verts.slice(0, vCount * 3);
  const indices = tris.slice(0, iCount);

  if (smoothIters > 0) positions = taubinIndexed(positions, indices, smoothIters);
  const normals = vertexNormals(positions, indices);

  // Safety: flip vertex normals that point into the solid (sample the blurred field).
  for (let v = 0; v < vCount; v++) {
    const o = v * 3;
    const sx = Math.max(0, Math.min(snx - 1, Math.round(positions[o] + ox + normals[o] * 0.35)));
    const sy = Math.max(0, Math.min(sny - 1, Math.round(positions[o + 1] + oy + normals[o + 1] * 0.35)));
    const sz = Math.max(0, Math.min(snz - 1, Math.round(positions[o + 2] + oz + normals[o + 2] * 0.35)));
    if (field[sx + sy * strideY + sz * strideZ] >= iso) {
      normals[o] = -normals[o];
      normals[o + 1] = -normals[o + 1];
      normals[o + 2] = -normals[o + 2];
    }
  }

  return { positions, normals, indices };
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
