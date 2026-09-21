import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as current from "../src/planner.js";

const { values } = parseArgs({
  options: {
    trace: { type: "string" },
    baseline: { type: "string" },
    output: { type: "string" },
    "from-frame": { type: "string", default: "0" },
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
    for (let i = fromFrame; i < frames.length; i += 3) {
      const start = performance.now();
      const candidates = policy.planActions(frames[i].state, {
        previousAction: frames[i - 1]?.action ?? "stay",
        ...frames[i].prediction,
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
  scope:
    "Local planner with recorded queued inputs; excludes browser I/O and navigation. One warmup pass, three measured passes.",
  results,
};
console.log(JSON.stringify(report, null, 2));
if (values.output)
  await writeFile(values.output, JSON.stringify(report, null, 2));
