import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planActions, predictHazardPath } from "../src/planner.js";
import { MovementPolicy } from "../src/movement.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/safe-zone-retreat.json", import.meta.url)),
);

test("Area 35 finishes retreating instead of stopping beside the refuge entrance", () => {
  const f = fixture;
  const movement = new MovementPolicy();
  movement.record("left", f.previousAppliedAt);
  const candidates = planActions(f.state, f.options);
  const stop = candidates.find((c) => c.action === f.recordedAction);
  assert.equal(stop.action, "stay");
  assert.ok(stop.clearance < -9);
  const retreat = candidates.find((c) => c.action === "left");
  assert.ok(retreat.clearance > 4);
  assert.equal(movement.select(candidates, undefined, f.observedAt), "left");
});

test("wall-ball forecast matches the recorded corner instead of carrying overshoot around it", () => {
  const f = fixture,
    first = f.wallSamples[0].packet;
  const path = predictHazardPath(
    f.wallStart,
    f.state.area,
    f.wallSamples.at(-1).packet - first,
    1 / 60,
  );
  for (const sample of f.wallSamples)
    assert.deepEqual(path[sample.packet - first], { x: sample.x, y: sample.y });
});

test("coarse wall-ball forecasts retain server-tick corner timing and timed stops", () => {
  const area = { zones: [{ x: 0, y: 0, width: 100, height: 100, type: 0 }] };
  const h = { x: 90, y: 10, radius: 10, vx: 600, vy: 0, motion: "perimeter" };
  const path = predictHazardPath(h, area, 2, 0.1);
  assert.deepEqual(path, [
    { x: 90, y: 10 },
    { x: 90, y: 60 },
    { x: 70, y: 90 },
  ]);
  const frozen = predictHazardPath(
    {
      ...h,
      vx: 0,
      baseVx: 600,
      baseVy: 0,
      motionEffects: [{ scale: 0, remainingMs: 100 }],
    },
    area,
    2,
    0.1,
  );
  assert.deepEqual(frozen, [
    { x: 90, y: 10 },
    { x: 90, y: 10 },
    { x: 90, y: 60 },
  ]);
  assert.deepEqual(predictHazardPath(h, area, 2, 1 / 30, undefined, 30)[2], {
    x: 90,
    y: 30,
  });
});

test("refuge entrance retains a safety buffer while the outer wall inside remains sheltered", () => {
  const state = {
    tickRate: 60,
    player: { x: 180, y: 15, radius: 15, speed: 600, vx: 0, vy: 0 },
    area: {
      x: 0,
      y: 0,
      width: 1000,
      height: 500,
      zones: [
        { x: 0, y: 0, width: 200, height: 500, type: 4 },
        { x: 200, y: 0, width: 800, height: 500, type: 0 },
      ],
    },
    hazards: [
      { id: 1, x: 230, y: 15, radius: 30, vx: 0, vy: 0, bounce: false },
    ],
  };
  const options = { reactionTime: 0, horizon: 0.1, fastPath: false };
  const edge = planActions(state, options).find((c) => c.action === "stay");
  assert.equal(edge.physicalClearance, 5);
  assert.ok(edge.collision);
  state.player.x = 80;
  // Even a projectile penetrating shelter cannot hit a fully protected player.
  state.hazards[0].x = 80;
  const deep = planActions(state, options).find((c) => c.action === "stay");
  assert.ok(!deep.collision);
  assert.ok(deep.clearanceCapped);
});
