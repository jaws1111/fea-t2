/**
 * Fixed-capacity circular buffer of numbers (oldest → newest ordering on read).
 */
export class RingBuffer {
  /** @param {number} capacity */
  constructor(capacity) {
    if (!(capacity > 0)) throw new Error('RingBuffer capacity must be > 0');
    this.capacity = capacity | 0;
    this._buf = new Float64Array(this.capacity);
    this._head = 0; // next write index
    this._size = 0;
  }

  get length() {
    return this._size;
  }

  /** @param {number} value */
  push(value) {
    this._buf[this._head] = value;
    this._head = (this._head + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;
  }

  /** i = 0 is the oldest retained value. */
  get(i) {
    if (i < 0 || i >= this._size) return undefined;
    const start = (this._head - this._size + this.capacity) % this.capacity;
    return this._buf[(start + i) % this.capacity];
  }

  /** Most recent value, or undefined when empty. */
  last() {
    return this._size ? this._buf[(this._head - 1 + this.capacity) % this.capacity] : undefined;
  }

  /**
   * Copy contents oldest → newest.
   * @param {ArrayLike<number> & { length: number }} [out] optional destination (length ≥ size)
   * @returns {number[] | Float64Array}
   */
  toArray(out) {
    const n = this._size;
    const dst = out ?? new Array(n);
    const start = (this._head - n + this.capacity) % this.capacity;
    for (let i = 0; i < n; i++) dst[i] = this._buf[(start + i) % this.capacity];
    return dst;
  }

  clear() {
    this._head = 0;
    this._size = 0;
  }
}
