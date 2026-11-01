import * as THREE from 'three';
import { getFixtureDescriptors } from '../presets/boundaryConditions.js';
import { nodeToWorld } from './coordinates.js';

/** Dispose geometries/materials previously attached to a fixtures group. */
function clearGroup(group) {
  const geoms = new Set();
  const mats = new Set();
  group.traverse((o) => {
    if (o.geometry) geoms.add(o.geometry);
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => mats.add(m));
      else mats.add(o.material);
    }
  });
  geoms.forEach((g) => g.dispose());
  mats.forEach((m) => m.dispose());
  group.clear();
}

/**
 * Rebuild support / load glyphs for the current preset and grid size.
 *
 * @param {THREE.Group} group
 * @param {{ nx: number, ny: number, nz: number, preset: string }} config
 * @returns {THREE.Group}
 */
export function updateBoundaryFixtures(group, config) {
  clearGroup(group);

  const { nx, ny, nz, preset } = config;
  const descriptors = getFixtureDescriptors(preset, nx, ny, nz, config.scene ?? null);

  const pierMat = new THREE.MeshStandardMaterial({ color: 0x10b981, roughness: 0.4, metalness: 0.3 });
  const symMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.4, metalness: 0.3 });
  const axleMat = new THREE.MeshStandardMaterial({ color: 0xa78bfa, roughness: 0.35, metalness: 0.4 });
  const arrowMat = new THREE.MeshStandardMaterial({
    color: 0xef4444,
    roughness: 0.3,
    emissive: 0x7f1d1d,
    emissiveIntensity: 0.9,
  });

  // Shared geometries (one per kind).
  const pierGeom = new THREE.BoxGeometry(0.85, 1.0, 0.85);
  const wallGeom = new THREE.BoxGeometry(0.7, 0.7, 0.7);
  const axleGeom = new THREE.BoxGeometry(0.8, 0.8, 0.8);
  const coneGeom = new THREE.ConeGeometry(0.5, 1.2, 16);
  coneGeom.rotateX(Math.PI);
  const stemGeom = new THREE.CylinderGeometry(0.18, 0.18, 1.0, 16);

  const p = { x: 0, y: 0, z: 0 };

  const addMesh = (geom, mat, x, y, z) => {
    const m = new THREE.Mesh(geom, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };

  const boltMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.35, metalness: 0.6 });
  const boltFreeMat = new THREE.MeshStandardMaterial({ color: 0x22d3ee, roughness: 0.35, metalness: 0.5 });
  const loadMat = arrowMat;
  const roadMat = new THREE.MeshBasicMaterial({
    color: 0xef4444,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  const cavityMat = new THREE.MeshBasicMaterial({
    color: 0xef4444,
    transparent: true,
    opacity: 0.25,
    wireframe: true,
  });
  const wallMat = new THREE.MeshBasicMaterial({
    color: 0xf59e0b,
    transparent: true,
    opacity: 0.18,
    wireframe: true,
  });
  const UP = new THREE.Vector3(0, 1, 0);

  /** Arrow glyph pointing along `dir` whose tip touches (x,y,z) (same proportions as 'load'). */
  const addDirArrow = (x, y, z, dir, mat = arrowMat, scale = 1) => {
    const arrow = new THREE.Group();
    arrow.scale.setScalar(scale);
    const cone = new THREE.Mesh(coneGeom, mat);
    cone.position.set(0, 0.6, 0);
    const stem = new THREE.Mesh(stemGeom, mat);
    stem.position.set(0, 1.5, 0);
    cone.castShadow = true;
    stem.castShadow = true;
    arrow.add(cone, stem);
    // Preset arrows point down (-Y) with the tip at the origin; orient from -Y to dir.
    const d = new THREE.Vector3(dir.x, dir.y, dir.z).normalize();
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), d);
    arrow.position.set(x, y, z);
    group.add(arrow);
    return arrow;
  };

  const axisQuat = (axis) => {
    const q = new THREE.Quaternion();
    if (axis === 'x') q.setFromUnitVectors(UP, new THREE.Vector3(1, 0, 0));
    else if (axis === 'z') q.setFromUnitVectors(UP, new THREE.Vector3(0, 0, 1));
    return q;
  };

  const orientTube = (mesh, f, cfg) => {
    const axis = f.axis ?? 'z';
    const n = axis === 'x' ? cfg.nx : axis === 'y' ? cfg.ny : cfg.nz;
    mesh.quaternion.copy(axisQuat(axis));
    if (f.rotation) {
      const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.rotation);
      mesh.quaternion.multiply(spin);
    }
    const aMid = ((f.a0 ?? 0) + (f.a1 ?? n)) / 2 - n / 2;
    if (axis === 'x') mesh.position.x += aMid;
    else if (axis === 'y') mesh.position.y += aMid;
    else mesh.position.z += aMid;
  };

  for (const f of descriptors) {
    nodeToWorld(config, f.ix, f.iy, f.iz, p);
    switch (f.kind) {
      case 'pier':
        addMesh(pierGeom, pierMat, p.x, p.y - 0.5, p.z);
        break;
      case 'rest': {
        const r = f.radius ?? 0.8;
        const m = addMesh(new THREE.SphereGeometry(Math.max(0.5, r), 16, 12), pierMat, p.x, p.y, p.z);
        m.castShadow = false;
        break;
      }
      case 'bolt': {
        const axis = f.axis ?? 'z';
        const n = axis === 'x' ? config.nx : axis === 'y' ? config.ny : config.nz;
        const a0 = f.a0 ?? 0;
        const a1 = f.a1 ?? n;
        const R = Math.max(0.4, f.radius ?? 0.8);
        const anyFixed = !!(f.fixed && (f.fixed.x || f.fixed.y || f.fixed.z));
        const m = addMesh(
          new THREE.CylinderGeometry(R, R, Math.max(0.2, a1 - a0) + 0.2, 24),
          anyFixed ? boltMat : boltFreeMat,
          p.x,
          p.y,
          p.z,
        );
        m.quaternion.copy(axisQuat(axis));
        // Centre the pin on its axial span.
        const aMid = (a0 + a1) / 2 - n / 2;
        if (axis === 'x') m.position.x = aMid;
        else if (axis === 'y') m.position.y = aMid;
        else m.position.z = aMid;
        m.castShadow = false;

        const centre = new THREE.Vector3(m.position.x, m.position.y, m.position.z);
        const axisVec = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);

        // Bearing vectors: tip rests on the bore wall facing the load.
        for (const l of f.loads ?? []) {
          const d = new THREE.Vector3(l.dir.x, l.dir.y, l.dir.z);
          const axial = d.dot(axisVec);
          const perp = d.clone().addScaledVector(axisVec, -axial);
          const tip = centre.clone();
          if (perp.length() > 1e-3) tip.addScaledVector(perp.normalize(), R);
          else tip.addScaledVector(axisVec, Math.sign(axial || 1) * ((a1 - a0) / 2 + 0.1));
          addDirArrow(tip.x - d.x * 0.2, tip.y - d.y * 0.2, tip.z - d.z * 0.2, d, loadMat, 1);
        }

        // Circular load: ring of tangent / radial arrows.
        if (f.circ) {
          const ref = Math.abs(axisVec.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
          const e1 = new THREE.Vector3().crossVectors(axisVec, ref).normalize();
          const e2 = new THREE.Vector3().crossVectors(axisVec, e1).normalize();
          const K = 8;
          for (let k = 0; k < K; k++) {
            const th = (2 * Math.PI * k) / K;
            const rhat = e1.clone().multiplyScalar(Math.cos(th)).addScaledVector(e2, Math.sin(th));
            const dir =
              f.circ.mode === 'radial'
                ? rhat.clone().multiplyScalar(f.circ.sign)
                : new THREE.Vector3().crossVectors(axisVec, rhat).multiplyScalar(f.circ.sign);
            const tip = centre.clone().addScaledVector(rhat, R);
            addDirArrow(tip.x, tip.y, tip.z, dir, loadMat, 0.6);
          }
        }
        break;
      }
      case 'wall':
        if (f.face) {
          const axis = f.face[0];
          const sign = f.face[1] === '+' ? 1 : -1;
          const w = Math.max(1, f.w ?? 1);
          const h = Math.max(1, f.h ?? 1);
          const t = 0.3;
          const sx = axis === 'x' ? t : axis === 'y' ? w : w;
          const sy = axis === 'x' ? w : axis === 'y' ? t : h;
          const sz = axis === 'x' ? h : axis === 'y' ? h : t;
          const m = addMesh(
            new THREE.BoxGeometry(sx, sy, sz),
            pierMat,
            p.x + (axis === 'x' ? sign * t * 0.5 : 0),
            p.y + (axis === 'y' ? sign * t * 0.5 : 0),
            p.z + (axis === 'z' ? sign * t * 0.5 : 0),
          );
          m.castShadow = false;
        } else {
          addMesh(wallGeom, pierMat, p.x - 0.4, p.y, p.z);
        }
        break;
      case 'pressure': {
        const cylH = Math.max(0.2, (f.a1 ?? 1) - (f.a0 ?? 0));
        const cylR = Math.max(0.4, f.radius ?? 1);
        const geom =
          f.shape === 'box'
            ? new THREE.BoxGeometry(2 * (f.half?.x ?? 1), 2 * (f.half?.y ?? 1), 2 * (f.half?.z ?? 1))
            : f.shape === 'cylinder'
              ? new THREE.CylinderGeometry(cylR, cylR, cylH, 24)
              : new THREE.SphereGeometry(Math.max(1, f.radius ?? 1), 16, 12);
        const m = addMesh(geom, cavityMat, p.x, p.y, p.z);
        m.castShadow = false;
        m.receiveShadow = false;
        if (f.shape === 'cylinder') orientTube(m, f, config);
        // Locked wall around the cavity.
        if (f.cavity) {
          const w = f.wall ?? 2;
          const wallGeomShell =
            f.shape === 'box'
              ? new THREE.BoxGeometry(
                  2 * ((f.half?.x ?? 1) + w),
                  2 * ((f.half?.y ?? 1) + w),
                  2 * ((f.half?.z ?? 1) + w),
                )
              : f.shape === 'cylinder'
                ? new THREE.CylinderGeometry(cylR + w, cylR + w, cylH + 2 * w, 24)
                : new THREE.SphereGeometry(Math.max(1, f.radius ?? 1) + w, 16, 12);
          const wm = addMesh(wallGeomShell, wallMat, p.x, p.y, p.z);
          wm.castShadow = false;
          wm.receiveShadow = false;
          if (f.shape === 'cylinder') orientTube(wm, f, config);
        }
        if (!f.radial && f.dir) addDirArrow(p.x - f.dir.x * 0.2, p.y - f.dir.y * 0.2, p.z - f.dir.z * 0.2, f.dir);
        break;
      }
      case 'shell': {
        const R = Math.max(0.4, f.radiusOut ?? f.radius ?? 1);
        const geom = f.profile === 'sphere'
          ? new THREE.SphereGeometry(R, 20, 14)
          : new THREE.CylinderGeometry(R, R, Math.max(0.2, (f.a1 ?? 1) - (f.a0 ?? 0)), f.profile === 'prism' ? Math.max(3, f.n ?? 6) : 24);
        const m = addMesh(geom, wallMat, p.x, p.y, p.z);
        m.castShadow = false;
        if (f.profile !== 'sphere') orientTube(m, f, config);
        break;
      }
      case 'ring': {
        const geom = new THREE.TorusGeometry(Math.max(0.6, f.radius ?? 1), 0.18, 8, 28);
        const m = addMesh(geom, pierMat, p.x, p.y, p.z);
        m.castShadow = false;
        if (f.axis === 'x') m.rotation.y = Math.PI / 2;
        else if (f.axis === 'y') m.rotation.x = Math.PI / 2;
        break;
      }
      case 'pad': {
        const axis = f.axis ?? 'y';
        const w = Math.max(0.4, f.w ?? 1);
        const h = Math.max(0.4, f.h ?? 1);
        const size = axis === 'x' ? [0.25, w, h] : axis === 'z' ? [w, h, 0.25] : [w, 0.25, h];
        const geom = new THREE.BoxGeometry(size[0], size[1], size[2]);
        const m = addMesh(geom, pierMat, p.x, p.y, p.z);
        m.castShadow = false;
        break;
      }
      case 'block': {
        const geom = new THREE.BoxGeometry(2 * (f.half?.x ?? 1), 2 * (f.half?.y ?? 1), 2 * (f.half?.z ?? 1));
        const m = addMesh(geom, f.void ? cavityMat : wallMat, p.x, p.y, p.z);
        m.castShadow = false;
        break;
      }
      case 'road': {
        // Translucent slab on the top face: distributed (road) pressure patch.
        const p2 = { x: 0, y: 0, z: 0 };
        nodeToWorld(config, f.ix1 ?? f.ix, f.iy, f.iz1 ?? f.iz, p2);
        const w = Math.max(0.2, Math.abs(p2.x - p.x));
        const d = Math.max(0.2, Math.abs(p2.z - p.z));
        const m = addMesh(new THREE.BoxGeometry(w, 0.12, d), roadMat, (p.x + p2.x) / 2, p.y + 0.06, (p.z + p2.z) / 2);
        m.castShadow = false;
        m.receiveShadow = false;
        break;
      }
      case 'sym':
        addMesh(wallGeom, symMat, p.x - 0.4, p.y, p.z);
        break;
      case 'axle':
        addMesh(axleGeom, axleMat, p.x, p.y, p.z);
        break;
      case 'load': {
        if (f.dir) {
          const lead = f.lead ?? 0;
          const dl = Math.hypot(f.dir.x, f.dir.y, f.dir.z) || 1;
          addDirArrow(
            p.x + (f.dir.x / dl) * lead,
            p.y + (f.dir.y / dl) * lead,
            p.z + (f.dir.z / dl) * lead,
            f.dir,
            arrowMat,
            f.scale ?? 1,
          );
          break;
        }
        const arrow = new THREE.Group();
        const cone = new THREE.Mesh(coneGeom, arrowMat);
        cone.position.set(0, 0.6, 0);
        const stem = new THREE.Mesh(stemGeom, arrowMat);
        stem.position.set(0, 1.5, 0);
        cone.castShadow = true;
        stem.castShadow = true;
        arrow.add(cone, stem);
        arrow.position.set(p.x, p.y + 0.1, p.z);
        group.add(arrow);
        break;
      }
      default:
        break;
    }
  }

  return group;
}
