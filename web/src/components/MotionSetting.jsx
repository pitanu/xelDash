import { setAnimations, useAnimations } from "../motion.js";
import { SettingBlock, Switch } from "./ui.jsx";

/**
 * Per-browser choice of chart animations. A system setting for less motion turns them off whatever is chosen here.
 * @param {{ row?: boolean }} props
 */
export default function MotionSetting({ row = false }) {
  const on = useAnimations();
  return (
    <SettingBlock row={row} title="Chart animations"
      subtitle="Charts draw in when they load or change range, and the numbers count up. They run once, in your browser, and are always off when your device asks for less motion. Saved in this browser only."
      aside={<Switch checked={on} onChange={setAnimations} label="Animate charts and numbers" />} />
  );
}
