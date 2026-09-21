// Repeatable validation entry point. Simulators use independent recorded or
// synthetic enemy motion; catalog-only types are explicitly reported.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import catalog from "../data/enemies.json" with { type: "json" };
import monumentalMigration from "../data/monumental-migration.json" with { type: "json" };
import { ENEMY_TYPES } from "../src/enemies.js";
import { MotionTracker } from "../src/observe.js";
import * as planner from "../src/planner.js";
import { MovementPolicy } from "../src/movement.js";
import { replayEncounter } from "./replay-encounter.js";

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "3" },
    output: { type: "string", default: "artifacts/enemy-suite.json" },
  },
});
const seeds = Number(values.seeds);
if (!Number.isInteger(seeds) || seeds < 1 || seeds > 100)
  throw new Error("--seeds must be 1–100");
const root = new URL("../", import.meta.url);
const run = (args) => {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Validation failed with exit code ${result.status}`);
};
run(["--test"]);
mkdirSync(new URL("../artifacts", import.meta.url), { recursive: true });
const courses = [];
for (const scenario of ["normal", "dash"]) {
  const output = `artifacts/enemy-suite-${scenario}.json`;
  run([
    "scripts/benchmark.js",
    "--seeds",
    String(seeds),
    "--speed",
    "660",
    "--max-speed",
    "660",
    "--delay-ms",
    "135",
    "--scenario",
    scenario,
    "--output",
    output,
  ]);
  courses.push({
    scenario,
    ...JSON.parse(readFileSync(new URL(`../${output}`, import.meta.url))),
  });
}

const f = JSON.parse(
  readFileSync(new URL("../test/fixtures/wacky-spiral.json", import.meta.url)),
);
const tracker = new MotionTracker();
const frames = f.history.map((row) => ({
  ...row,
  state: tracker.update({
    ...f.state,
    packet: row.packet,
    player: row.player,
    hazards: row.hazards.map((h) => ({
      ...h,
      uncertainMotion: ENEMY_TYPES[h.entityType]?.uncertainMotion,
    })),
  }),
}));
const trace = { frames, finalState: f.finalState };
const broad = {
  ...trace,
  frames: frames.map((f) => ({
    ...f,
    state: {
      ...f.state,
      hazards: f.state.hazards.map((h) => ({ ...h, learnedMotion: undefined })),
    },
  })),
};
const replays = [];
for (const delayTicks of [-1, 0, 1])
  for (const [model, input] of [
    ["broad fallback", broad],
    ["learned patterns", trace],
  ]) {
    const result = {
      model,
      ...replayEncounter(input, planner, MovementPolicy, {
        fromFrame: 140,
        delayTicks,
      }),
    };
    replays.push(result);
    console.log(JSON.stringify(result));
  }

const checks = {
  normal: "seeded courses",
  wall: "seeded courses and recorded corner checks",
  dasher: "seeded courses and phase checks",
  homing: "recorded pursuit checks",
  switch: "timer checks and reconstructed encounter",
  sizing: "growth/reversal checks",
  turning: "angular motion and wall checks",
  slippery: "recorded locked steering and synthetic entry/exit",
  pumpkin: "dormancy, windup and charge-duration checks",
  star: "landing checks and reconstructed encounter",
  teleporting: "landing and boundary checks",
  wavy: "synthetic repeating-wave forecasts",
  spiral: "recorded future forecasts and encounter replays",
  zoning: "included in recorded Wacky encounter replays",
};
const coverage = catalog.entities
  .filter((e) => e.name.endsWith("_enemy"))
  .map((e) => {
    const family = e.name.replace(/_switch_enemy$|_enemy$/, "");
    return {
      id: e.id,
      name: e.name,
      validation: checks[family] ?? "not separately validated",
      switchVariant: e.name.endsWith("_switch_enemy"),
    };
  });
const mmTypes = new Set(
  monumentalMigration.groups.flatMap((group) => group.enemyTypes),
);
const mmCoverage = coverage.filter((entry) => mmTypes.has(entry.name));
const unknownMMTypes = [...mmTypes].filter(
  (name) => !mmCoverage.some((entry) => entry.name === name),
);
if (unknownMMTypes.length)
  throw new Error(
    `MM reference types missing from catalog: ${unknownMMTypes.join(", ")}`,
  );
const report = {
  generatedAt: new Date().toISOString(),
  source: catalog.source,
  scope:
    "Behavior regressions, simplified normal/dasher courses, and short Wacky recorded-window replays. Family-level checks do not certify every variant, level, effect, or full live run.",
  testsPassed: true,
  courses,
  replays,
  coverage,
  monumentalMigration: {
    reference: "data/monumental-migration.json",
    source: monumentalMigration.video.url,
    scope:
      "Historical video family inventory, with live type evidence through area 44. Shared family checks do not validate MM encounters or later repetitions.",
    repetition: monumentalMigration.repetition,
    coverage: mmCoverage,
    unvalidatedEnemyTypes: mmCoverage
      .filter((entry) => entry.validation === "not separately validated")
      .map((entry) => entry.name),
    outstandingMechanics: monumentalMigration.priorityMechanics,
  },
  unvalidatedEnemyTypes: coverage
    .filter((e) => e.validation === "not separately validated")
    .map((e) => e.name),
};
const output = resolve(values.output);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
const runs = courses.flatMap((c) => c.records);
console.log(
  `Courses cleared: ${runs.filter((r) => r.outcome === "cleared").length}/${runs.length}.`,
);
console.log(
  `Enemy types without separate family checks: ${report.unvalidatedEnemyTypes.length}/${coverage.length}.`,
);
console.log(`Report: ${output}`);
console.log(
  `MM reference families without separate checks: ${report.monumentalMigration.unvalidatedEnemyTypes.length}/${mmCoverage.length}.`,
);
if (
  runs.some((r) => r.outcome !== "cleared") ||
  replays.some((r) => !r.survivedRecordedWindow)
)
  process.exitCode = 1;
