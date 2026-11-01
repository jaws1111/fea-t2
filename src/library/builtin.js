import { SCENE_EXAMPLES } from '../scene/templates.js';
import { createComponent, normalizeScene } from '../scene/types.js';

/**
 * One cell in from a side face is not a normalized coordinate. This inset lands
 * on node 1 for the 640 and 4,320 Michell grids, and one node farther in at 24,576.
 */
export const MICHELL_EDGE_INSET = 0.03;

function fullVolume() {
  return {
    shape: 'box',
    mode: 'full',
    padding: 0.06,
    bounds: { x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 1 },
  };
}

function pier(id, x) {
  return createComponent('rest_line', {
    id,
    x,
    y: 0,
    z: 0.5,
    axis: 'z',
    len: 1,
    solid: false,
  });
}

function line(id, x, y, magnitude) {
  return createComponent('line_load', {
    id,
    x,
    y,
    z: 0.5,
    axis: 'z',
    len: 1,
    fx: 0,
    fy: -1,
    fz: 0,
    magnitude,
  });
}

/**
 * @param {string} id
 * @param {string} name
 * @param {string} blurb
 * @param {{ x: number, y: number, z: number }} domain
 * @param {object[]} components
 */
function classic(id, name, blurb, domain, components) {
  return {
    id: `builtin:${id}`,
    name,
    source: 'builtin',
    scene: normalizeScene({
      version: 3,
      components,
      links: [],
      workingVolume: fullVolume(),
    }),
    meta: { blurb, group: 'classic', domain },
  };
}

const CLASSIC = [
  classic(
    'bridge',
    'Bridge Arch',
    'Pinned at both bottom corners, one line load at mid-span on top.',
    { x: 2.4, y: 1, z: 8 / 15 },
    [pier('bridge-left', 0), pier('bridge-right', 1), line('bridge-load', 0.5, 1, 1)],
  ),
  classic(
    'deck',
    'Deck Bridge',
    'Pinned at both ends, road load spread over the top face. The face includes the two edge columns the old preset left unloaded.',
    { x: 4, y: 1, z: 2 / 3 },
    [
      pier('deck-left', 0),
      pier('deck-right', 1),
      createComponent('face_load', {
        id: 'deck-road',
        x: 0.5,
        y: 1,
        z: 0.5,
        face: 'y+',
        width: 1,
        height: 1,
        fx: 0,
        fy: -1,
        fz: 0,
        magnitude: 1,
      }),
    ],
  ),
  classic(
    'cantilever',
    'Cantilever',
    'Clamped wall at x = 0, tip load at mid-height.',
    { x: 2, y: 1, z: 0.5 },
    [
      createComponent('wall_pad', {
        id: 'cantilever-wall',
        x: 0,
        y: 0.5,
        z: 0.5,
        face: 'x-',
        width: 1,
        height: 1,
        depth: 1,
        solid: false,
      }),
      line('cantilever-tip', 1, 0.5, 1),
    ],
  ),
  classic(
    'mbb',
    'MBB Beam',
    'Symmetry plane at x = 0, roller at the far bottom corner, half load on the top of the plane.',
    { x: 3, y: 1, z: 0.5 },
    [
      createComponent('wall_pad', {
        id: 'mbb-sym',
        x: 0,
        y: 0.5,
        z: 0.5,
        face: 'x-',
        width: 1,
        height: 1,
        depth: 1,
        fixX: true,
        fixY: false,
        fixZ: false,
        solid: false,
      }),
      createComponent('rest_line', {
        id: 'mbb-roller',
        x: 1,
        y: 0,
        z: 0.5,
        axis: 'z',
        len: 1,
        fixX: false,
        fixY: true,
        fixZ: true,
        solid: false,
      }),
      line('mbb-load', 0, 1, 0.5),
    ],
  ),
  classic(
    'michell',
    'Michell Wheel',
    'Rigid hub at the centre, two bottom loads one cell in from the sides. The inset is a normalized guess, so the loaded column can be one node off.',
    { x: 2, y: 1, z: 0.4 },
    [
      createComponent('rest_line', {
        id: 'michell-hub',
        x: 0.5,
        y: 0.5,
        z: 0.5,
        axis: 'z',
        len: 1,
        solid: false,
      }),
      line('michell-left', MICHELL_EDGE_INSET, 0, 0.5),
      line('michell-right', 1 - MICHELL_EDGE_INSET, 0, 0.5),
    ],
  ),
];

function exampleRecipes() {
  return SCENE_EXAMPLES.map((ex) => {
    const [nx, ny, nz] = String(ex.resolution || '36x15x8').split('x').map(Number);
    return {
      id: `builtin:${ex.id}`,
      name: ex.title,
      source: 'builtin',
      scene: normalizeScene(ex.build()),
      meta: {
        blurb: ex.blurb,
        icon: ex.icon,
        group: 'example',
        domain: { x: nx, y: ny, z: nz, budget: nx * ny * nz },
        volfrac: ex.volfrac,
      },
    };
  });
}

/** Built-in recipes. Classic problems first, then the scene examples. */
export const BUILTIN_RECIPES = Object.freeze([...CLASSIC, ...exampleRecipes()]);
