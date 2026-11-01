/**
 * Geometry helpers on the structured node grid (nx+1) × (ny+1) × (nz+1).
 *
 * Normalized coordinates: 0 = min, 1 = max along nx / ny / nz.
 * Normalized radii: fraction of max(nx, ny, nz); the grid is isotropic in index space
 * (one element = one unit), so distances are measured in node units.
 *
 * All iterators call `cb(ix, iy, iz, dist)` where `dist` is the distance (node units)
 * from the feature centre / axis (0 for box shells).
 */

/** @param {number} v @param {number} lo @param {number} hi */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Normalized coordinate → node index along an axis with `n` elements (n+1 nodes).
 * @param {number} norm
 * @param {number} n
 */
export function normToNode(norm, n) {
  return clamp(Math.round((Number.isFinite(norm) ? norm : 0) * n), 0, n);
}

/**
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {number} xNorm @param {number} yNorm @param {number} zNorm
 * @returns {{ ix: number, iy: number, iz: number }}
 */
export function normToNodeIndices(nx, ny, nz, xNorm, yNorm, zNorm) {
  return {
    ix: normToNode(xNorm, nx),
    iy: normToNode(yNorm, ny),
    iz: normToNode(zNorm, nz),
  };
}

/**
 * Normalized radius → radius in node units.
 * @param {number} nx @param {number} ny @param {number} nz @param {number} rNorm
 */
export function normRadiusToNodes(nx, ny, nz, rNorm) {
  return Math.max(0, rNorm || 0) * Math.max(nx, ny, nz);
}

/**
 * Nodes within a sphere. Centre is snapped to the nearest node so the centre node
 * is always included.
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {number} cx @param {number} cy @param {number} cz  normalized centre
 * @param {number} rNorm  radius as fraction of max(nx,ny,nz)
 * @param {(ix:number, iy:number, iz:number, dist:number) => void} cb
 * @returns {number} number of nodes visited
 */
export function forNodesInSphere(nx, ny, nz, cx, cy, cz, rNorm, cb) {
  const c = normToNodeIndices(nx, ny, nz, cx, cy, cz);
  const R = normRadiusToNodes(nx, ny, nz, rNorm);
  const R2 = R * R + 1e-9;
  const r = Math.ceil(R);
  let count = 0;
  for (let iz = Math.max(0, c.iz - r); iz <= Math.min(nz, c.iz + r); iz++) {
    const dz = iz - c.iz;
    for (let iy = Math.max(0, c.iy - r); iy <= Math.min(ny, c.iy + r); iy++) {
      const dy = iy - c.iy;
      for (let ix = Math.max(0, c.ix - r); ix <= Math.min(nx, c.ix + r); ix++) {
        const dx = ix - c.ix;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= R2) {
          cb(ix, iy, iz, Math.sqrt(d2));
          count++;
        }
      }
    }
  }
  return count;
}

/**
 * Nodes on a spherical shell: | dist - R | <= thickness. Radius is clamped to at least
 * one node so tiny cavities still produce a shell.
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {number} cx @param {number} cy @param {number} cz
 * @param {number} rNorm
 * @param {(ix:number, iy:number, iz:number, dist:number) => void} cb
 * @param {number} [thickness=0.75] half shell thickness in node units
 * @returns {number}
 */
export function forNodesOnSphereShell(nx, ny, nz, cx, cy, cz, rNorm, cb, thickness = 0.75) {
  const c = normToNodeIndices(nx, ny, nz, cx, cy, cz);
  const R = Math.max(1, normRadiusToNodes(nx, ny, nz, rNorm));
  const r = Math.ceil(R + thickness);
  let count = 0;
  for (let iz = Math.max(0, c.iz - r); iz <= Math.min(nz, c.iz + r); iz++) {
    const dz = iz - c.iz;
    for (let iy = Math.max(0, c.iy - r); iy <= Math.min(ny, c.iy + r); iy++) {
      const dy = iy - c.iy;
      for (let ix = Math.max(0, c.ix - r); ix <= Math.min(nx, c.ix + r); ix++) {
        const dx = ix - c.ix;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (Math.abs(d - R) <= thickness) {
          cb(ix, iy, iz, d);
          count++;
        }
      }
    }
  }
  return count;
}

/**
 * Resolve axis-specific layout for cylinder helpers.
 * axis 'x': perpendicular coords are (y, z); 'y': (x, z); 'z': (x, y).
 * @param {'x'|'y'|'z'} axis
 */
function cylinderLayout(nx, ny, nz, axis, c1, c2, cAxis) {
  const dims = { x: nx, y: ny, z: nz };
  const perp = axis === 'x' ? ['y', 'z'] : axis === 'y' ? ['x', 'z'] : ['x', 'y'];
  const n1 = dims[perp[0]];
  const n2 = dims[perp[1]];
  const nA = dims[axis];
  const i1 = normToNode(c1, n1);
  const i2 = normToNode(c2, n2);
  let a0 = 0;
  let a1 = nA;
  if (Array.isArray(cAxis)) {
    a0 = normToNode(Math.min(cAxis[0], cAxis[1]), nA);
    a1 = normToNode(Math.max(cAxis[0], cAxis[1]), nA);
  } else if (typeof cAxis === 'number' && Number.isFinite(cAxis)) {
    a0 = a1 = normToNode(cAxis, nA);
  }
  return { perp, n1, n2, nA, i1, i2, a0, a1 };
}

/** Map (axis, perp1, perp2, axial) indices back to (ix,iy,iz). */
function toXYZ(axis, p1, p2, a, out) {
  if (axis === 'x') { out[0] = a; out[1] = p1; out[2] = p2; }
  else if (axis === 'y') { out[0] = p1; out[1] = a; out[2] = p2; }
  else { out[0] = p1; out[1] = p2; out[2] = a; }
}

/**
 * Nodes inside a cylinder along `axis` (bolt hole).
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {'x'|'y'|'z'} axis
 * @param {number} c1  normalized centre along first perpendicular axis ('x'→y, 'y'→x, 'z'→x)
 * @param {number} c2  normalized centre along second perpendicular axis ('x'→z, 'y'→z, 'z'→y)
 * @param {number|[number,number]|null|undefined} cAxis  null = full length along axis,
 *   number = single layer at that normalized position, [a,b] = normalized range
 * @param {number} rNorm radius as fraction of max(nx,ny,nz)
 * @param {(ix:number, iy:number, iz:number, dist:number) => void} cb  dist = radial distance from axis
 * @returns {number}
 */
export function forNodesInCylinder(nx, ny, nz, axis, c1, c2, cAxis, rNorm, cb) {
  const L = cylinderLayout(nx, ny, nz, axis, c1, c2, cAxis);
  const R = normRadiusToNodes(nx, ny, nz, rNorm);
  const R2 = R * R + 1e-9;
  const r = Math.ceil(R);
  const xyz = [0, 0, 0];
  let count = 0;
  for (let a = L.a0; a <= L.a1; a++) {
    for (let p2 = Math.max(0, L.i2 - r); p2 <= Math.min(L.n2, L.i2 + r); p2++) {
      const d2v = p2 - L.i2;
      for (let p1 = Math.max(0, L.i1 - r); p1 <= Math.min(L.n1, L.i1 + r); p1++) {
        const d1 = p1 - L.i1;
        const d2 = d1 * d1 + d2v * d2v;
        if (d2 <= R2) {
          toXYZ(axis, p1, p2, a, xyz);
          cb(xyz[0], xyz[1], xyz[2], Math.sqrt(d2));
          count++;
        }
      }
    }
  }
  return count;
}

/**
 * Nodes on the wall of a cylindrical hole (bearing surface): | radialDist - R | <= thickness.
 * Radius is clamped to at least one node.
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {'x'|'y'|'z'} axis
 * @param {number} c1 @param {number} c2
 * @param {number|[number,number]|null|undefined} cAxis
 * @param {number} rNorm
 * @param {(ix:number, iy:number, iz:number, dist:number) => void} cb
 * @param {number} [thickness=0.75]
 * @returns {number}
 */
export function forNodesOnCylinderShell(nx, ny, nz, axis, c1, c2, cAxis, rNorm, cb, thickness = 0.75) {
  const L = cylinderLayout(nx, ny, nz, axis, c1, c2, cAxis);
  const R = Math.max(1, normRadiusToNodes(nx, ny, nz, rNorm));
  const r = Math.ceil(R + thickness);
  const xyz = [0, 0, 0];
  let count = 0;
  for (let a = L.a0; a <= L.a1; a++) {
    for (let p2 = Math.max(0, L.i2 - r); p2 <= Math.min(L.n2, L.i2 + r); p2++) {
      const dv = p2 - L.i2;
      for (let p1 = Math.max(0, L.i1 - r); p1 <= Math.min(L.n1, L.i1 + r); p1++) {
        const du = p1 - L.i1;
        const d = Math.sqrt(du * du + dv * dv);
        if (Math.abs(d - R) <= thickness) {
          toXYZ(axis, p1, p2, a, xyz);
          cb(xyz[0], xyz[1], xyz[2], d);
          count++;
        }
      }
    }
  }
  return count;
}

/**
 * Box half-extents in whole node units (at least 1 per axis).
 * @returns {{ rx: number, ry: number, rz: number }}
 */
export function boxHalfExtentsNodes(nx, ny, nz, hx, hy, hz) {
  return {
    rx: Math.max(1, Math.round(Math.abs(hx) * nx)),
    ry: Math.max(1, Math.round(Math.abs(hy) * ny)),
    rz: Math.max(1, Math.round(Math.abs(hz) * nz)),
  };
}

/**
 * Nodes on the surface of an axis-aligned box cavity (centre + half-extents, all normalized).
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {number} cx @param {number} cy @param {number} cz
 * @param {number} hx @param {number} hy @param {number} hz  half-extents, normalized per axis
 * @param {(ix:number, iy:number, iz:number, dist:number) => void} cb
 * @returns {number}
 */
export function forNodesOnBoxShell(nx, ny, nz, cx, cy, cz, hx, hy, hz, cb) {
  const c = normToNodeIndices(nx, ny, nz, cx, cy, cz);
  const { rx, ry, rz } = boxHalfExtentsNodes(nx, ny, nz, hx, hy, hz);
  let count = 0;
  for (let iz = Math.max(0, c.iz - rz); iz <= Math.min(nz, c.iz + rz); iz++) {
    for (let iy = Math.max(0, c.iy - ry); iy <= Math.min(ny, c.iy + ry); iy++) {
      for (let ix = Math.max(0, c.ix - rx); ix <= Math.min(nx, c.ix + rx); ix++) {
        const onShell =
          Math.abs(ix - c.ix) === rx || Math.abs(iy - c.iy) === ry || Math.abs(iz - c.iz) === rz;
        if (onShell) {
          cb(ix, iy, iz, 0);
          count++;
        }
      }
    }
  }
  return count;
}

/**
 * Nodes on an axis-aligned line. `len` is a fraction of that axis, centred on the
 * component's own coordinate (same rule as a bolt hole's `len`). The other two
 * coordinates snap to one node. `len` 1 at mid-axis is the whole edge, inclusive.
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {'x'|'y'|'z'} axis
 * @param {number} x @param {number} y @param {number} z
 * @param {number} len
 * @param {(ix:number, iy:number, iz:number, dist:number) => void} cb
 * @returns {number}
 */
export function forNodesOnLine(nx, ny, nz, axis, x, y, z, len, cb) {
  const ax = axis === 'x' || axis === 'y' || axis === 'z' ? axis : 'z';
  const nAlong = ax === 'x' ? nx : ax === 'y' ? ny : nz;
  const centre = ax === 'x' ? x : ax === 'y' ? y : z;
  const c = Number.isFinite(centre) ? centre : 0.5;
  const span = Math.min(1, Math.max(0, Number.isFinite(len) ? len : 1));
  const s0 = Math.max(0, c - span / 2);
  const s1 = Math.min(1, c + span / 2);
  let a0 = normToNode(s0, nAlong);
  let a1 = normToNode(s1, nAlong);
  if (a1 < a0) {
    const swap = a0;
    a0 = a1;
    a1 = swap;
  }
  const p = normToNodeIndices(nx, ny, nz, x, y, z);
  let count = 0;
  for (let a = a0; a <= a1; a++) {
    const ix = ax === 'x' ? a : p.ix;
    const iy = ax === 'y' ? a : p.iy;
    const iz = ax === 'z' ? a : p.iz;
    cb(ix, iy, iz, 0);
    count++;
  }
  return count;
}

/**
 * Rectangular patch of nodes on a domain face.
 * Face 'x-'/'x+' → in-plane axes (y, z); 'y-'/'y+' → (x, z); 'z-'/'z+' → (x, y).
 * @param {number} nx @param {number} ny @param {number} nz
 * @param {'x-'|'x+'|'y-'|'y+'|'z-'|'z+'} face
 * @param {number} u  normalized centre along first in-plane axis
 * @param {number} v  normalized centre along second in-plane axis
 * @param {number} width   normalized size along first in-plane axis (>=1 → whole face)
 * @param {number} height  normalized size along second in-plane axis
 * @param {number} depth   number of node layers into the domain (>=1)
 * @param {(ix:number, iy:number, iz:number, dist:number) => void} cb
 * @returns {number}
 */
export function forNodesOnFacePatch(nx, ny, nz, face, u, v, width, height, depth, cb) {
  const axis = face[0];
  const high = face[1] === '+';
  const dims = { x: nx, y: ny, z: nz };
  const perp = axis === 'x' ? ['y', 'z'] : axis === 'y' ? ['x', 'z'] : ['x', 'y'];
  const nU = dims[perp[0]];
  const nV = dims[perp[1]];
  const nA = dims[axis];
  const range = (c, w, n) => {
    const half = Math.max(0, w) / 2;
    const lo = clamp(Math.round((c - half) * n), 0, n);
    const hi = clamp(Math.round((c + half) * n), 0, n);
    return [Math.min(lo, hi), Math.max(lo, hi)];
  };
  const [u0, u1] = range(u, width, nU);
  const [v0, v1] = range(v, height, nV);
  const layers = Math.max(1, Math.round(depth || 1));
  const xyz = [0, 0, 0];
  let count = 0;
  for (let l = 0; l < layers; l++) {
    const a = high ? nA - l : l;
    if (a < 0 || a > nA) continue;
    for (let pv = v0; pv <= v1; pv++) {
      for (let pu = u0; pu <= u1; pu++) {
        toXYZ(axis, pu, pv, a, xyz);
        cb(xyz[0], xyz[1], xyz[2], 0);
        count++;
      }
    }
  }
  return count;
}
