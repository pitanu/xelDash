// When a chart's lines draw in again (see motion.js). Kept apart from React so it can be tested on its own.

/**
 * The next replay state: after the range changes, the key moves on once the new range's data arrives (the old data stays
 * on screen, dimmed, until then). Refreshes of the same range keep the key, so a line is not drawn again on every poll.
 * @template T
 * @param {{ range: string, data: T, key: number, waiting: boolean }} state
 * @param {string} range
 * @param {T} data
 */
export function nextReplay(state, range, data) {
  if (range !== state.range) return { range, data, key: state.key, waiting: true };
  if (state.waiting && data !== state.data) return { range, data, key: state.key + 1, waiting: false };
  return state.data === data ? state : { ...state, data };
}
