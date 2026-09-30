import { useSetup } from "../setup.js";

/** On the Overview until setup is done: what is next, and a way to continue. */
export default function SetupBanner() {
  const setup = useSetup({ intervalMs: 10_000 });
  if (!setup.loaded || setup.complete) return null;
  const next = setup.steps.find((step) => step.state !== "done") ?? setup.steps[0];
  return (
    <a href="#/setup" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-series-1/40 bg-series-1/10 p-4 hover:bg-series-1/15 sm:p-5">
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">Finish setting up xelDash ({setup.done} of 4 steps done)</span>
        <span className="mt-0.5 block text-sm text-ink-2">Next: {next.title.toLowerCase()}. {next.headline}.</span>
      </span>
      <span className="shrink-0 rounded-md bg-series-1 px-3 py-1.5 text-sm font-semibold text-white">Continue</span>
    </a>
  );
}
