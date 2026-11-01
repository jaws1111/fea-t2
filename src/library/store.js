import { normalizeScene } from '../scene/types.js';
import { BUILTIN_RECIPES } from './builtin.js';

const STORAGE_KEY = 'topoopt.library.v1';

/**
 * @typedef {'builtin'|'user'} RecipeSource
 * @typedef {`builtin:${string}` | `user:${string}`} RecipeId
 *
 * @typedef {Object} RecipeMeta
 * @property {string} [blurb]
 * @property {string} [icon]
 * @property {'classic'|'example'|'user'} [group]
 * @property {{ x: number, y: number, z: number, budget?: number }} [domain]
 * @property {number} [volfrac]
 * @property {number} [rmin]
 * @property {number} [createdAt]
 * @property {number} [updatedAt]
 *
 * @typedef {Object} Recipe
 * @property {RecipeId | string} id
 * @property {string} name
 * @property {RecipeSource} source
 * @property {import('../scene/types.js').Scene} scene
 * @property {RecipeMeta} meta
 */

let userSeq = 0;

const memoryBucket = {
  /** @type {Map<string, string>} */
  data: new Map(),
  /** @param {string} key */
  getItem(key) {
    return this.data.has(key) ? this.data.get(key) : null;
  },
  /** @param {string} key @param {string} value */
  setItem(key, value) {
    this.data.set(key, String(value));
  },
  /** @param {string} key */
  removeItem(key) {
    this.data.delete(key);
  },
};

function bucket() {
  const ls = globalThis.localStorage;
  if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') return ls;
  return memoryBucket;
}

function cloneRecipe(recipe) {
  return {
    id: recipe.id,
    name: recipe.name,
    source: recipe.source,
    scene: JSON.parse(JSON.stringify(recipe.scene)),
    meta: JSON.parse(JSON.stringify(recipe.meta ?? {})),
  };
}

function freshUserId() {
  userSeq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `user:${Date.now().toString(36)}-${userSeq.toString(36)}-${rand}`;
}

function readUsers() {
  let doc;
  try {
    doc = JSON.parse(bucket().getItem(STORAGE_KEY) || '');
  } catch {
    return [];
  }
  if (!doc || doc.version !== 1 || !Array.isArray(doc.recipes)) return [];
  /** @type {Recipe[]} */
  const out = [];
  for (const raw of doc.recipes) {
    if (!raw || typeof raw.id !== 'string' || !raw.id.startsWith('user:') || !raw.scene) continue;
    try {
      out.push({
        id: raw.id,
        name: String(raw.name || 'Untitled'),
        source: 'user',
        scene: normalizeScene(JSON.parse(JSON.stringify(raw.scene))),
        meta: { ...(raw.meta && typeof raw.meta === 'object' ? raw.meta : {}), group: 'user' },
      });
    } catch {
      // Drop a stored recipe whose scene no longer normalizes.
    }
  }
  return out;
}

/** @param {Recipe[]} recipes */
function writeUsers(recipes) {
  const doc = {
    version: 1,
    recipes: recipes.map((r) => ({
      id: r.id,
      name: r.name,
      source: 'user',
      scene: r.scene,
      meta: { ...r.meta, group: 'user' },
    })),
  };
  try {
    bucket().setItem(STORAGE_KEY, JSON.stringify(doc));
  } catch (err) {
    const error = new Error('Browser storage is full.');
    error.code = 'QUOTA';
    error.cause = err;
    throw error;
  }
}

/** Builtin recipes first, then user recipes newest first. Each call returns clones. */
export function listRecipes() {
  const users = readUsers().sort((a, b) => (b.meta?.updatedAt ?? 0) - (a.meta?.updatedAt ?? 0));
  return [...BUILTIN_RECIPES, ...users].map(cloneRecipe);
}

/** @param {string} id @returns {Recipe | null} */
export function getRecipe(id) {
  const builtin = BUILTIN_RECIPES.find((r) => r.id === id);
  if (builtin) return cloneRecipe(builtin);
  const user = readUsers().find((r) => r.id === id);
  return user ? cloneRecipe(user) : null;
}

/**
 * Save a user recipe. Passing an existing `user:` id overwrites that recipe.
 * @param {{ id?: string, name?: string, scene: object, meta?: RecipeMeta }} input
 * @returns {Recipe}
 */
export function saveUserRecipe(input) {
  const list = readUsers();
  const now = Date.now();
  const scene = normalizeScene(JSON.parse(JSON.stringify(input?.scene ?? null)));
  const id = typeof input?.id === 'string' && input.id.startsWith('user:') ? input.id : '';
  const prev = id ? list.findIndex((r) => r.id === id) : -1;
  /** @type {Recipe} */
  let recipe;
  if (prev >= 0) {
    recipe = {
      ...list[prev],
      name: input.name || list[prev].name,
      source: 'user',
      scene,
      meta: {
        ...list[prev].meta,
        ...(input.meta ?? {}),
        group: 'user',
        updatedAt: now,
      },
    };
    list[prev] = recipe;
  } else {
    recipe = {
      id: freshUserId(),
      name: input?.name || 'Untitled',
      source: 'user',
      scene,
      meta: {
        ...(input?.meta ?? {}),
        group: 'user',
        createdAt: now,
        updatedAt: now,
      },
    };
    list.push(recipe);
  }
  writeUsers(list);
  return cloneRecipe(recipe);
}

/** @param {string} id */
export function deleteUserRecipe(id) {
  if (typeof id !== 'string' || !id.startsWith('user:')) return false;
  const list = readUsers();
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) return false;
  writeUsers(next);
  return true;
}

/**
 * JSON envelope. With no ids, exports user recipes only.
 * @param {string[]} [ids]
 */
export function exportRecipes(ids) {
  const recipes = ids ? ids.map((id) => getRecipe(id)).filter(Boolean) : readUsers().map(cloneRecipe);
  return JSON.stringify({ format: 'topoopt-library', version: 1, recipes });
}

/**
 * Import an export envelope. Each recipe gets a new user id.
 * @param {string} json
 * @returns {{ added: number, skipped: number, errors: string[] }}
 */
export function importRecipes(json) {
  /** @type {any} */
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return { added: 0, skipped: 0, errors: ['Invalid JSON.'] };
  }
  if (!data || data.format !== 'topoopt-library' || !Array.isArray(data.recipes)) {
    return { added: 0, skipped: 0, errors: ['Not a topoopt library file.'] };
  }
  const errors = [];
  let added = 0;
  let skipped = 0;
  const list = readUsers();
  const now = Date.now();
  for (const raw of data.recipes) {
    if (!raw || typeof raw !== 'object' || !raw.scene || typeof raw.scene !== 'object') {
      skipped++;
      errors.push('Skipped an entry with no scene.');
      continue;
    }
    const before = Array.isArray(raw.scene.components) ? raw.scene.components.length : 0;
    let scene;
    try {
      scene = normalizeScene(JSON.parse(JSON.stringify(raw.scene)));
    } catch (err) {
      skipped++;
      errors.push(err instanceof Error ? err.message : 'Could not read a scene.');
      continue;
    }
    const name = String(raw.name || 'Imported');
    if (before > 0 && scene.components.length === 0) {
      skipped++;
      errors.push(`Skipped "${name}" because every component type is unknown.`);
      continue;
    }
    const dropped = before - scene.components.length;
    if (dropped > 0) errors.push(`Dropped ${dropped} unknown component(s) from "${name}".`);
    const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
    list.push({
      id: freshUserId(),
      name,
      source: 'user',
      scene,
      meta: {
        blurb: meta.blurb,
        icon: meta.icon,
        domain: meta.domain,
        volfrac: meta.volfrac,
        rmin: meta.rmin,
        group: 'user',
        createdAt: now,
        updatedAt: now,
      },
    });
    added++;
  }
  if (added) writeUsers(list);
  return { added, skipped, errors };
}
