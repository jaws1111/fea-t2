/**
 * WebGPU adapter/device acquisition. Safe in window and DedicatedWorker scopes
 * (uses globalThis.navigator.gpu). Resolves to null when unsupported or when
 * adapter/device creation fails; never throws.
 */

/** @type {Promise<GpuContext | null> | null} */
let cachedContext = null;

/**
 * @typedef {Object} GpuContext
 * @property {GPUAdapter} adapter
 * @property {GPUDevice} device
 * @property {GPUQueue} queue
 * @property {GPUSupportedLimits} limits
 * @property {{ vendor?: string, architecture?: string, description?: string }} info
 */

/** @returns {boolean} true if navigator.gpu exists in this scope. */
export function isWebGpuAvailable() {
  const nav = /** @type {any} */ (globalThis).navigator;
  return !!(nav && nav.gpu);
}

/**
 * @param {{ powerPreference?: 'low-power' | 'high-performance', force?: boolean }} [options]
 * @returns {Promise<GpuContext | null>}
 */
export function getGpuContext(options = {}) {
  if (options.force) cachedContext = null;
  if (!cachedContext) {
    cachedContext = createGpuContext(options).then((ctx) => {
      // Do not cache failures forever; a later call may succeed.
      if (!ctx) cachedContext = null;
      return ctx;
    });
  }
  return cachedContext;
}

/**
 * @param {{ powerPreference?: 'low-power' | 'high-performance' }} [options]
 * @returns {Promise<GpuContext | null>}
 */
export async function createGpuContext(options = {}) {
  try {
    if (!isWebGpuAvailable()) return null;
    const gpu = /** @type {any} */ (globalThis).navigator.gpu;

    const adapter = await gpu.requestAdapter({
      powerPreference: options.powerPreference ?? 'high-performance',
    });
    if (!adapter) return null;

    const device = await adapter.requestDevice();
    if (!device) return null;

    let info = {};
    try {
      if (adapter.info) info = adapter.info;
      else if (typeof adapter.requestAdapterInfo === 'function') {
        info = await adapter.requestAdapterInfo();
      }
    } catch {
      info = {};
    }

    device.lost.then(() => {
      // Drop the cached context so the next getGpuContext() re-acquires a device.
      cachedContext = null;
    });

    return { adapter, device, queue: device.queue, limits: device.limits, info };
  } catch {
    return null;
  }
}
