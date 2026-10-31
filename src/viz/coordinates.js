/**
 * Canonical Three.js world transforms. The voxel domain is centred on the origin;
 * one grid cell = one world unit.
 *
 * @typedef {{ nx: number, ny: number, nz: number }} GridDims
 * @typedef {{ x: number, y: number, z: number }} Vec3Like
 */

/**
 * Grid node (ix, iy, iz) → world position.
 * @param {GridDims} config
 * @param {number} ix
 * @param {number} iy
 * @param {number} iz
 * @param {Vec3Like} [out]
 * @returns {Vec3Like}
 */
export function nodeToWorld(config, ix, iy, iz, out = { x: 0, y: 0, z: 0 }) {
  out.x = ix - config.nx / 2;
  out.y = iy - config.ny / 2;
  out.z = iz - config.nz / 2;
  return out;
}

/**
 * Element (ex, ey, ez) centre → world position.
 * @param {GridDims} config
 * @param {number} ex
 * @param {number} ey
 * @param {number} ez
 * @param {Vec3Like} [out]
 * @returns {Vec3Like}
 */
export function elemToWorld(config, ex, ey, ez, out = { x: 0, y: 0, z: 0 }) {
  out.x = ex - config.nx / 2 + 0.5;
  out.y = ey - config.ny / 2 + 0.5;
  out.z = ez - config.nz / 2 + 0.5;
  return out;
}

/** World Y of the ground plane underneath the domain. */
export function groundY(config) {
  return -config.ny / 2 - 0.52;
}
