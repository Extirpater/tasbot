import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as current from "../src/planner.js";
import { prepareLivePlanning } from "../src/live-models.js";
import { Navigation } from "../src/navigation.js";

const { values } = parseArgs({
  options: {
    trace: { type: "string" },
    baseline: { type: "string" },
    output: { type: "string" },
    "from-frame": { type: "string", default: "0" },
    "plan-ms": { type: "string", default: "18" },
    live: { type: "boolean", default: false },
  },
});
if (!values.trace)
  throw new Error(
    "Pass --trace artifacts/death-....json (optional --baseline planner.mjs)",
  );
const data = JSON.parse(await readFile(values.trace, "utf8"));
const frames = data.frames ?? data;
const policies = [["current", current]];
if (values.baseline)
  policies.unshift(["baseline", await import(pathToFileURL(values.baseline))]);
const results = [];
const fromFrame = Number(values["from-frame"]);
if (!Number.isInteger(fromFrame) || fromFrame < 0 || fromFrame >= frames.length)
  throw new Error("--from-frame must identify a frame in the trace");
for (const [name, policy] of policies) {
  const times = [];
  let shortcuts = 0;
  for (let repeat = 0; repeat < 4; repeat++) {
    const navigation = new Navigation();
    for (let i = fromFrame; i < frames.length; i += 3) {
      const start = performance.now();
      const prepared = values.live && name === "current"
        ? prepareLivePlanning(frames[i].state, {
            decisionMs: (frames[i].planning?.inputIntervalTicks ?? 3) * 1000 / (frames[i].state.tickRate ?? 60),
          })
        : { state: frames[i].state, options: {} };
      const route = values.live ? navigation.update(prepared.state,
        frames[i].state.packet * 1000 / (frames[i].state.tickRate ?? 60)) : undefined;
      const candidates = policy.planActions(prepared.state, {
        previousAction: frames[i - 1]?.action ?? "stay",
        ...frames[i].prediction,
        ...prepared.options,
        navigation: route,
        maxPlanMs: values.live || name === "current" ? Number(values["plan-ms"]) : Infinity,
      });
      if (repeat > 0) {
        times.push(performance.now() - start);
        if (candidates[0].fastPath) shortcuts++;
      }
    }
  }
  times.sort((a, b) => a - b);
  results.push({
    name,
    calls: times.length,
    shortcuts,
    medianMs: times[Math.floor(times.length * 0.5)],
    p95Ms: times[Math.floor(times.length * 0.95)],
  });
}
const report = {
  trace: values.trace,
  fromFrame,
  planBudgetMs: Number(values["plan-ms"]),
  scope: values.live
    ? "Model preparation, navigation and bounded local planner with recorded queued inputs; both profiles use the same search budget. Excludes browser I/O. One warmup pass, three measured passes."
    : "Local planner with recorded queued inputs; excludes browser I/O and navigation. One warmup pass, three measured passes.",
  results,
};
console.log(JSON.stringify(report, null, 2));
if (values.output)
  await writeFile(values.output, JSON.stringify(report, null, 2));
