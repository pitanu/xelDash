// A block sound of the person's own: only a real, short audio file is taken, whatever its name or type claims.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SOUND_BYTES, checkSoundFile } from "../src/block-sound.js";

/** A stand-in for a chosen file. @param {Partial<{ name: string, size: number, type: string }>} over */
const file = (over = {}) => ({ name: "ding.mp3", size: 20_000, type: "audio/mpeg", arrayBuffer: async () => new ArrayBuffer(8), ...over });
const decodesTo = (/** @type {number} */ duration) => async () => ({ duration });
const notAudio = async () => { throw new Error("EncodingError"); };

test("a short audio file is taken", async () => {
  const checked = await checkSoundFile(file(), decodesTo(1.2));
  assert.ok("bytes" in checked);
  assert.equal(checked.duration, 1.2);
});

test("too large, not audio, not playable, or too long: refused, saying why", async () => {
  assert.match((/** @type {any} */ (await checkSoundFile(file({ size: MAX_SOUND_BYTES + 1 }), decodesTo(1)))).error, /at most 1 MB/);
  assert.match((/** @type {any} */ (await checkSoundFile(file({ type: "image/svg+xml", name: "x.svg" }), decodesTo(1)))).error, /not an audio file/);
  assert.match((/** @type {any} */ (await checkSoundFile(file({ type: "", name: "renamed.mp3" }), notAudio))).error, /could not be played/,
    "a file named like audio that is not is refused when it will not decode");
  assert.match((/** @type {any} */ (await checkSoundFile(file(), decodesTo(0)))).error, /could not be played/);
  assert.match((/** @type {any} */ (await checkSoundFile(file(), decodesTo(42)))).error, /42 seconds long/);
});
