// Which files can be a block sound (see block-sound.js). Kept apart from React so the checks can be tested on their own.

/** The largest sound file taken, and the longest sound: a chime, not a song. */
export const MAX_SOUND_BYTES = 1_048_576;
export const MAX_SOUND_SECONDS = 10;

/**
 * Why a file cannot be the block sound, or null. `decode` turns its bytes into audio (the Web Audio API), and fails for anything that
 * is not audio, whatever its name or type says.
 * @param {{ name: string, size: number, type: string, arrayBuffer: () => Promise<ArrayBuffer> }} file
 * @param {(bytes: ArrayBuffer) => Promise<{ duration: number }>} decode
 * @returns {Promise<{ error: string } | { bytes: ArrayBuffer, duration: number }>}
 */
export async function checkSoundFile(file, decode) {
  if (file.size > MAX_SOUND_BYTES) return { error: `That file is ${(file.size / 1_048_576).toFixed(1)} MB; a sound may be at most 1 MB.` };
  if (file.type && !file.type.startsWith("audio/")) return { error: "That is not an audio file. Choose an MP3, WAV, OGG or similar." };
  const bytes = await file.arrayBuffer();
  let audio;
  try {
    // Decoding detaches the buffer it gets, so it gets a copy.
    audio = await decode(bytes.slice(0));
  } catch {
    return { error: "That file could not be played as audio." };
  }
  if (!(audio.duration > 0)) return { error: "That file could not be played as audio." };
  if (audio.duration > MAX_SOUND_SECONDS) {
    return { error: `That sound is ${Math.round(audio.duration)} seconds long; a block sound may be at most ${MAX_SOUND_SECONDS}.` };
  }
  return { bytes, duration: audio.duration };
}
