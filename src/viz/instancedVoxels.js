import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { elemToWorld } from './coordinates.js';
import { getTurboRamp } from './colormaps.js';

/**
 * Build a fresh InstancedMesh for the nx × ny × nz voxel domain.
 * The caller owns scene membership (add the returned mesh; call
 * `disposeVoxelMesh` on the previous one).
 *
 * @param {{ nx: number, ny: number, nz: number, volfrac?: number }} config
 * @param {{ scene?: THREE.Scene, previous?: THREE.InstancedMesh | null }} [options]
 *        If `scene` is given the previous mesh is removed/disposed and the new one added.
 * @returns {THREE.InstancedMesh}
 */
export function rebuildDomainAndMesh(config, options = {}) {
  const { scene, previous } = options;
  const { nx, ny, nz } = config;
  const total = nx * ny * nz;

  if (previous) {
    if (scene) scene.remove(previous);
    disposeVoxelMesh(previous);
  }

  const geom = new RoundedBoxGeometry(0.95, 0.95, 0.95, 2, 0.09);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.38,
    metalness: 0.25,
  });

  const mesh = new THREE.InstancedMesh(geom, mat, total);
  mesh.name = 'voxels';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  // Instances are rescaled / displaced every update; skip bounding-sphere culling.
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Seed with a uniform initial-density block so the viewport is never empty.
  const rho0 = config.volfrac ?? 0.35;
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const p = { x: 0, y: 0, z: 0 };
  const s = 0.5 + 0.5 * rho0;
  getTurboRamp(rho0, color);
  let i = 0;
  for (let ez = 0; ez < nz; ez++) {
    for (let ey = 0; ey < ny; ey++) {
      for (let ex = 0; ex < nx; ex++, i++) {
        elemToWorld(config, ex, ey, ez, p);
        dummy.position.set(p.x, p.y, p.z);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, color);
      }
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;

  if (scene) scene.add(mesh);
  return mesh;
}

/** Free GPU resources of an instanced voxel mesh. */
export function disposeVoxelMesh(mesh) {
  if (!mesh) return;
  mesh.parent?.remove(mesh);
  mesh.geometry?.dispose();
  const m = mesh.material;
  if (Array.isArray(m)) m.forEach((x) => x.dispose());
  else m?.dispose();
  mesh.dispose?.();
}
