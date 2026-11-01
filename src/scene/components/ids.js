let _idCounter = 0;

export function nextId(prefix) {
  _idCounter += 1;
  return `${prefix}_${_idCounter}`;
}

/** Bump the counter past every numeric suffix already stored on a component. */
export function reserveIds(components) {
  for (const c of components ?? []) {
    const m = /_(\d+)$/.exec(String(c?.id ?? ''));
    if (m) _idCounter = Math.max(_idCounter, Number(m[1]));
  }
}
