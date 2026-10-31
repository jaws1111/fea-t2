import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

const AXIS_STROKE = '#64748b';
const GRID_STROKE = 'rgba(148, 163, 184, 0.08)';
const FONT = '10px "JetBrains Mono", ui-monospace, monospace';

const fmtFixed = (d) => (v) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const fmtExp = (v) => (Number.isFinite(v) && v > 0 ? v.toExponential(1) : '—');
const fmtCompliance = (v) => {
  if (!Number.isFinite(v)) return '—';
  return Math.abs(v) >= 1000 ? v.toExponential(2) : v.toFixed(2);
};

/**
 * @typedef {Object} ChartSpec
 * @property {string} id
 * @property {string} title
 * @property {string} unit
 * @property {boolean} [log]
 * @property {boolean} [zeroBased]
 * @property {{ key: string, label: string, color: string, fmt: (v:number)=>string }[]} series
 */

/** @type {ChartSpec[]} */
const CHARTS = [
  {
    id: 'rate',
    title: 'Frame & Solve Rate',
    unit: 'Hz',
    zeroBased: true,
    series: [
      { key: 'fps', label: 'FPS', color: '#34d399', fmt: fmtFixed(0) },
      { key: 'solveHz', label: 'Solve', color: '#a78bfa', fmt: fmtFixed(1) },
    ],
  },
  {
    id: 'pipeline',
    title: 'Pipeline',
    unit: 'ms',
    zeroBased: true,
    series: [
      { key: 'feaMs', label: 'FEA', color: '#f59e0b', fmt: fmtFixed(1) },
      { key: 'filterOcMs', label: 'Filter+OC', color: '#22d3ee', fmt: fmtFixed(1) },
      { key: 'vizMs', label: 'Viz', color: '#f472b6', fmt: fmtFixed(2) },
    ],
  },
  {
    id: 'cg',
    title: 'PCG Residual',
    unit: '',
    log: true,
    series: [{ key: 'cgResidual', label: 'res', color: '#fb923c', fmt: fmtExp }],
  },
  {
    id: 'compliance',
    title: 'Compliance',
    unit: '',
    series: [{ key: 'compliance', label: 'C', color: '#c084fc', fmt: fmtCompliance }],
  },
  {
    id: 'heap',
    title: 'JS Heap',
    unit: 'MB',
    zeroBased: false,
    series: [{ key: 'heapMb', label: 'Heap', color: '#38bdf8', fmt: fmtFixed(1) }],
  },
];

export class PerformanceMonitor {
  /**
   * @param {HTMLElement} container element to mount into (styled by the host page)
   * @param {import('./metricsCollector.js').MetricsCollector} collector
   * @param {{ updateIntervalMs?: number, chartHeight?: number }} [options]
   */
  constructor(container, collector, options = {}) {
    this.container = container;
    this.collector = collector;
    this.updateIntervalMs = options.updateIntervalMs ?? 100;
    this.chartHeight = options.chartHeight ?? 78;
    this.collapsed = false;
    this._lastUpdate = 0;

    /** @type {{ spec: ChartSpec, plot: uPlot, cell: HTMLElement, readouts: HTMLElement[] }[]} */
    this.charts = [];
    this._observers = [];

    this._mount();
  }

  _mount() {
    const root = this.container;
    root.classList.add('perf-monitor');
    root.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'perf-head';
    head.innerHTML = `
      <i class="ph ph-chart-line-up perf-head-icon" aria-hidden="true"></i>
      <span class="perf-title">Performance Monitor</span>
      <span class="perf-badge" data-backend="cpu" data-perf-badge>CPU</span>
      <span class="perf-sys" data-perf-sys></span>
      <button type="button" class="perf-toggle" aria-label="Toggle performance monitor" aria-expanded="true">
        <i class="ph ph-caret-down" aria-hidden="true"></i>
      </button>`;
    root.appendChild(head);

    this.badgeEl = head.querySelector('[data-perf-badge]');
    this.sysEl = head.querySelector('[data-perf-sys]');
    this.toggleBtn = head.querySelector('.perf-toggle');
    this.toggleBtn.addEventListener('click', () => this.setCollapsed(!this.collapsed));

    this.grid = document.createElement('div');
    this.grid.className = 'perf-grid';
    root.appendChild(this.grid);

    for (const spec of CHARTS) this._createChart(spec);
  }

  /** @param {ChartSpec} spec */
  _createChart(spec) {
    const cell = document.createElement('div');
    cell.className = 'perf-cell';
    cell.dataset.chart = spec.id;

    const label = document.createElement('div');
    label.className = 'perf-cell-head';
    const title = document.createElement('span');
    title.className = 'perf-cell-title';
    title.textContent = spec.unit ? `${spec.title} (${spec.unit})` : spec.title;
    const vals = document.createElement('span');
    vals.className = 'perf-cell-vals';
    const readouts = spec.series.map((s) => {
      const el = document.createElement('span');
      el.style.color = s.color;
      el.textContent = `${s.label} —`;
      vals.appendChild(el);
      return el;
    });
    label.append(title, vals);

    const plotHost = document.createElement('div');
    plotHost.className = 'perf-plot';
    cell.append(label, plotHost);
    this.grid.appendChild(cell);

    const width = Math.max(120, cell.clientWidth || 200);
    const opts = {
      width,
      height: this.chartHeight,
      padding: [6, 4, 0, 0],
      legend: { show: false },
      cursor: { show: false },
      select: { show: false },
      scales: {
        x: { time: false },
        y: spec.log
          ? { distr: 3, log: 10 }
          : {
              range: (u, min, max) => {
                const hi = Number.isFinite(max) ? max : 1;
                const lo = Number.isFinite(min) ? min : 0;
                const pad = Math.max((hi - lo) * 0.12, hi === lo ? Math.abs(hi) * 0.1 || 1 : 0);
                return [spec.zeroBased ? 0 : lo - pad, hi + pad];
              },
            },
      },
      axes: [
        {
          stroke: AXIS_STROKE,
          font: FONT,
          size: 18,
          gap: 2,
          grid: { stroke: GRID_STROKE, width: 1 },
          ticks: { show: false },
          space: 56,
          values: (u, ticks) => ticks.map((v) => `${v.toFixed(0)}s`),
        },
        {
          stroke: AXIS_STROKE,
          font: FONT,
          size: 44,
          gap: 4,
          grid: { stroke: GRID_STROKE, width: 1 },
          ticks: { show: false },
          space: 22,
          values: (u, ticks) =>
            ticks.map((v) => {
              if (v == null) return '';
              if (spec.log) return v.toExponential(0);
              const a = Math.abs(v);
              if (a >= 10000 || (a > 0 && a < 0.01)) return v.toExponential(0);
              return a >= 100 ? v.toFixed(0) : +v.toFixed(2);
            }),
        },
      ],
      series: [
        {},
        ...spec.series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: 1.6,
          fill: spec.series.length === 1 ? `${s.color}22` : undefined,
          points: { show: false },
          spanGaps: false,
        })),
      ],
    };

    const empty = [[], ...spec.series.map(() => [])];
    const plot = new uPlot(opts, empty, plotHost);

    const ro = new ResizeObserver(() => {
      const w = Math.floor(cell.clientWidth);
      if (w > 40 && Math.abs(w - plot.width) > 1) plot.setSize({ width: w, height: this.chartHeight });
    });
    ro.observe(cell);
    this._observers.push(ro);

    this.charts.push({ spec, plot, cell, readouts });
  }

  /**
   * Show the active compute backend (e.g. "CPU", "WebGPU").
   * @param {string} name
   */
  setBackendBadge(name) {
    const label = String(name || 'CPU');
    this.badgeEl.textContent = label;
    this.badgeEl.dataset.backend = /gpu/i.test(label) ? 'gpu' : 'cpu';
  }

  /**
   * Optional renderer/system readout from SystemSampler.sample().
   * @param {{ drawCalls?: number, triangles?: number, geometries?: number, textures?: number }} sys
   */
  setSystemInfo(sys) {
    if (!sys) return;
    const tri = sys.triangles >= 1e6 ? `${(sys.triangles / 1e6).toFixed(2)}M` : `${Math.round(sys.triangles / 1e3)}k`;
    this.sysEl.textContent = `${sys.drawCalls ?? 0} calls · ${tri} tris`;
  }

  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.container.classList.toggle('is-collapsed', collapsed);
    this.toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    if (!collapsed) this.update(this.collector, performance.now(), true);
  }

  /**
   * Pull the latest data from the collector into every chart. Called once per
   * frame; internally throttled to `updateIntervalMs`.
   * @param {import('./metricsCollector.js').MetricsCollector} [collector]
   * @param {number} [now]
   * @param {boolean} [force]
   */
  update(collector = this.collector, now = performance.now(), force = false) {
    if (this.collapsed && !force) return;
    if (!force && now - this._lastUpdate < this.updateIntervalMs) return;
    this._lastUpdate = now;

    for (const { spec, plot, readouts } of this.charts) {
      const keys = spec.series.map((s) => s.key);
      const data = collector.getAlignedData(keys, { logSafe: !!spec.log });
      plot.setData(data);
      spec.series.forEach((s, i) => {
        const col = data[i + 1];
        const v = col.length ? col[col.length - 1] : null;
        readouts[i].textContent = `${s.label} ${v == null ? '—' : s.fmt(v)}`;
      });
    }
  }

  destroy() {
    this._observers.forEach((o) => o.disconnect());
    this.charts.forEach((c) => c.plot.destroy());
    this.charts = [];
    this.container.innerHTML = '';
  }
}
