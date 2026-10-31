import * as THREE from 'three';
import { buildSmoothMesh } from './smoothMeshCore.js';

const BODY_COLOR = 0xc0c8d4;
/** Minimum gap between two mesh jobs so meshing never starves the rest of the app. */
const MIN_JOB_GAP_MS = 90;

/**
 * Smooth body surface. Meshing (marching cubes + Taubin) runs in a Web Worker; the
 * main thread only copies the densities in and swaps the finished geometry. Requests
 * are latest-wins: while a job runs, newer requests overwrite each other.
 *
 * @param {THREE.Scene} scene
 */
export function createSmoothBody(scene) {
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.MeshStandardMaterial({
    color: BODY_COLOR,
    metalness: 0.28,
    roughness: 0.45,
    // Closed MC mesh; DoubleSide covers any residual winding flips after Taubin.
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'smoothBody';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.visible = false;
  mesh.frustumCulled = false;
  scene.add(mesh);

  const api = {
    mesh,
    geometry,
    material,
    /** @type {Worker | null} */
    worker: null,
    workerFailed: false,
    jobId: 0,
    /** Newest request waiting for the worker. */
    pending: /** @type {any} */ (null),
    inFlight: false,
    lastDoneAt: 0,
    timer: 0,
    /** Mesh build time of the last finished job (ms, off the main thread). */
    lastMeshMs: 0,
    wanted: false,
    onMesh: /** @type {(() => void) | null} */ (null),
  };
  return api;
}

function ensureWorker(api) {
  if (api.worker || api.workerFailed) return api.worker;
  try {
    api.worker = new Worker(new URL('./smoothWorker.js', import.meta.url), { type: 'module' });
    api.worker.onmessage = (e) => onWorkerResult(api, e.data);
    api.worker.onerror = (e) => {
      console.error('[smoothBody] worker error', e.message || e);
      api.workerFailed = true;
      api.worker = null;
      api.inFlight = false;
    };
  } catch (err) {
    console.error('[smoothBody] worker unavailable, meshing on the main thread', err);
    api.workerFailed = true;
    api.worker = null;
  }
  return api.worker;
}

function applyMesh(api, { positions, normals, indices }) {
  const old = api.geometry;
  if (positions.length === 0) {
    api.mesh.visible = false;
    return false;
  }
  // Fresh geometry each time; disposing the old one releases its GPU buffers.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeBoundingSphere();
  api.geometry = g;
  api.mesh.geometry = g;
  old.dispose();
  api.mesh.visible = api.wanted;
  api.onMesh?.();
  return true;
}

function onWorkerResult(api, msg) {
  api.inFlight = false;
  api.lastDoneAt = performance.now();
  if (msg.error) {
    console.error('[smoothBody]', msg.error);
  } else if (msg.id === api.jobId) {
    // Only the newest job may be shown (older ones were superseded).
    api.lastMeshMs = msg.ms;
    if (api.wanted) {
      applyMesh(api, {
        positions: msg.positions,
        normals: msg.normals,
        indices: msg.indices,
      });
    }
  }
  pump(api);
}

function pump(api) {
  if (!api.pending || api.inFlight || api.timer) return;
  const wait = MIN_JOB_GAP_MS - (performance.now() - api.lastDoneAt);
  if (wait > 0) {
    api.timer = setTimeout(() => {
      api.timer = 0;
      pump(api);
    }, wait);
    return;
  }
  const job = api.pending;
  api.pending = null;
  const worker = ensureWorker(api);
  if (!worker) {
    const t0 = performance.now();
    const mesh = buildSmoothMesh(job.densities, job);
    api.lastMeshMs = performance.now() - t0;
    api.lastDoneAt = performance.now();
    if (api.wanted) applyMesh(api, mesh);
    return;
  }
  api.inFlight = true;
  worker.postMessage({ ...job, id: job.id }, [job.densities.buffer]);
}

/**
 * Request a fresh smooth surface for these densities (asynchronous, latest-wins).
 *
 * @param {ReturnType<typeof createSmoothBody>} meshApi
 * @param {{
 *   densities: Float32Array | null,
 *   config: { nx: number, ny: number, nz: number },
 *   iso?: number,
 *   smoothIters?: number,
 * }} args
 * @returns {boolean}
 */
export function updateSmoothBody(meshApi, { densities, config, iso = 0.45, smoothIters = 4 }) {
  if (!meshApi?.mesh) return false;
  const { nx, ny, nz } = config;
  meshApi.wanted = true;
  if (!densities || densities.length !== nx * ny * nz) {
    meshApi.mesh.visible = false;
    return false;
  }
  meshApi.jobId += 1;
  // The worker takes ownership of the copy; the caller's field stays intact.
  meshApi.pending = { id: meshApi.jobId, nx, ny, nz, iso, smoothIters, densities: densities.slice() };
  // Keep showing the previous surface (if any) until the new one is ready.
  if (meshApi.geometry.index) meshApi.mesh.visible = true;
  pump(meshApi);
  return true;
}

/**
 * @param {{ mesh: THREE.Mesh }} meshApi
 * @param {boolean} visible
 */
export function setSmoothBodyVisible(meshApi, visible) {
  if (!meshApi?.mesh) return;
  meshApi.wanted = !!visible;
  if (!visible) meshApi.pending = null;
  meshApi.mesh.visible = !!visible && !!meshApi.geometry?.index;
}

/** Drop the current surface and any queued job (grid / preset changed). */
export function resetSmoothBody(meshApi) {
  if (!meshApi?.mesh) return;
  meshApi.jobId += 1; // invalidates a job still running in the worker
  meshApi.pending = null;
  const old = meshApi.geometry;
  const g = new THREE.BufferGeometry();
  meshApi.geometry = g;
  meshApi.mesh.geometry = g;
  old.dispose();
  meshApi.mesh.visible = false;
}

/**
 * @param {ReturnType<typeof createSmoothBody>} meshApi
 */
export function disposeSmoothBody(meshApi) {
  if (!meshApi) return;
  clearTimeout(meshApi.timer);
  meshApi.worker?.terminate();
  meshApi.worker = null;
  meshApi.mesh?.parent?.remove(meshApi.mesh);
  meshApi.geometry?.dispose();
  const m = meshApi.material;
  if (Array.isArray(m)) m.forEach((x) => x.dispose());
  else m?.dispose();
}
