/**
 * Rigid links lock the RELATIVE POSITION of two scene features (any kind): the
 * stored offset (dx,dy,dz) = B − A in normalized coordinates. Dragging either
 * end moves the partner (and anything chained to it) by the same amount, so a
 * bolt pattern, an engine's mounting points or a hole + its load point stay a
 * rigid group. Offsets are directly editable, so the spacing can be any
 * direction (diagonal brackets are fine).
 */

/**
 * @typedef {Object} RigidLink
 * @property {string} id
 * @property {'rigid'} type
 * @property {string} aId
 * @property {string} bId
 * @property {number} dx   B.x − A.x
 * @property {number} dy
 * @property {number} dz
 */

let _linkId = 0;
function nextLinkId() {
  _linkId += 1;
  return `link_${_linkId}`;
}

/** @param {Partial<RigidLink>} [partial] @returns {RigidLink} */
export function createRigidLink(partial = {}) {
  return { id: nextLinkId(), type: 'rigid', aId: '', bId: '', dx: 0, dy: 0, dz: 0, ...partial };
}

/** @param {import('./types.js').Scene} scene */
export function ensureLinks(scene) {
  if (!Array.isArray(scene.links)) scene.links = [];
  return scene.links;
}

/**
 * @param {import('./types.js').Scene} scene
 * @param {string} id
 */
/** @param {import('./types.js').Scene} scene @param {string} id */
export function findComponent(scene, id) {
  return scene.components?.find((c) => c.id === id) ?? null;
}

/**
 * Create a link whose offset is the CURRENT separation (snapped to grid nodes).
 * @param {import('./types.js').Scene} scene
 * @param {string} aId
 * @param {string} bId
 * @param {{ nx: number, ny: number, nz: number }} [dims]
 * @returns {RigidLink | null}
 */
export function linkFeatures(scene, aId, bId, dims) {
  if (aId === bId) return null;
  const a = findComponent(scene, aId);
  const b = findComponent(scene, bId);
  if (!a || !b) return null;
  const links = ensureLinks(scene);
  const existing = links.find(
    (l) => (l.aId === aId && l.bId === bId) || (l.aId === bId && l.bId === aId),
  );
  if (existing) return existing;
  const snap = (d, n) => (dims ? Math.round(d * n) / n : d);
  const link = createRigidLink({
    aId,
    bId,
    dx: snap(b.x - a.x, dims?.nx ?? 1),
    dy: snap(b.y - a.y, dims?.ny ?? 1),
    dz: snap(b.z - a.z, dims?.nz ?? 1),
  });
  links.push(link);
  return link;
}

/** Euclidean separation in CELLS. */
export function linkLengthCells(link, dims) {
  return Math.hypot(link.dx * dims.nx, link.dy * dims.ny, link.dz * dims.nz);
}

/** Links touching a feature. */
export function linksOf(scene, id) {
  return ensureLinks(scene).filter((l) => l.aId === id || l.bId === id);
}

/** Ids connected to `id` through rigid links (including `id`). */
export function linkedGroup(scene, id) {
  const links = ensureLinks(scene);
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    for (const l of links) {
      if (l.aId !== cur && l.bId !== cur) continue;
      const other = l.aId === cur ? l.bId : l.aId;
      if (!seen.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return [...seen];
}

/**
 * After feature `movedId` was moved, drag every rigidly-linked feature with it.
 * If the group would leave the [0,1] domain the whole group is shifted back
 * (including the dragged feature), so offsets are never violated by clamping.
 *
 * @param {import('./types.js').Scene} scene
 * @param {string} movedId
 * @returns {string[]} ids of all features in the group (for gizmo refresh)
 */
export function applyLinksAfterMove(scene, movedId) {
  const links = ensureLinks(scene);
  const start = findComponent(scene, movedId);
  if (!start) return [movedId];

  /** @type {Map<string, { x: number, y: number, z: number }>} */
  const pos = new Map([[movedId, { x: start.x, y: start.y, z: start.z }]]);
  const queue = [movedId];
  while (queue.length) {
    const cur = queue.shift();
    const p = pos.get(cur);
    for (const l of links) {
      if (l.type !== 'rigid') continue;
      if (l.aId !== cur && l.bId !== cur) continue;
      const curIsA = l.aId === cur;
      const otherId = curIsA ? l.bId : l.aId;
      if (pos.has(otherId)) continue;
      if (!findComponent(scene, otherId)) continue;
      const s = curIsA ? 1 : -1;
      pos.set(otherId, { x: p.x + s * l.dx, y: p.y + s * l.dy, z: p.z + s * l.dz });
      queue.push(otherId);
    }
  }
  if (pos.size === 1) return [movedId];

  // Shift the group back inside the domain as a rigid body.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const fit = (lo, hi) => (lo < 0 ? -lo : hi > 1 ? 1 - hi : 0);
  const sx = fit(minX, maxX);
  const sy = fit(minY, maxY);
  const sz = fit(minZ, maxZ);

  for (const [id, p] of pos) {
    const f = findComponent(scene, id);
    if (!f) continue;
    f.x = Math.max(0, Math.min(1, p.x + sx));
    f.y = Math.max(0, Math.min(1, p.y + sy));
    f.z = Math.max(0, Math.min(1, p.z + sz));
  }
  return [...pos.keys()];
}

/**
 * Set a link's offset and re-place B relative to A (A stays put).
 * @param {import('./types.js').Scene} scene
 * @param {RigidLink} link
 * @param {Partial<{dx:number,dy:number,dz:number}>} off
 */
export function setLinkOffset(scene, link, off) {
  if (Number.isFinite(off.dx)) link.dx = off.dx;
  if (Number.isFinite(off.dy)) link.dy = off.dy;
  if (Number.isFinite(off.dz)) link.dz = off.dz;
  return applyLinksAfterMove(scene, link.aId);
}

/**
 * Rescale the separation to `cells` keeping its direction (A stays put).
 * @param {{ nx: number, ny: number, nz: number }} dims
 */
export function setLinkLengthCells(scene, link, cells, dims) {
  const cur = linkLengthCells(link, dims);
  if (cur < 1e-9 || !Number.isFinite(cells) || cells <= 0) return [];
  const k = cells / cur;
  return setLinkOffset(scene, link, { dx: link.dx * k, dy: link.dy * k, dz: link.dz * k });
}

/**
 * Drop links involving a deleted feature and any dangling links.
 * @param {import('./types.js').Scene} scene
 * @param {string} [deletedId]
 */
export function pruneLinks(scene, deletedId) {
  const links = ensureLinks(scene);
  scene.links = links.filter((l) => {
    if (deletedId && (l.aId === deletedId || l.bId === deletedId)) return false;
    return !!(findComponent(scene, l.aId) && findComponent(scene, l.bId));
  });
}
