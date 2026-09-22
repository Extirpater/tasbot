// Repeatable validation entry point. Simulators use independent recorded or
// synthetic enemy motion; catalog-only types are explicitly reported.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import catalog from "../data/enemies.json" with { type: "json" };
import monumentalMigration from "../data/monumental-migration.json" with { type: "json" };
import { LIVE_PROFILE } from "../src/live-models.js";

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

const checks = {
  normal: "seeded courses",
  wall: "seeded courses and recorded corner checks",
  dasher: "seeded courses and phase checks",
  homing: "recorded pursuit checks",
  icicle: "public-client tick parity, wall pauses and corners",
  liquid: "public-client tick parity and candidate-dependent activation",
  turning: "public-client tick parity and reflected curves",
  slippery: "public-client slide lock, delayed steering and wall boost",
  ice_sniper: "forecast behavior tests; server firing and targeting unverified",
  spiral: "causal fit and recorded trajectory checks",
  zoning: "recorded deceleration and short packet-gap replay; later turns unverified",
};
const coverage = catalog.entities
  .filter((e) => e.name.endsWith("_enemy"))
  .map((e) => {
    const family = e.name.replace(/_switch_enemy$|_enemy$/, "");
    return {
      id: e.id,
      name: e.name,
      validation: e.name.endsWith("_switch_enemy")
        ? "not separately validated"
        : (checks[family] ?? "not separately validated"),
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
  controllerProfile: LIVE_PROFILE,
  source: catalog.source,
  scope:
    "Live controller regression and public-client model parity tests, plus simplified normal/dasher courses. Forecast tests and catalog entries do not establish complete live-level survival.",
  testsPassed: true,
  courses,
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
if (runs.some((r) => r.outcome !== "cleared")) process.exitCode = 1;
