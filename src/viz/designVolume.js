import * as THREE from 'three';
import { resolveWorkingBounds, workingAxis, workingShape } from '../scene/workingVolume.js';

/**
 * Translucent AABB for the FEA working / design volume.
 *
 * @param {THREE.Scene} scene
 */
function addEnvelope(parent, geometry, name) {
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
  fill.name = `${name}Fill`;
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
  edges.name = `${name}Edges`;
  edges.renderOrder = -1;
  const holder = new THREE.Group();
  holder.name = name;
  holder.add(fill);
  holder.add(edges);
  holder.visible = false;
  parent.add(holder);
  return { holder, fill, edges, geometry };
}

export function createDesignVolume(scene) {
  const group = new THREE.Group();
  group.name = 'designVolume';
  const shapes = {
    box: addEnvelope(group, new THREE.BoxGeometry(1, 1, 1), 'designVolumeBox'),
    sphere: addEnvelope(group, new THREE.SphereGeometry(0.5, 24, 16), 'designVolumeSphere'),
    cylinder: addEnvelope(group, new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 1), 'designVolumeCylinder'),
  };
  group.visible = false;
  scene.add(group);
  const solids = [shapes.box.fill, shapes.sphere.fill, shapes.cylinder.fill];
  const wires = [shapes.box.edges, shapes.sphere.edges, shapes.cylinder.edges];
  return { group, fill: shapes.box.fill, edges: shapes.box.edges, shapes, solids, wires };
}

/**
 * Fit the helper to the working volume (or full grid).
 * World: domain centred on origin, 1 cell = 1 unit.
 *
 * @param {{ group: THREE.Group }} api
 * @param {{ nx: number, ny: number, nz: number, scene?: import('../scene/types.js').Scene | null }} dims
 * @param {{ x0: number, x1: number, y0: number, y1: number, z0: number, z1: number } | null} [boundsOverride]
 *   box to draw instead (may extend past the domain, e.g. while dragging a corner)
 */
export function updateDesignVolume(api, dims, boundsOverride = null) {
  if (!api?.group || !dims) return;
  const { nx, ny, nz } = dims;
  const b = boundsOverride ?? resolveWorkingBounds(dims.scene ?? null, { nx, ny, nz });
  const sx = Math.max(0.05, (b.x1 - b.x0) * nx);
  const sy = Math.max(0.05, (b.y1 - b.y0) * ny);
  const sz = Math.max(0.05, (b.z1 - b.z0) * nz);
  const cx = ((b.x0 + b.x1) / 2) * nx - nx / 2;
  const cy = ((b.y0 + b.y1) / 2) * ny - ny / 2;
  const cz = ((b.z0 + b.z1) / 2) * nz - nz / 2;
  api.group.scale.set(1, 1, 1);
  api.group.position.set(cx, cy, cz);

  const kind = workingShape(dims.scene ?? null);
  const axis = workingAxis(dims.scene ?? null);
  for (const key of ['box', 'sphere', 'cylinder']) {
    const part = api.shapes?.[key];
    if (!part) continue;
    part.holder.visible = key === kind;
    part.holder.rotation.set(0, 0, 0);
    part.holder.scale.set(1, 1, 1);
  }
  if (kind === 'sphere') {
    const d = Math.min(sx, sy, sz);
    api.shapes.sphere.holder.scale.set(d, d, d);
  } else if (kind === 'cylinder') {
    const len = axis === 'x' ? sx : axis === 'y' ? sy : sz;
    const dia = axis === 'x' ? Math.min(sy, sz) : axis === 'y' ? Math.min(sx, sz) : Math.min(sx, sy);
    const holder = api.shapes.cylinder.holder;
    holder.scale.set(dia, len, dia);
    if (axis === 'x') holder.rotation.set(0, 0, -Math.PI / 2);
    else if (axis === 'z') holder.rotation.set(Math.PI / 2, 0, 0);
  } else {
    api.shapes.box.holder.scale.set(sx, sy, sz);
  }
  api.fill = api.shapes[kind].fill;
  api.edges = api.shapes[kind].edges;
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
  const parts = api.shapes ? Object.values(api.shapes) : [];
  for (const part of parts) {
    part.geometry?.dispose();
    part.fill?.material?.dispose();
    part.edges?.geometry?.dispose();
    part.edges?.material?.dispose();
  }
}
