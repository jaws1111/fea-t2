# TopoOpt 3D — Topology Optimization Studio

Modular browser studio for 3D SIMP topology optimization with a decoupled worker, WebGPU matrix-free PCG (CPU auto-fallback), Three.js voxel visualization, and a live uPlot performance monitor.

## Quick start

```bash
npm install
npm run dev
```

Open the printed local URL (default `http://localhost:5173`).

```bash
npm run build    # production → dist/
npm run preview  # serve dist/
```

## Architecture

| Layer | Role |
|--------|------|
| `src/fea` + `src/topo` | Hex8 KE, matrix-free Jacobi-PCG, sensitivity filter, SIMP OC |
| `src/solver` | CPU + WebGPU backends; auto-picks fastest for grid size |
| `src/worker` | Module worker — transferable density / energy / disp buffers |
| `src/viz` | Three.js instanced voxels, colormaps, BC glyphs |
| `src/perf` | Metrics ring buffers + uPlot live charts |
| `doc/` | Original monolithic HTML reference (unchanged) |

## Backends

- **CPU** — default for typical studio resolutions (lowest latency).
- **WebGPU** — structured-grid gather SpMV (no atomics); used when available and beneficial on larger meshes. Badge shows `WebGPU` or `CPU · GPU ready`.

## Reference

Behavior is ported from [`doc/topology_optimization_studio_3d (2).html`](doc/topology_optimization_studio_3d%20(2).html).
