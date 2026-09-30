import { readFileSync } from "node:fs";

/**
 * The address containers see for connections that Docker forwards from the host: Docker
 * Desktop (Windows, macOS) and connections from the machine itself show the network's gateway
 * instead of the real client. Read from the kernel's routing table; null when it cannot be read
 * (not Linux, or no default route).
 * @param {string} [file]
 */
export function readDefaultGateway(file = "/proc/net/route") {
  try {
    for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
      const [, destination, gateway] = line.trim().split(/\s+/);
      if (destination === "00000000" && gateway && gateway !== "00000000") {
        // The kernel prints the address as little-endian hex: 0116A8C0 is 192.168.22.1.
        const bytes = gateway.match(/../g) ?? [];
        return bytes.reverse().map((b) => Number.parseInt(b, 16)).join(".");
      }
    }
  } catch {
    // Not on Linux, or no route file.
  }
  return null;
}
