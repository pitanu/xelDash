import { setAnimations, useAnimations } from "../motion.js";
import { Card } from "./ui.jsx";

/** Per-browser choice of chart animations. A system setting for less motion turns them off whatever is chosen here. */
export default function MotionSetting() {
  const on = useAnimations();
  return (
    <Card title="Animations"
      subtitle="Charts draw in when they load or change range, and the numbers count up. They run once, in your browser, and are skipped when your system asks for less motion. Saved in this browser only.">
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={on} onChange={(e) => setAnimations(e.target.checked)} />
        Animate charts and numbers
      </label>
    </Card>
  );
}
