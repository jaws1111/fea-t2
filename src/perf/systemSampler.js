/**
 * Samples main-thread JS heap (Chromium `performance.memory`) and
 * Three.js `renderer.info` counters.
 */
export class SystemSampler {
  /** @param {import('three').WebGLRenderer | null} [renderer] */
  constructor(renderer = null) {
    this.renderer = renderer;
  }

  setRenderer(renderer) {
    this.renderer = renderer;
  }

  /**
   * @returns {{
   *   heapMb: number, heapLimitMb: number,
   *   drawCalls: number, triangles: number, points: number, lines: number,
   *   geometries: number, textures: number, programs: number,
   * }} numeric fields are NaN/0 when unavailable
   */
  sample() {
    const mem = typeof performance !== 'undefined' ? performance.memory : undefined;
    const info = this.renderer?.info;
    return {
      heapMb: mem ? mem.usedJSHeapSize / 1048576 : NaN,
      heapLimitMb: mem ? mem.jsHeapSizeLimit / 1048576 : NaN,
      drawCalls: info?.render.calls ?? 0,
      triangles: info?.render.triangles ?? 0,
      points: info?.render.points ?? 0,
      lines: info?.render.lines ?? 0,
      geometries: info?.memory.geometries ?? 0,
      textures: info?.memory.textures ?? 0,
      programs: info?.programs?.length ?? 0,
    };
  }
}
