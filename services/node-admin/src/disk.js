import { readFile, statfs } from "node:fs/promises";

// Free disk space, as the person running xelDash would measure it.
//
// On Linux with Docker Engine a container's volume is on the computer's own disk, so its free space
// is the real number. Docker Desktop (Windows, macOS, and Docker Desktop for Linux) keeps volumes in
// a virtual disk instead: a container sees that disk's size and free space (a terabyte, say), while
// the drive that can actually run out is the computer's own, and it may have far less. A folder from
// the computer's drive is mounted read-only at /hostdisk; its numbers are the drive's, as Windows
// Explorer or Finder show them. The smaller of the two free values is the one that matters.

const HOST_DIR = process.env.XELDASH_HOST_DISK_DIR ?? "/hostdisk";

/** Whether this container runs in Docker Desktop's virtual machine. */
export async function runsInVirtualMachine() {
  try {
    return /microsoft|linuxkit/i.test(await readFile("/proc/sys/kernel/osrelease", "utf8"));
  } catch {
    return false;
  }
}

/** @param {string} path @returns {Promise<{ free: number, total: number } | null>} */
async function space(path) {
  try {
    const s = await statfs(path);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/**
 * @param {string} dataDir A node's data directory.
 * @returns {Promise<{ free: number, total: number, source: "volume" | "computer", virtualized: boolean,
 *   volume: { free: number, total: number }, computer: { free: number, total: number } | null }>}
 */
export async function diskSpace(dataDir) {
  const volume = (await space(dataDir)) ?? { free: 0, total: 0 };
  const virtualized = await runsInVirtualMachine();
  const computer = virtualized ? await space(HOST_DIR) : null;
  if (computer && computer.free < volume.free) return { ...computer, source: "computer", virtualized, volume, computer };
  return { ...volume, source: "volume", virtualized, volume, computer };
}
