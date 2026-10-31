/** Worker ↔ main thread message types (inline worker parity). */
export const INIT = 'INIT';
export const RESET = 'RESET';
export const STEP = 'STEP';
/** Autonomous run: worker keeps iterating until PAUSE (no per-iteration round trip). */
export const RUN = 'RUN';
export const PAUSE = 'PAUSE';
/** Main → worker: a mid-run STATE_UPDATE has been consumed (back-pressure). */
export const ACK = 'ACK';
export const UPDATE_PARAMS = 'UPDATE_PARAMS';
export const STATE_UPDATE = 'STATE_UPDATE';

/** @type {readonly string[]} */
export const WORKER_MESSAGE_TYPES = Object.freeze([
  INIT,
  RESET,
  STEP,
  RUN,
  PAUSE,
  ACK,
  UPDATE_PARAMS,
  STATE_UPDATE,
]);
