/**
 * Smooth-body mesher worker: runs marching cubes + Taubin smoothing + vertex colouring
 * off the main thread.
 *
 * in : { id, nx, ny, nz, iso, smoothIters, colorMode, lut, densities, energies }
 *      (densities / energies Float32Array, transferred)
 * out: { id, ms, positions, normals, indices, colors } (ArrayBuffers, transferred)
 */
import { buildSmoothMesh } from './smoothMeshCore.js';

self.onmessage = (e) => {
  const { id, densities, ...opts } = e.data;
  const t0 = performance.now();
  let mesh;
  try {
    mesh = buildSmoothMesh(densities, opts);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
    return;
  }
  const { positions, normals, indices, colors } = mesh;
  const transfer = [positions.buffer, normals.buffer, indices.buffer];
  if (colors) transfer.push(colors.buffer);
  self.postMessage({ id, ms: performance.now() - t0, positions, normals, indices, colors }, transfer);
};
