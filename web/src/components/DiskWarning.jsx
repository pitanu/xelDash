import { usePolled } from "../api.js";
import { formatBytes } from "../format.js";

/**
 * A warning when the disk the nodes use is running low, with what to do. Shows nothing while there
 * is plenty of space. The thresholds are set on the server (XELDASH_DISK_WARN_GB).
 */
export default function DiskWarning() {
  const disk = usePolled("/api/v1/node/disk", { intervalMs: 60_000 });
  const low = /** @type {{ nodes: string[], free: number, total: number, level: string }[]} */ (disk.data?.disks ?? [])
    .filter((d) => d.level !== "ok");
  if (low.length === 0) return null;
  const critical = low.some((d) => d.level === "critical");
  return (
    <div role="alert" className={`rounded-lg border p-4 text-sm ${critical ? "border-critical/50 bg-critical/10" : "border-warning/60 bg-warning/10"}`}>
      <div className="font-semibold text-ink">{critical ? "The disk is almost full" : "Disk space is running low"}</div>
      {low.map((d) => (
        <p key={d.nodes.join()} className="mt-1 text-ink-2">
          {formatBytes(d.free)} free of {formatBytes(d.total)} for {d.nodes.join(" and ")}.
        </p>
      ))}
      <p className="mt-1 text-ink-2">
        The chain keeps growing, and a node stops when the disk is full, which can force a long resync.
        Free some space: the <a href="#/nodes" className="underline decoration-line underline-offset-2 hover:text-ink">Nodes</a> page lists
        old chain copies you can delete. Docker Desktop users can also give Docker more disk in its settings.
      </p>
    </div>
  );
}
