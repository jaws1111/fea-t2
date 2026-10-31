import { RingBuffer } from './ringBuffer.js';

/** Series tracked by the performance monitor. */
export const SERIES = Object.freeze([
  'fps',
  'solveHz',
  'feaMs',
  'filterOcMs',
  'vizMs',
  'cgResidual',
  'compliance',
  'heapMb',
]);

/**
 * Time-aligned metric history. Every `pushSample` appends one row to *all*
 * series (values not supplied carry the latest known value), so the data
 * can be handed straight to uPlot as `[xs, ...ys]`.
 */
export class MetricsCollector {
  /**
   * @param {{ capacity?: number, series?: readonly string[] }} [options]
   */
  constructor({ capacity = 300, series = SERIES } = {}) {
    this.capacity = capacity;
    this.names = [...series];
    this.time = new RingBuffer(capacity);
    /** @type {Record<string, RingBuffer>} */
    this.series = {};
    /** @type {Record<string, number>} */
    this.latest = {};
    for (const n of this.names) {
      this.series[n] = new RingBuffer(capacity);
      this.latest[n] = NaN;
    }
    this._t0 = performance.now();
  }

  /**
   * Update latest known values without appending a row (event-driven metrics).
   * @param {Record<string, number | undefined | null>} values
   */
  update(values) {
    for (const k in values) {
      const v = values[k];
      if (k in this.latest && v != null && Number.isFinite(v)) this.latest[k] = v;
    }
  }

  /**
   * Append one aligned row.
   * @param {Record<string, number | undefined | null>} [values] merged into latest first
   * @param {number} [nowMs] performance.now()-style timestamp
   */
  pushSample(values = {}, nowMs = performance.now()) {
    this.update(values);
    this.time.push((nowMs - this._t0) / 1000);
    for (const n of this.names) this.series[n].push(this.latest[n]);
  }

  /** Number of rows currently stored. */
  get length() {
    return this.time.length;
  }

  /**
   * uPlot-ready columns: `[xsSeconds, ...seriesValues]` (oldest → newest).
   * Non-finite values become `null` (gaps); with `logSafe`, values ≤ 0 do too.
   * @param {string[]} [names] subset/order of series (default: all)
   * @param {{ logSafe?: boolean }} [opts]
   * @returns {(number | null)[][]}
   */
  getAlignedData(names = this.names, opts = {}) {
    const n = this.time.length;
    const xs = this.time.toArray();
    const cols = [xs];
    for (const name of names) {
      const buf = this.series[name];
      const col = new Array(n);
      for (let i = 0; i < n; i++) {
        const v = buf ? buf.get(i) : NaN;
        col[i] = Number.isFinite(v) && (!opts.logSafe || v > 0) ? v : null;
      }
      cols.push(col);
    }
    return cols;
  }

  clear() {
    this.time.clear();
    for (const n of this.names) {
      this.series[n].clear();
      this.latest[n] = NaN;
    }
  }
}
