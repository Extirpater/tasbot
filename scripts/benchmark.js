// Small deterministic physics benchmark, not an emulation of all Evades rules.
// Use --baseline /absolute/path/planner.mjs for a paired comparison.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { planActions, bestAction, ACTIONS } from "../src/planner.js";
import { InputTiming } from "../src/timing.js";
import { MovementPolicy } from "../src/movement.js";
import { Navigation } from "../src/navigation.js";
const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    "baseline-timing": { type: "boolean", default: false },
    "baseline-movement": { type: "boolean", default: false },
    "baseline-navigation": { type: "boolean", default: false },
    seeds: { type: "string", default: "12" },
    "start-seed": { type: "string", default: "1" },
    balls: { type: "string", default: "32" },
    speed: { type: "string", default: "390" },
    "max-speed": { type: "string", default: "510" },
    scenario: { type: "string", default: "normal" },
    hz: { type: "string", default: "60" },
    "delay-ms": { type: "string", default: "50" },
    "plan-ms": { type: "string", default: "18" },
    output: { type: "string", default: "artifacts/benchmark.json" },
  },
});
const policies = [["current", { planActions, bestAction }]];
const BaselineMovement =
  values["baseline-movement"] && values.baseline
    ? (await import(new URL("movement.js", pathToFileURL(values.baseline))))
        .MovementPolicy
    : undefined;
const BaselineNavigation =
  values["baseline-navigation"] && values.baseline
    ? (await import(new URL("navigation.js", pathToFileURL(values.baseline))))
        .Navigation
    : undefined;
if (values.baseline)
  policies.unshift(["baseline", await import(pathToFileURL(values.baseline))]);
const randomFor = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
function scenario(seed) {
  const random = randomFor(seed);
  const area = {
    id: "simulation",
    x: 0,
    y: 0,
    width: 2400,
    height: 480,
    zones: [
      { x: 0, y: 0, width: 240, height: 480, type: 4 },
      { x: 240, y: 0, width: 1920, height: 480, type: 0 },
      { x: 2160, y: 0, width: 176, height: 480, type: 4 },
      { x: 2336, y: 0, width: 64, height: 480, type: 2 },
    ],
    walls: [],
  };
  const hazards = Array.from({ length: Number(values.balls) }, (_, i) => {
    const radius = i < 2 ? 75 : 18;
    const speed = i < 2 ? 55 : 100 + random() * 70;
    const angle = random() * 2 * Math.PI;
    return {
      id: i,
      x: 330 + random() * 1740,
      y: radius + random() * (480 - 2 * radius),
      radius,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      bounce: true,
    };
  });
  for (let i = 0; i < 4; i++)
    hazards.push({
      id: Number(values.balls) + i,
      x: 300 + 500 * i,
      y: i % 2 ? 450 : 30,
      radius: 30,
      vx: i % 2 ? -130 : 130,
      vy: 0,
      bounce: true,
      motion: "perimeter",
    });
  if (values.scenario === "dash") {
    for (const h of hazards.filter((h) => h.radius === 18 && h.id % 2 === 0)) {
      const magnitude = Math.hypot(h.vx, h.vy);
      h.cycle = random() * 4500;
      h.dash = {
        peak: 210 + random() * 90,
        dx: h.vx / magnitude,
        dy: h.vy / magnitude,
      };
      updateDash(h, 0);
    }
  }
  if (values.scenario === "pocket") {
    hazards.length = 0;
    area.walls = [
      { x: 430, y: 100, width: 670, height: 20 },
      { x: 1080, y: 100, width: 20, height: 280 },
      { x: 430, y: 360, width: 670, height: 20 },
    ];
  }
  return {
    ready: true,
    time: 0,
    packet: 0,
    tickRate: 60,
    area,
    player: {
      x: values.scenario === "pocket" ? 900 : 120,
      y: 240,
      radius: 15,
      speed: Number(values.speed),
      baseSpeed: Number(values.speed),
      downed: false,
    },
    hazards,
  };
}
function updateDash(h, elapsed) {
  h.cycle = (h.cycle + elapsed) % 4500;
  const phase = h.cycle;
  h.dash.resting = phase < 750 ? phase : 0;
  h.dash.preparing = phase >= 750 && phase < 1500 ? phase - 750 : 0;
  h.dash.dashing = phase >= 1500 ? phase - 1500 : 0;
  const speed =
    phase < 750
      ? 0
      : phase < 1500
        ? (h.dash.peak / 5) * (1 - (phase - 750) / 750)
        : h.dash.peak * (1 - (phase - 1500) / 3000);
  h.vx = h.dash.dx * speed;
  h.vy = h.dash.dy * speed;
}
// Independent tick integrator. Wall balls clamp and turn at a corner; normal
// balls gain a seeded small angular perturbation when bouncing (unmodeled).
function advanceHazard(h, random) {
  if (h.dash) updateDash(h, 1000 / 60);
  h.x += h.vx / 60;
  h.y += h.vy / 60;
  const minX = 240 + h.radius,
    maxX = 2160 - h.radius,
    minY = h.radius,
    maxY = 480 - h.radius;
  const hitX = h.x < minX || h.x > maxX,
    hitY = h.y < minY || h.y > maxY;
  if (!hitX && !hitY) return;
  if (h.motion === "perimeter") {
    const clockwise = (h.x - 1200) * h.vy - (h.y - 240) * h.vx > 0;
    h.x = Math.max(minX, Math.min(maxX, h.x));
    h.y = Math.max(minY, Math.min(maxY, h.y));
    const old = h.vx;
    h.vx = clockwise ? -h.vy : h.vy;
    h.vy = clockwise ? old : -old;
  } else {
    if (hitX) {
      h.x = h.x < minX ? 2 * minX - h.x : 2 * maxX - h.x;
      h.vx = -h.vx;
    }
    if (hitY) {
      h.y = h.y < minY ? 2 * minY - h.y : 2 * maxY - h.y;
      h.vy = -h.vy;
    }
    const angle = ((random() - 0.5) * Math.PI) / 30,
      vx = h.vx;
    h.vx = h.vx * Math.cos(angle) - h.vy * Math.sin(angle);
    h.vy = vx * Math.sin(angle) + h.vy * Math.cos(angle);
    if (h.dash && Math.hypot(h.vx, h.vy) > 1e-6) {
      const speed = Math.hypot(h.vx, h.vy);
      h.dash.dx = h.vx / speed;
      h.dash.dy = h.vy / speed;
    }
  }
}
const records = [],
  summaries = [];
for (const [name, policy] of policies) {
  const timings = [];
  for (let offset = 0; offset < Number(values.seeds); offset++) {
    const seed = Number(values["start-seed"]) + offset;
    const timing = new InputTiming();
    const movement =
      name === "current"
        ? new MovementPolicy()
        : BaselineMovement
          ? new BaselineMovement()
          : undefined;
    const navigation =
      name === "current"
        ? new Navigation()
        : BaselineNavigation
          ? new BaselineNavigation()
          : undefined;
    const s = scenario(seed),
      random = randomFor(seed + 5000),
      queue = [];
    let requested = "stay",
      applied = "stay",
      outcome = "timeout",
      ticks = 0,
      focusTicks = 0;
    let fastFrames = 0,
      decisions = 0,
      actionChanges = 0,
      reversals = 0;
    for (; ticks < 20 * 60; ticks++) {
      if (ticks % Math.max(1, Math.round(60 / Number(values.hz))) === 0) {
        const now = (ticks / 60) * 1000;
        timing.observe(structuredClone(s), now);
        movement?.observe?.(s, now, timing.delayMs);
        const start = performance.now();
        const route = navigation?.update(s, now);
        const candidates = policy.planActions(s, {
          previousAction: requested,
          ...movement?.planOptions(now),
          navigation: route,
          maxPlanMs:
            name === "current"
              ? Number(values["plan-ms"])
              : policy.planResponsiveActions
                ? 24
                : Infinity,
          maxSpeed: Number(values["max-speed"]),
          ...(name === "current" || values["baseline-timing"]
            ? timing.pending(now)
            : {}),
        });
        timings.push(performance.now() - start);
        const next = movement
          ? movement.select(candidates, undefined, now)
          : policy.bestAction(candidates);
        if (next !== requested) {
          if (decisions) actionChanges++;
          const from = ACTIONS[requested],
            to = ACTIONS[next];
          if (from.dx * to.dx < 0 || from.dy * to.dy < 0) reversals++;
        }
        requested = next;
        movement?.record(requested, now);
        decisions++;
        if (candidates[0].fastPath) fastFrames++;
        timing.record(requested, now);
        queue.push({
          tick: ticks + Math.ceil((Number(values["delay-ms"]) / 1000) * 60),
          action: requested,
        }); // Configured command-to-observation lag.
      }
      // The update ending at tick N consumes commands received by tick N,
      // matching the independent latency estimator and live planner.
      while (queue.length && queue[0].tick <= ticks + 1)
        applied = queue.shift().action;
      const a = ACTIONS[applied],
        p = s.player;
      const speed = p.speed * (a.scale ?? 1);
      p.x = Math.max(15, Math.min(2385, p.x + (a.dx * speed) / 60));
      p.y = Math.max(15, Math.min(465, p.y + (a.dy * speed) / 60));
      p.vx = a.dx * speed;
      p.vy = a.dy * speed;
      if (a.scale) focusTicks++;
      for (const h of s.hazards) advanceHazard(h, random);
      if (
        s.area.walls.some((w) => {
          const x = Math.max(w.x, Math.min(w.x + w.width, p.x));
          const y = Math.max(w.y, Math.min(w.y + w.height, p.y));
          return (p.x - x) ** 2 + (p.y - y) ** 2 < p.radius ** 2;
        })
      ) {
        outcome = "wall collision";
        break;
      }
      const sheltered = p.x + p.radius <= 240 || p.x - p.radius >= 2160;
      if (
        !sheltered &&
        s.hazards.some(
          (h) => Math.hypot(p.x - h.x, p.y - h.y) < p.radius + h.radius,
        )
      ) {
        outcome = "collision";
        break;
      }
      if (p.x >= 2350) {
        outcome = "cleared";
        break;
      }
      s.packet++;
      s.time += 1000 / 60;
    }
    const record = {
      policy: name,
      seed,
      outcome,
      seconds: +(ticks / 60).toFixed(2),
      x: +s.player.x.toFixed(1),
      focusSeconds: +(focusTicks / 60).toFixed(2),
      fastPathFraction: fastFrames / decisions,
      estimatedDelayMs: name === "current" ? timing.delayMs : undefined,
      actionChanges,
      reversals,
      changesPerSecond: +(actionChanges / Math.max(1 / 60, ticks / 60)).toFixed(
        2,
      ),
    };
    records.push(record);
    console.log(JSON.stringify(record));
  }
  timings.sort((a, b) => a - b);
  const summary = {
    policy: name,
    medianPlanMs: timings[Math.floor(timings.length * 0.5)],
    p95PlanMs: timings[Math.floor(timings.length * 0.95)],
  };
  summaries.push(summary);
  console.log(JSON.stringify(summary));
}
await mkdir("artifacts", { recursive: true });
await writeFile(
  values.output,
  JSON.stringify({ parameters: values, records, summaries }, null, 2),
);
