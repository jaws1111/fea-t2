/**
 * Node index in structured grid (nx+1) × (ny+1) × (nz+1).
 */
export function getNodeIndex(nx, ny, _nz, ix, iy, iz) {
  return ix + iy * (nx + 1) + iz * ((nx + 1) * (ny + 1));
}

/**
 * Element index in nx × ny × nz voxel grid.
 */
export function getElementIndex(nx, ny, _nz, ex, ey, ez) {
  return ex + ey * nx + ez * (nx * ny);
}

/**
 * Fill 24 global DOF indices for Hex8 element (ex, ey, ez).
 * @param {Int32Array} dofOut length ≥ 24
 */
export function getElementDofs(nx, ny, nz, ex, ey, ez, dofOut) {
  const localNodes = [
    getNodeIndex(nx, ny, nz, ex, ey, ez),
    getNodeIndex(nx, ny, nz, ex + 1, ey, ez),
    getNodeIndex(nx, ny, nz, ex + 1, ey + 1, ez),
    getNodeIndex(nx, ny, nz, ex, ey + 1, ez),
    getNodeIndex(nx, ny, nz, ex, ey, ez + 1),
    getNodeIndex(nx, ny, nz, ex + 1, ey, ez + 1),
    getNodeIndex(nx, ny, nz, ex + 1, ey + 1, ez + 1),
    getNodeIndex(nx, ny, nz, ex, ey + 1, ez + 1),
  ];
  let p = 0;
  for (let n = 0; n < 8; n++) {
    const base = 3 * localNodes[n];
    dofOut[p++] = base;
    dofOut[p++] = base + 1;
    dofOut[p++] = base + 2;
  }
}

/**
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 */
export function createIndexing(nx, ny, nz) {
  return {
    getNodeIndex: (ix, iy, iz) => getNodeIndex(nx, ny, nz, ix, iy, iz),
    getElementIndex: (ex, ey, ez) => getElementIndex(nx, ny, nz, ex, ey, ez),
    getElementDofs: (ex, ey, ez, dofOut) => getElementDofs(nx, ny, nz, ex, ey, ez, dofOut),
    nx,
    ny,
    nz,
  };
}
