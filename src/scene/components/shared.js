/** @returns {[number, number, number]} unit vector (−Y if degenerate) */
export function normalizeDir(fx, fy, fz) {
  const x = Number(fx) || 0;
  const y = Number(fy) || 0;
  const z = Number(fz) || 0;
  const len = Math.hypot(x, y, z);
  if (len < 1e-12) return [0, -1, 0];
  return [x / len, y / len, z / len];
}

/** Unit direction for a glyph. A negative magnitude flips the vector. */
export function unitDir(fx, fy, fz, magnitude) {
  let x = Number(fx) || 0;
  let y = Number(fy) || 0;
  let z = Number(fz) || 0;
  if (magnitude < 0) {
    x = -x;
    y = -y;
    z = -z;
  }
  const l = Math.hypot(x, y, z);
  if (l < 1e-12) return { x: 0, y: -1, z: 0 };
  return { x: x / l, y: y / l, z: z / l };
}

/** Add share-proportional parts of a resultant (dir × magnitude) to nodes. */
export function distributeResultant(F, nodes, dir, magnitude) {
  let sum = 0;
  for (const nd of nodes) sum += nd.w;
  if (sum <= 0) return;
  for (const nd of nodes) {
    const s = (magnitude * nd.w) / sum;
    F[3 * nd.n] += dir[0] * s;
    F[3 * nd.n + 1] += dir[1] * s;
    F[3 * nd.n + 2] += dir[2] * s;
  }
}

const FACES = new Set(['x-', 'x+', 'y-', 'y+', 'z-', 'z+']);

/**
 * Face code, its axis, which side is high, and the two in-plane axes.
 * `dims` is `{ nx, ny, nz }`.
 */
export function faceFrame(face, dims) {
  const f = FACES.has(face) ? face : 'x-';
  const axis = f[0];
  const high = f[1] === '+';
  const perp = axis === 'x' ? ['y', 'z'] : axis === 'y' ? ['x', 'z'] : ['x', 'y'];
  return { face: f, axis, high, perp, n: { x: dims.nx, y: dims.ny, z: dims.nz } };
}

export function anyFix(c) {
  return c.fixX !== false || c.fixY !== false || c.fixZ !== false;
}

/** Clamp one node. Counts the node even when another feature already clamped it. */
export function applyFixFlags(c, ctx, n) {
  if (c.fixX !== false) ctx.fixedDofs[3 * n] = 1;
  if (c.fixY !== false) ctx.fixedDofs[3 * n + 1] = 1;
  if (c.fixZ !== false) ctx.fixedDofs[3 * n + 2] = 1;
  ctx.count.fixedNodes++;
}

export const num = (v, d) => (Number.isFinite(v) ? v : d);

/** @param {Record<string, any>} obj */
export function stripUndefined(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
