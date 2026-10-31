import * as THREE from 'three';
import { resolveWorkingBounds } from '../scene/workingVolume.js';

/**
 * Translucent AABB for the FEA working / design volume.
 *
 * @param {THREE.Scene} scene
 */
export function createDesignVolume(scene) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const fill = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: 0x6366f1,
      transparent: true,
      opacity: 0.07,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  fill.name = 'designVolumeFill';
  fill.renderOrder = -2;

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({
      color: 0x818cf8,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    }),
  );
  edges.name = 'designVolumeEdges';
  edges.renderOrder = -1;

  const group = new THREE.Group();
  group.name = 'designVolume';
  group.add(fill);
  group.add(edges);
  group.visible = false;
  scene.add(group);

  return { group, fill, edges };
}

/**
 * Fit the helper to the working volume (or full grid).
 * World: domain centred on origin, 1 cell = 1 unit.
 *
 * @param {{ group: THREE.Group }} api
 * @param {{ nx: number, ny: number, nz: number, scene?: import('../scene/types.js').Scene | null }} dims
 */
export function updateDesignVolume(api, dims) {
  if (!api?.group || !dims) return;
  const { nx, ny, nz } = dims;
  const b = resolveWorkingBounds(dims.scene ?? null, { nx, ny, nz });
  const sx = Math.max(0.05, (b.x1 - b.x0) * nx);
  const sy = Math.max(0.05, (b.y1 - b.y0) * ny);
  const sz = Math.max(0.05, (b.z1 - b.z0) * nz);
  // BoxGeometry is centred; place centre of the normalized AABB in world coords.
  const cx = ((b.x0 + b.x1) / 2) * nx - nx / 2;
  const cy = ((b.y0 + b.y1) / 2) * ny - ny / 2;
  const cz = ((b.z0 + b.z1) / 2) * nz - nz / 2;
  api.group.scale.set(sx, sy, sz);
  api.group.position.set(cx, cy, cz);
}

/**
 * @param {{ group: THREE.Group }} api
 * @param {boolean} visible
 */
export function setDesignVolumeVisible(api, visible) {
  if (api?.group) api.group.visible = !!visible;
}

/**
 * @param {{ group: THREE.Group, fill: THREE.Mesh, edges: THREE.LineSegments }} api
 */
export function disposeDesignVolume(api) {
  if (!api) return;
  api.group?.parent?.remove(api.group);
  api.fill?.geometry?.dispose();
  api.fill?.material?.dispose();
  api.edges?.geometry?.dispose();
  api.edges?.material?.dispose();
}
