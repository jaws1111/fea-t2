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
| `src/scene` | Scene document, components, supports, and loads |
| `src/library` | Built-in recipes and objects saved in the browser |
| `src/perf` | Metrics ring buffers + uPlot live charts |
| `doc/` | Original monolithic HTML reference (unchanged) |

## Object library

A problem in this studio is a recipe. A recipe is a scene document. Built-in recipes ship with the app. Recipes you save stay in `localStorage` under `topoopt.library.v1`. **Import** reads a JSON file into that list. **Export all** writes the list out.

`recipeId` on the studio config is the id of the recipe on screen. An edit clears it. Loading a recipe sets it again. The Optimize buttons load these ids.

| Button | Recipe |
| --- | --- |
| Bridge Arch | `builtin:bridge` |
| Deck Bridge | `builtin:deck` |
| Cantilever | `builtin:cantilever` |
| MBB Beam | `builtin:mbb` |
| Michell Wheel | `builtin:michell` |

**Custom Scene** clears `recipeId` and opens the Scene tab. An empty scene gets the two-bolt bracket as a starting point, and `recipeId` stays empty.

Worker `RESET` sends the grid, the SIMP settings, and the scene. Supports, loads, passive cells, and load cases come from that scene.

## Backends

- **CPU** — default for typical studio resolutions (lowest latency).
- **WebGPU** — structured-grid gather SpMV (no atomics); used when available and beneficial on larger meshes. Badge shows `WebGPU` or `CPU · GPU ready`.

## Reference

Behavior is ported from [`doc/topology_optimization_studio_3d (2).html`](doc/topology_optimization_studio_3d%20(2).html).
