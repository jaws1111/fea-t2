/**
 * Smooth-body mesher worker: runs marching cubes + Taubin smoothing off the main thread.
 *
 * in : { id, nx, ny, nz, iso, smoothIters, densities: Float32Array (transferred) }
 * out: { id, ms, positions, normals, indices } (ArrayBuffers, transferred)
 */
import { buildSmoothMesh } from './smoothMeshCore.js';

self.onmessage = (e) => {
  const { id, nx, ny, nz, iso, smoothIters, densities } = e.data;
  const t0 = performance.now();
  let mesh;
  try {
    mesh = buildSmoothMesh(densities, { nx, ny, nz, iso, smoothIters });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
    return;
  }
  const { positions, normals, indices } = mesh;
  self.postMessage(
    { id, ms: performance.now() - t0, positions, normals, indices },
    [positions.buffer, normals.buffer, indices.buffer],
  );
};
