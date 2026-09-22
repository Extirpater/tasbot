import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MotionTracker } from "../src/observe.js";
import { bestAction, planActions, predictHazardPath } from "../src/planner.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/spiral14.json", import.meta.url)),
);
const recordedState = () => {
  const tracker = new MotionTracker();
  for (const sample of fixture.warmup)
    tracker.update({ ...fixture.state, ...sample });
  return tracker.update(fixture.state);
};
const generated = (
  tick,
  { type = 206, rate = -9, acceleration = -7.2, speed = 270 } = {},
) => {
  const angle =
    -2.7 + (rate * tick) / 60 + (acceleration * (tick / 60) ** 2) / 2;
  return {
    packet: tick,
    tickRate: 60,
    area: { id: "spiral", x: 0, y: 0, width: 1000, height: 500, zones: [] },
    player: { x: 100, y: 100, speed: 510, radius: 15 },
    hazards: [
      {
        id: 1,
        entityType: type,
        x: 500,
        y: 250,
        radius: 18,
        vx: speed * Math.cos(angle),
        vy: speed * Math.sin(angle),
      },
    ],
  };
};

test("Spiral fitting handles mixed packet gaps, angle wrapping and duplicate reads", () => {
  for (const type of [206, 207]) {
    const tracker = new MotionTracker();
    let last;
    for (const tick of [0, 1, 3, 4, 6, 7, 9, 10, 12])
      last = tracker.update(generated(tick, { type }));
    const model = last.hazards[0].spiral;
    assert.ok(model);
    assert.ok(Math.abs(model.turnRate - (-9 - (7.2 * 12) / 60)) < 1e-8);
    assert.ok(Math.abs(model.turnAcceleration + 7.2) < 1e-8);
    assert.equal(
      tracker.update(generated(12, { type })).hazards[0].spiral,
      model,
    );
    assert.equal(tracker.spirals.get(1).samples.length, 9);
  }
});

test("Spiral fits require new observations to agree and reset after gaps, stops and area changes", () => {
  const warm = () => {
    const tracker = new MotionTracker();
    for (let tick = 0; tick < 12; tick++) tracker.update(generated(tick));
    assert.ok(tracker.update(generated(11)).hazards[0].spiral);
    return tracker;
  };
  const phaseChange = generated(12, { rate: 4, acceleration: 0 });
  assert.equal(warm().update(phaseChange).hazards[0].spiral, undefined);
  assert.equal(warm().update(generated(16)).hazards[0].spiral, undefined);
  assert.equal(warm().update(generated(0)).hazards[0].spiral, undefined);
  const moved = generated(12);
  moved.area.id = "another-area";
  assert.equal(warm().update(moved).hazards[0].spiral, undefined);
  const stopped = generated(12);
  stopped.hazards[0].motionEffects = [{ scale: 0, remainingMs: 200 }];
  assert.equal(warm().update(stopped).hazards[0].spiral, undefined);
  assert.equal(
    warm().update(generated(12, { speed: 200 })).hazards[0].spiral,
    undefined,
  );
  const removed = warm();
  removed.update({ ...generated(12), hazards: [] });
  assert.equal(removed.spirals.size, 0);
});

test("ordinary enemy families do not train Spiral models", () => {
  const tracker = new MotionTracker();
  for (let tick = 0; tick < 30; tick++) {
    const result = tracker.update(generated(tick, { type: 115 }));
    assert.equal(result.hazards[0].spiral, undefined);
  }
  assert.equal(tracker.spirals.size, 0);
});

test("causal Spiral forecast matches later recorded positions instead of projecting a straight line", () => {
  const s = recordedState();
  const h = s.hazards.find((h) => h.id === 1265);
  assert.ok(h.spiral);
  let worstCurve = 0,
    worstStraight = 0;
  for (const later of fixture.future) {
    const actual = later.hazards.find((h) => h.id === 1265);
    const ticks = later.packet - s.packet;
    const curve = predictHazardPath(h, s.area, ticks, 1 / 60).at(-1);
    const straight = predictHazardPath(
      { ...h, spiral: undefined },
      s.area,
      ticks,
      1 / 60,
    ).at(-1);
    worstCurve = Math.max(
      worstCurve,
      Math.hypot(curve.x - actual.x, curve.y - actual.y),
    );
    worstStraight = Math.max(
      worstStraight,
      Math.hypot(straight.x - actual.x, straight.y - actual.y),
    );
  }
  assert.ok(worstCurve < 0.01, `curved error ${worstCurve}`);
  assert.ok(worstStraight > 95);
});

test("Wacky 14 rejects the falsely clear rightward approach early enough to dodge", () => {
  const baseline = planActions(fixture.state, fixture.options);
  assert.ok(
    baseline.find((c) => c.action === fixture.originalAction)
      .physicalClearance > 50,
  );
  const candidates = planActions(recordedState(), fixture.options);
  assert.ok(
    candidates.find((c) => c.action === fixture.originalAction)
      .physicalClearance < 0,
  );
  const chosen = candidates.find((c) => c.action === bestAction(candidates));
  assert.notEqual(chosen.action, fixture.originalAction);
  assert.ok(chosen.physicalClearance > 35 && !chosen.collision);
});

test("coarse curved forecasts interpolate the server-tick path used by local dodges", () => {
  const s = recordedState(),
    h = s.hazards.find((h) => h.id === 1265);
  const fine = predictHazardPath(h, s.area, 40, 1 / 60);
  const dt = 2.5 / 60,
    coarse = predictHazardPath(h, s.area, 12, dt);
  for (let i = 0; i < coarse.length; i++) {
    const at = i * 2.5,
      lo = Math.floor(at),
      fraction = at - lo;
    for (const key of ["x", "y"]) {
      const expected =
        fine[lo][key] + (fine[lo + 1][key] - fine[lo][key]) * fraction;
      assert.ok(Math.abs(coarse[i][key] - expected) < 1e-8);
    }
  }
});
