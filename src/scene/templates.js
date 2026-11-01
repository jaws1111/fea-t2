import { createEmptyScene, createComponent, createLoadedHole } from './types.js';
import { linkFeatures } from './links.js';

/*
 * Example custom scenes. Coordinates are normalized (0..1) over the design domain and
 * radii are a fraction of max(nx, ny, nz). Each example lists the grid it was tuned for
 * (`resolution`) — loading it switches the grid so sizes and spans are what you see here.
 *
 * Modelling rules these examples follow (the solver enforces them):
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
  const left = createComponent('bolt_hole', { x: 0.16, y: 0.5, z: 0.5, axis: 'z', len: 1, radius: r });
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
  scene.components.push(left, right);
  linkFeatures(scene, left.id, right.id, { nx: 36, ny: 15, nz: 8 });
  return scene;
}

/** Wall-mounted cantilever with a loaded pin at the tip (load sideways AND down — 'multi'). */
export function createBoltBracketScene() {
  const scene = createEmptyScene();
  scene.components.push(
    createComponent('wall_pad', { face: 'x-', x: 0, y: 0.5, z: 0.5, width: 1, height: 1, depth: 2 }),
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
  scene.components.push(
    createComponent('rest_point', { x: 0.06, y: 0, z: 0.5, radius: 0.05 }),
    createComponent('rest_point', { x: 0.94, y: 0, z: 0.5, radius: 0.05 }),
  );
  scene.components.push(
    createComponent('pressure', {
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
    scene.components.push(
      createComponent('bolt_hole', {
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
  const gas = createComponent('pressure', {
    shape: 'sphere',
    x: cx,
    y: 0.56,
    z: cz,
    radius: 0.14,
    pressureMode: 'radial',
    magnitude: 1,
    wall: 2,
  });
  const lid = createComponent('pressure', {
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
  scene.components.push(gas, lid);
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
  scene.components.push(
    createComponent('wall_pad', { face: 'x-', x: 0, y: 0.5, z: 0.5, width: 0.9, height: 1, depth: 2 }),
  );
  const b1 = createComponent('bolt_hole', { x: 0.12, y: 0.3, z: 0.5, axis: 'x', s0: 0, s1: 0.25, radius: 0.03,
  });
  const b2 = createComponent('bolt_hole', { x: 0.12, y: 0.75, z: 0.5, axis: 'x', s0: 0, s1: 0.25, radius: 0.03,
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
  scene.components.push(b1, b2, tip);
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
  scene.components.push(
    createComponent('wall_pad', { face: 'x-', x: 0, y: 0.5, z: 0.5, width: 1, height: 1, depth: 2 }),
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
  scene.components.push(a, b);
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
  const l = createComponent('bolt_hole', { x: 0.1, y: 0.5, z: 0.5, axis: 'z', len: 1, radius: 0.04 });
  const r = createComponent('bolt_hole', { x: 0.9, y: 0.5, z: 0.5, axis: 'z', len: 1, radius: 0.04 });
  scene.components.push(shaft, l, r);
  linkFeatures(scene, l.id, r.id, { nx: 36, ny: 15, nz: 8 });
  return scene;
}

const CUBE = '24x24x24';

/**
 * Clamped cylindrical sleeve and a free pin that hangs from the far end.
 * The sleeve bore stays open. The pin load is clear of the fixed shell.
 */
export function createSleeveLinkScene() {
  const scene = createEmptyScene();
  scene.components.push(
    createComponent('wall_cylinder', {
      x: 0.28,
      y: 0.5,
      z: 0.5,
      axis: 'z',
      len: 0.45,
      radius: 0.1,
      wall: 2,
      active: 'inner',
      solid: true,
    }),
    createLoadedHole({
      x: 0.78,
      y: 0.5,
      z: 0.5,
      axis: 'z',
      len: 0.4,
      radius: 0.045,
      loadMode: 'directional',
      fx: 0,
      fy: -1,
      fz: 0,
      magnitude: 1,
    }),
  );
  return scene;
}

/**
 * Hexagonal mast fixed on its inner faces, with a downward load above the prism.
 */
export function createHexMastScene() {
  const scene = createEmptyScene();
  scene.components.push(
    createComponent('wall_prism', {
      x: 0.5,
      y: 0.38,
      z: 0.5,
      axis: 'y',
      len: 0.5,
      radius: 0.16,
      n: 6,
      wall: 2,
      active: 'inner',
      solid: true,
    }),
    createComponent('point_load', {
      x: 0.5,
      y: 0.92,
      z: 0.5,
      fx: 0,
      fy: -1,
      fz: 0,
      magnitude: 1,
    }),
  );
  return scene;
}

/**
 * Spherical housing fixed on the inner surface, pulled sideways by a lug load.
 */
export function createBallSocketScene() {
  const scene = createEmptyScene();
  scene.components.push(
    createComponent('surround', {
      x: 0.36,
      y: 0.5,
      z: 0.5,
      shape: 'sphere',
      radius: 0.14,
      wall: 2,
      active: 'inner',
      solid: true,
    }),
    createComponent('point_load', {
      x: 0.84,
      y: 0.5,
      z: 0.5,
      fx: 1,
      fy: 0,
      fz: 0,
      magnitude: 1,
    }),
  );
  return scene;
}

/**
 * A ring foot carries a load on the axis, above the ring.
 */
export function createRingPedestalScene() {
  const scene = createEmptyScene();
  scene.components.push(
    createComponent('rest_ring', {
      x: 0.5,
      y: 0.14,
      z: 0.5,
      axis: 'y',
      radius: 0.22,
      solid: true,
    }),
    createComponent('point_load', {
      x: 0.5,
      y: 0.8,
      z: 0.5,
      fx: 0,
      fy: -1,
      fz: 0,
      magnitude: 1,
    }),
  );
  return scene;
}

/**
 * Two rest pads under a deck, with a downward patch load between them.
 */
export function createPadTableScene() {
  const scene = createEmptyScene();
  scene.components.push(
    createComponent('rest_pad', {
      x: 0.18,
      y: 0.08,
      z: 0.5,
      axis: 'y',
      width: 0.22,
      height: 0.55,
      depth: 2,
    }),
    createComponent('rest_pad', {
      x: 0.82,
      y: 0.08,
      z: 0.5,
      axis: 'y',
      width: 0.22,
      height: 0.55,
      depth: 2,
    }),
    createComponent('face_load', {
      x: 0.5,
      y: 1,
      z: 0.5,
      face: 'y+',
      width: 0.4,
      height: 0.5,
      fx: 0,
      fy: -1,
      fz: 0,
      magnitude: 1,
    }),
  );
  return scene;
}

/**
 * A wall carries the part. A solid block stays in the design as a kept insert.
 * The tip load sits clear of the wall.
 */
export function createInsertBlockScene() {
  const scene = createEmptyScene();
  scene.components.push(
    createComponent('wall_pad', {
      face: 'x-',
      x: 0,
      y: 0.5,
      z: 0.5,
      width: 1,
      height: 1,
      depth: 2,
    }),
    createComponent('block', {
      x: 0.4,
      y: 0.5,
      z: 0.5,
      hx: 0.08,
      hy: 0.16,
      hz: 0.22,
      void: false,
    }),
    createComponent('point_load', {
      x: 0.9,
      y: 0.55,
      z: 0.5,
      fx: 0,
      fy: -1,
      fz: 0,
      magnitude: 1,
    }),
  );
  return scene;
}

/**
 * Clamped wall at one end, a floor roller (vertical DOF only) at the other,
 * and a line load on the top.
 */
export function createRollerBeamScene() {
  const scene = createEmptyScene();
  scene.components.push(
    createComponent('wall_pad', {
      face: 'x-',
      x: 0,
      y: 0.5,
      z: 0.5,
      width: 1,
      height: 1,
      depth: 2,
    }),
    createComponent('wall_pad', {
      id: 'roller',
      face: 'y-',
      x: 0.82,
      y: 0,
      z: 0.5,
      width: 0.28,
      height: 0.7,
      depth: 1,
      fixX: false,
      fixY: true,
      fixZ: false,
      solid: false,
    }),
    createComponent('line_load', {
      x: 0.55,
      y: 1,
      z: 0.5,
      axis: 'z',
      len: 0.55,
      fx: 0,
      fy: -1,
      fz: 0,
      magnitude: 1,
    }),
  );
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
  {
    id: 'sleeve_link',
    title: 'Sleeve link',
    blurb: 'Clamped cylinder bore and a hanging pin clear of the shell.',
    icon: 'ph-cylinder',
    volfrac: 0.28,
    resolution: CUBE,
    build: createSleeveLinkScene,
  },
  {
    id: 'hex_mast',
    title: 'Hex mast',
    blurb: 'Hexagonal tube fixed on the inner faces, load above the prism.',
    icon: 'ph-hexagon',
    volfrac: 0.25,
    resolution: CUBE,
    build: createHexMastScene,
  },
  {
    id: 'ball_socket',
    title: 'Ball socket',
    blurb: 'Spherical housing fixed inside, pulled sideways by a lug.',
    icon: 'ph-sphere',
    volfrac: 0.22,
    resolution: CUBE,
    build: createBallSocketScene,
  },
  {
    id: 'ring_pedestal',
    title: 'Ring pedestal',
    blurb: 'Ring foot on the base, downward load on the axis above it.',
    icon: 'ph-circle',
    volfrac: 0.25,
    resolution: CUBE,
    build: createRingPedestalScene,
  },
  {
    id: 'pad_table',
    title: 'Pad table',
    blurb: 'Two rest pads under a deck patch load.',
    icon: 'ph-square-half',
    volfrac: 0.28,
    resolution: PLATE,
    build: createPadTableScene,
  },
  {
    id: 'insert_block',
    title: 'Insert block',
    blurb: 'Wall mount with a kept solid block and a tip load.',
    icon: 'ph-cube',
    volfrac: 0.3,
    resolution: PLATE,
    build: createInsertBlockScene,
  },
  {
    id: 'roller_beam',
    title: 'Roller beam',
    blurb: 'Clamped wall, floor roller (vertical only), line load on top.',
    icon: 'ph-arrows-horizontal',
    volfrac: 0.3,
    resolution: PLATE,
    build: createRollerBeamScene,
  },
];
