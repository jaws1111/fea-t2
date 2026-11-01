// Library store: builtin recipes plus user recipes in storage.
// Run: node scripts/testLibrary.mjs
import { resolveRecipe } from '../src/library/apply.js';
import {
  deleteUserRecipe,
  exportRecipes,
  getRecipe,
  importRecipes,
  listRecipes,
  saveUserRecipe,
} from '../src/library/store.js';
import { createEmptyScene, createComponent } from '../src/scene/types.js';

let failed = 0;
const check = (ok, msg) => {
  if (!ok) {
    failed++;
    console.log(`  X ${msg}`);
  }
};

const mem = {
  data: new Map(),
  fail: false,
  getItem(key) {
    return this.data.has(key) ? this.data.get(key) : null;
  },
  setItem(key, value) {
    if (this.fail) {
      const err = new Error('quota');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.data.set(key, String(value));
  },
  removeItem(key) {
    this.data.delete(key);
  },
};
globalThis.localStorage = mem;

const listed = listRecipes();
const classics = listed.filter((r) => r.meta.group === 'classic').map((r) => r.id);
const examples = listed.filter((r) => r.meta.group === 'example');
check(
  classics.join(',') === 'builtin:bridge,builtin:deck,builtin:cantilever,builtin:mbb,builtin:michell',
  `classic order ${classics.join(',')}`,
);
check(examples.length === 7, `example recipes ${examples.length}`);
check(listed.filter((r) => r.source === 'user').length === 0, 'no user recipes yet');

const bridge = getRecipe('builtin:bridge');
bridge.scene.components[0].x = 0.2;
check(getRecipe('builtin:bridge').scene.components[0].x === 0, 'getRecipe returns a clone');

const bracket = resolveRecipe(getRecipe('builtin:two_bolt_bracket'), 1000);
check(bracket.dims.nx === 36 && bracket.dims.ny === 15 && bracket.dims.nz === 8, `example grid ${bracket.dims.nx}x${bracket.dims.ny}x${bracket.dims.nz}`);
check(bracket.volfrac === 0.3, `example volfrac ${bracket.volfrac}`);

const scene = createEmptyScene();
scene.components.push(createComponent('rest_point', { x: 0.1, y: 0, z: 0.2 }));
const saved = saveUserRecipe({ name: 'Foot', scene, meta: { blurb: 'a foot' } });
check(saved.id.startsWith('user:') && saved.source === 'user', `saved id ${saved.id}`);
check(getRecipe(saved.id)?.name === 'Foot', 'saved recipe round-trips');
const again = saveUserRecipe({ id: saved.id, name: 'Foot 2', scene });
check(again.id === saved.id && getRecipe(saved.id).name === 'Foot 2', 'same user id overwrites');
check(listRecipes().filter((r) => r.source === 'user').length === 1, 'overwrite did not insert a second copy');

const envelope = exportRecipes([saved.id]);
const first = importRecipes(envelope);
const second = importRecipes(envelope);
check(first.added === 1 && first.skipped === 0, `import added ${first.added} skipped ${first.skipped}`);
check(second.added === 1, 'importing the same file again adds another copy');
const users = listRecipes().filter((r) => r.source === 'user');
check(new Set(users.map((r) => r.id)).size === users.length, 'imported copies have distinct ids');

const bad = importRecipes(JSON.stringify({
  format: 'topoopt-library',
  version: 1,
  recipes: [{ name: 'Nope', scene: { version: 3, components: [{ id: 'x_1', type: 'not_a_type', x: 0, y: 0, z: 0 }], links: [] } }],
}));
check(bad.added === 0 && bad.skipped === 1 && bad.errors.length === 1, `unknown type skipped (${bad.errors.join('; ')})`);
check(importRecipes('{').errors[0] === 'Invalid JSON.', 'bad JSON is an error, not a throw');

check(deleteUserRecipe('builtin:bridge') === false, 'builtin recipes are not deleted');
check(deleteUserRecipe(saved.id) === true, 'user recipe deletes');
check(getRecipe(saved.id) == null, 'deleted recipe is gone');

mem.fail = true;
let quota = false;
try {
  saveUserRecipe({ name: 'Too big', scene });
} catch (err) {
  quota = err.code === 'QUOTA';
}
check(quota, 'a full browser store throws QUOTA and keeps the previous recipes');
mem.fail = false;
check(listRecipes().some((r) => r.id === saved.id) === false, 'failed save did not resurrect the deleted recipe');

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('All checks passed.');
