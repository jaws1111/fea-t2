import { createEmptyScene, createFixation, createForce, createLoadedHole } from './types.js';
import { linkFeatures } from './links.js';

/*
 * Example custom scenes. Coordinates are normalized (0..1) over the design domain and
 * radii are a fraction of max(nx, ny, nz). Each example lists the grid it was tuned for
 * (`resolution`) — loading it switches the grid so sizes and spans are what you see here.
 *
 * Modelling rules these presets follow (the solver enforces them):
 *  - A `bolt_hole` is ONE object: bore + locked boss + (optional) constraint + (optional)
 *    load. A clamped hole is fixed on all axes; a loaded hole leaves every axis its load
 *    acts along FREE (otherwise the support swallows the load — the editor warns).
 *  - Hole loads: 'directional' (one vector), 'multi' (several), 'circular' (torque or
 *    radial press-fit). Net force is carried into the part through the bore wall facing
 *    the load.
 *  - A hole has a user-defined `len` (fraction of the axis, centred on the hole), so a
 *    bolt through a flange does not become a rod through the whole domain, and the
 *    auto working volume is the union of the parts' real extents.
 *  - Pressure cavities are void with a locked wall (default 2 cells). A self-balancing
 *    (radial) pressure needs a net force somewhere to make the supports work — the gas
 *    cylinder adds the lid thrust for exactly this reason.
 *  - Rigid links keep hole spacing (drag one, the group follows).
 */

const PLATE = '36x15x8';

/**
 * Simple two-bolt bracket — the canonical custom-scene smoke test.
 *   Left hole : clamped (all axes) — the anchor bolt
 *   Right hole: free, directional load straight down (a hanging pin)
 * A rigid link holds them at a fixed spacing; material grows a strut between them.
 */
export function createTwoBoltBracketScene() {
  const scene = createEmptyScene();
  const r = 0.05;
  const left = createFixation({ type: 'bolt_hole', x: 0.16, y: 0.5, z: 0.5, axis: 'z', len: 1, radius: r });
  const right = createLoadedHole({
    x: 0.84,
    y: 0.5,
    z: 0.5,
    axis: 'z', len: 1,
    radius: r,
    loadMode: 'directional',
    fx: 0,
    fy: -1,
    fz: 0,
    magnitude: 1,
  });
  scene.fixations.push(left, right);
  linkFeatures(scene, left.id, right.id, { nx: 36, ny: 15, nz: 8 });
  return scene;
}

/** Wall-mounted cantilever with a loaded pin at the tip (load sideways AND down — 'multi'). */
export function createBoltBracketScene() {
  const scene = createEmptyScene();
  scene.fixations.push(
    createFixation({ type: 'wall_pad', face: 'x-', x: 0, y: 0.5, z: 0.5, width: 1, height: 1, depth: 2 }),
    createLoadedHole({
      x: 0.86,
      y: 0.5,
      z: 0.5,
      axis: 'z', len: 1,
      radius: 0.05,
      loadMode: 'multi',
      loads: [
        { fx: 0, fy: -1, fz: 0, magnitude: 1 },
        { fx: 1, fy: 0, fz: 0, magnitude: 0.25 },
      ],
    }),
  );
  return scene;
}

/**
 * Pressure deck: a pressurised channel pushes DOWN on its floor and is carried to two
 * foot supports. Directional pressure = net force, so the supports really work.
 */
export function createPressureBridgeScene() {
  const scene = createEmptyScene();
  scene.fixations.push(
    createFixation({ type: 'rest_point', x: 0.06, y: 0, z: 0.5, radius: 0.05 }),
    createFixation({ type: 'rest_point', x: 0.94, y: 0, z: 0.5, radius: 0.05 }),
  );
  scene.forces.push(
    createForce({
      type: 'pressure',
      shape: 'box',
      x: 0.5,
      y: 0.62,
      z: 0.5,
      hx: 0.22,
      hy: 0.08,
      hz: 0.22,
      pressureMode: 'directional',
      fx: 0,
      fy: -1,
      fz: 0,
      magnitude: 1,
      wall: 2,
    }),
  );
  return scene;
}

/**
 * Gas cylinder / pressure vessel (cubic grid so the bolt circle is round).
 *
 *  - Six flange bolts on a circle at the base: short holes (span = flange thickness),
 *    clamped to the base plate.
 *  - Spherical gas cavity above: permanent void inside a locked 2-cell wall, with
 *      · RADIAL outward gas pressure (hoop load in the shell), and
 *      · LID THRUST: the net upward force on the closed end, directional on the top.
 *    The thrust is what the bolts resist; the two pressure objects are rigidly linked.
 *  - Auto working volume covers the whole flange ring AND cavity + wall (it does now).
 */
export function createGasCylinderScene() {
  const scene = createEmptyScene();
  const cx = 0.5;
  const cz = 0.5;
  const ringR = 0.36;
  const bolts = 6;
  for (let i = 0; i < bolts; i++) {
    const a = (i / bolts) * Math.PI * 2;
    scene.fixations.push(
      createFixation({
        type: 'bolt_hole',
        x: cx + ringR * Math.cos(a),
        y: 0.1,
        z: cz + ringR * Math.sin(a),
        axis: 'y',
        s0: 0,
        s1: 0.2,
        radius: 0.03,
      }),
    );
  }
  const gas = createForce({
    type: 'pressure',
    shape: 'sphere',
    x: cx,
    y: 0.56,
    z: cz,
    radius: 0.14,
    pressureMode: 'radial',
    magnitude: 1,
    wall: 2,
  });
  const lid = createForce({
    type: 'pressure',
    shape: 'sphere',
    x: cx,
    y: 0.56,
    z: cz,
    radius: 0.14,
    pressureMode: 'directional',
    fx: 0,
    fy: 1,
    fz: 0,
    magnitude: 0.8,
    wall: 2,
  });
  scene.forces.push(gas, lid);
  linkFeatures(scene, gas.id, lid.id, { nx: 32, ny: 32, nz: 32 });
  return scene;
}

/**
 * L-bracket (shelf bracket): vertical leg bolted to a wall, load on the free tip.
 *  - Wall pad on x- (contact face) + two clamped bolts through the leg (axis X, short span),
 *    rigidly linked so their spacing is preserved.
 *  - Tip pin hole (axis Z) with a directional downward load — free on all axes.
 */
export function createLBracketScene() {
  const scene = createEmptyScene();
  scene.fixations.push(
    createFixation({ type: 'wall_pad', face: 'x-', x: 0, y: 0.5, z: 0.5, width: 0.9, height: 1, depth: 2 }),
  );
  const b1 = createFixation({
    type: 'bolt_hole', x: 0.12, y: 0.3, z: 0.5, axis: 'x', s0: 0, s1: 0.25, radius: 0.03,
  });
  const b2 = createFixation({
    type: 'bolt_hole', x: 0.12, y: 0.75, z: 0.5, axis: 'x', s0: 0, s1: 0.25, radius: 0.03,
  });
  const tip = createLoadedHole({
    x: 0.9,
    y: 0.82,
    z: 0.5,
    axis: 'z', len: 1,
    radius: 0.045,
    loadMode: 'directional',
    fx: 0,
    fy: -1,
    fz: 0,
    magnitude: 1,
  });
  scene.fixations.push(b1, b2, tip);
  linkFeatures(scene, b1.id, b2.id, { nx: 36, ny: 15, nz: 8 });
  return scene;
}

/**
 * Engine mount: cantilever plate from the wall; two engine bolts (rigidly linked, fixed
 * spacing). Each carries 'multi' loads: half the engine weight (down) + a share of
 * thrust (forward).
 */
export function createEngineMountScene() {
  const scene = createEmptyScene();
  scene.fixations.push(
    createFixation({ type: 'wall_pad', face: 'x-', x: 0, y: 0.5, z: 0.5, width: 1, height: 1, depth: 2 }),
  );
  const mk = (y) =>
    createLoadedHole({
      x: 0.82,
      y,
      z: 0.5,
      axis: 'z', len: 1,
      radius: 0.045,
      loadMode: 'multi',
      loads: [
        { fx: 0, fy: -1, fz: 0, magnitude: 0.5 },
        { fx: 1, fy: 0, fz: 0, magnitude: 0.2 },
      ],
    });
  const a = mk(0.26);
  const b = mk(0.74);
  scene.fixations.push(a, b);
  linkFeatures(scene, a.id, b.id, { nx: 36, ny: 15, nz: 8 });
  return scene;
}

/**
 * Torque arm / bearing plate: a shaft hole in the middle takes a CIRCULAR torque load
 * (self-balanced tangential bearing on the bore), reacted by two clamped anchor bolts.
 * Torque magnitude is signed (negative = reverse).
 */
export function createTorqueArmScene() {
  const scene = createEmptyScene();
  const shaft = createLoadedHole({
    x: 0.5,
    y: 0.5,
    z: 0.5,
    axis: 'z', len: 1,
    radius: 0.07,
    loadMode: 'circular',
    circMode: 'torque',
    magnitude: 1,
  });
  const l = createFixation({ type: 'bolt_hole', x: 0.1, y: 0.5, z: 0.5, axis: 'z', len: 1, radius: 0.04 });
  const r = createFixation({ type: 'bolt_hole', x: 0.9, y: 0.5, z: 0.5, axis: 'z', len: 1, radius: 0.04 });
  scene.fixations.push(shaft, l, r);
  linkFeatures(scene, l.id, r.id, { nx: 36, ny: 15, nz: 8 });
  return scene;
}

/**
 * Ready-made scenes shown in the Custom Scene tab.
 * `volfrac` = recommended volume fraction, `resolution` = grid the example was tuned for.
 * @type {{ id: string, title: string, blurb: string, icon?: string, volfrac?: number, resolution?: string, build: () => import('./types.js').Scene }[]}
 */
export const SCENE_EXAMPLES = [
  {
    id: 'two_bolt_bracket',
    title: '2-bolt bracket',
    blurb: 'Clamped left bolt + right bolt with a downward load; rigid link keeps the spacing.',
    icon: 'ph-link',
    volfrac: 0.3,
    resolution: PLATE,
    build: createTwoBoltBracketScene,
  },
  {
    id: 'l_bracket',
    title: 'L-bracket',
    blurb: 'Wall pad + two linked wall bolts (axis X), downward load on the tip pin.',
    icon: 'ph-wrench',
    volfrac: 0.28,
    resolution: PLATE,
    build: createLBracketScene,
  },
  {
    id: 'engine_mount',
    title: 'Engine mount',
    blurb: 'Two linked engine bolts, each with weight + thrust vectors (multi-vector load).',
    icon: 'ph-engine',
    volfrac: 0.3,
    resolution: PLATE,
    build: createEngineMountScene,
  },
  {
    id: 'torque_arm',
    title: 'Torque arm',
    blurb: 'Shaft hole with a circular torque load, reacted by two clamped anchor bolts.',
    icon: 'ph-gear',
    volfrac: 0.3,
    resolution: PLATE,
    build: createTorqueArmScene,
  },
  {
    id: 'gas_cylinder',
    title: 'Gas cylinder',
    blurb: 'Flange bolt circle, spherical gas cavity with radial pressure + lid thrust.',
    icon: 'ph-gas-can',
    volfrac: 0.2,
    resolution: '32x32x32',
    build: createGasCylinderScene,
  },
  {
    id: 'bolt_bracket',
    title: 'Wall + pin',
    blurb: 'Wall pad cantilever; tip pin loaded down and sideways (two vectors).',
    icon: 'ph-nut',
    volfrac: 0.3,
    resolution: PLATE,
    build: createBoltBracketScene,
  },
  {
    id: 'pressure_bridge',
    title: 'Pressure deck',
    blurb: 'Pressurised channel pushing down on its floor, carried to two foot supports.',
    icon: 'ph-wind',
    volfrac: 0.25,
    resolution: '48x24x16',
    build: createPressureBridgeScene,
  },
];
