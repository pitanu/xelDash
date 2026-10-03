import { usePolled } from "../api.js";
import { Card } from "./ui.jsx";

/** On a main server with a front door set up: how many rigs arrive through it, and how many connect straight here. Nothing otherwise. */
export default function FrontDoorCard() {
  const door = usePolled("/api/v1/front-door", { intervalMs: 10_000 });
  const d = door.data;
  if (!d?.configured) return null;
  const rigs = d.viaFrontDoor + d.direct;
  return (
    <Card title="Front door" subtitle="A Linux box your miners connect to. It sends them here while this server can mine, and to its own Stratum when it cannot.">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-lg font-semibold text-ink">{d.viaFrontDoor} {d.viaFrontDoor === 1 ? "rig" : "rigs"} through the front door</span>
        <span className="text-xs text-muted">accepted from {d.from}</span>
      </div>
      {rigs === 0 && (
        <p className="mt-2 text-sm text-ink-2">No rigs are connected here right now. If your rigs are mining, they are on the front door's own server, which happens while this one cannot mine.</p>
      )}
      {d.direct > 0 && (
        <p className="mt-2 text-sm text-critical">{d.direct} {d.direct === 1 ? "rig is" : "rigs are"} connected straight to this server. Point {d.direct === 1 ? "it" : "them"} at the front door, or {d.direct === 1 ? "it has" : "they have"} no standby when this server stops.</p>
      )}
    </Card>
  );
}
