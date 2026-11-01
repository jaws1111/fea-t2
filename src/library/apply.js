import { fitDimsForBudget } from '../scene/domainFit.js';
import { normalizeScene } from '../scene/types.js';
import { ensureWorkingVolume } from '../scene/workingVolume.js';

/**
 * Clone a recipe scene onto a grid.
 * `meta.domain.budget` wins when the recipe was tuned for one grid (scene examples).
 * Classic problems omit it and use the Voxel Domain budget.
 *
 * @param {import('./store.js').Recipe} recipe
 * @param {number} currentBudget
 * @returns {{ scene: import('../scene/types.js').Scene, dims: { nx: number, ny: number, nz: number }, volfrac?: number, rmin?: number }}
 */
export function resolveRecipe(recipe, currentBudget) {
  if (!recipe?.scene) throw new Error('Recipe has no scene.');
  const scene = normalizeScene(JSON.parse(JSON.stringify(recipe.scene)));
  const domain = recipe.meta?.domain ?? { x: 1, y: 1, z: 1 };
  const budget = Number.isFinite(domain.budget) ? domain.budget : currentBudget;
  const dims = fitDimsForBudget(
    {
      x: Number.isFinite(domain.x) ? domain.x : 1,
      y: Number.isFinite(domain.y) ? domain.y : 1,
      z: Number.isFinite(domain.z) ? domain.z : 1,
    },
    Number.isFinite(budget) && budget > 0 ? budget : 4320,
  );
  ensureWorkingVolume(scene, dims);
  /** @type {{ scene: import('../scene/types.js').Scene, dims: { nx: number, ny: number, nz: number }, volfrac?: number, rmin?: number }} */
  const out = { scene, dims };
  if (Number.isFinite(recipe.meta?.volfrac)) out.volfrac = recipe.meta.volfrac;
  if (Number.isFinite(recipe.meta?.rmin)) out.rmin = recipe.meta.rmin;
  return out;
}
