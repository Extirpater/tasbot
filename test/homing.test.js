import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { observeGame } from "../src/observe.js";
import { MovementPolicy } from "../src/movement.js";
import { predictHazardPath, planActions, bestAction } from "../src/planner.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/homing-wall.json", import.meta.url)),
);
const withHoming = (h) => ({
  ...h,
  homing: {
    ...fixture.homingDefaults,
    heading: Math.atan2(h.vy, h.vx),
    speed: Math.hypot(h.vx, h.vy),
  },
});

test("homing forecast follows the recorded Area 30 turn back toward the top wall", () => {
  const f = fixture,
    firstPacket = f.samples[0].packet;
  const targetAt = (time) => {
    const packet = firstPacket + time * 60;
    const before = f.samples.findLast((s) => s.packet <= packet);
    const after = f.samples.find((s) => s.packet >= packet);
    if (before === after) return before.player;
    const weight = (packet - before.packet) / (after.packet - before.packet);
    return {
      x: before.player.x + (after.player.x - before.player.x) * weight,
      y: before.player.y + (after.player.y - before.player.y) * weight,
    };
  };
  const steps = f.samples.at(-1).packet - firstPacket;
  const old = predictHazardPath(f.forecastStart, f.state.area, steps, 1 / 60);
  const updated = predictHazardPath(
    withHoming(f.forecastStart),
    f.state.area,
    steps,
    1 / 60,
    targetAt,
  );
  const actual = f.samples.at(-1).hazard;
  const error = (path) =>
    Math.hypot(path.at(-1).x - actual.x, path.at(-1).y - actual.y);
  assert.ok(error(old) > 80);
  assert.ok(error(updated) < 5);
  const player = f.samples.at(-1).player;
  assert.ok(
    Math.hypot(updated.at(-1).x - player.x, updated.at(-1).y - player.y) <
      f.forecastStart.radius + f.state.player.radius,
  );
});

test("the recorded top-wall retreat is unsafe when the homing ball can turn", () => {
  const f = fixture;
  // Hold the recorded first input for its original 150 ms to isolate the
  // forecast correction from the newer short-turn search.
  const options = { ...f.options, firstSegmentTime: 0.15 };
  const before = planActions(f.state, options);
  assert.ok(
    before.find((c) => c.action === f.originalAction).physicalClearance > 26,
  );
  const state = structuredClone(f.state);
  state.hazards = state.hazards.map((h) =>
    h.entityType === 73 ? withHoming(h) : h,
  );
  const after = planActions(state, options);
  const retreat = after.find((c) => c.action === f.originalAction);
  assert.ok(retreat.physicalClearance < 0);
  // Once the homing ball blocks the old escape, even the best continuation
  // can run into another ball. Do not require a particular predicted collider.
  assert.notEqual(bestAction(after), f.originalAction);
});

test("homing respects range, opposite player paths, and timed stops", () => {
  const area = { zones: [] };
  const h = {
    x: 0,
    y: 0,
    vx: 100,
    vy: 0,
    radius: 10,
    homing: { speed: 100, heading: 0, range: 200, turnRate: 1.5 },
  };
  const up = predictHazardPath(h, area, 12, 1 / 60, () => ({
    x: 100,
    y: -100,
  })).at(-1);
  const down = predictHazardPath(h, area, 12, 1 / 60, () => ({
    x: 100,
    y: 100,
  })).at(-1);
  assert.ok(up.y < -2);
  assert.ok(down.y > 2);
  const far = predictHazardPath(h, area, 12, 1 / 60, () => ({
    x: 100,
    y: 1000,
  })).at(-1);
  assert.equal(far.y, 0);
  const stopped = predictHazardPath(
    { ...h, motionEffects: [{ scale: 0, remainingMs: 100 }] },
    area,
    12,
    1 / 60,
  );
  assert.ok(Math.abs(stopped[6].x) < 1e-6);
  assert.ok(Math.abs(stopped[12].x - 10) < 1e-6);
});

test("Area 28 homing escape overrides commitment on the original tick schedule", () => {
  const f = JSON.parse(
    readFileSync(new URL("./fixtures/recent-homing.json", import.meta.url)),
  );
  const decide = (state) => {
    const movement = new MovementPolicy();
    movement.record(f.previousAction, f.previousAppliedAt);
    const candidates = planActions(state, {
      ...movement.planOptions(f.observedAt),
      ...f.prediction,
      // Preserve this historical comparison's executed inputs. The original
      // planner sampled arrivals at tick starts, a tick later than the latency
      // estimator. Shift arrivals here explicitly; live traces use tick ends.
      reactionTime: f.prediction.reactionTime + 1 / state.tickRate,
      pendingInputs: f.prediction.pendingInputs.map((input) => ({
        ...input,
        time: input.time > 0 ? input.time + 1 / state.tickRate : 0,
      })),
      horizon: 0.9 - 1 / state.tickRate,
      firstSegmentTime: 0.15,
    });
    const action = movement.select(candidates, undefined, f.observedAt);
    return { action, reason: movement.reason, candidates };
  };
  const before = decide(f.state);
  assert.equal(before.action, "focus_right");
  assert.equal(before.reason, "finish dodge");
  const state = structuredClone(f.state);
  state.hazards = state.hazards.map((h) =>
    h.entityType === 73 ? withHoming(h) : h,
  );
  const after = decide(state);
  assert.equal(after.action, "focus_down");
  assert.equal(after.reason, "safety override");
  assert.ok(
    after.candidates.find((c) => c.action === "focus_right").clearance < 0,
  );
  assert.ok(
    after.candidates.find((c) => c.action === after.action).physicalClearance >
      32,
  );
  assert.equal(f.millisecondsBeforeDeath, 350);
});

test("observer captures the actual homing speed, range, reverse flag, and turn rate", () => {
  const gameState = {
    self: {
      entity: { id: 1, x: 0, y: 0, radius: 15, speed: 510, deathTimer: -1 },
    },
    serverTickRate: 60,
    entities: {
      2: {
        id: 2,
        isEnemy: true,
        x: 100,
        y: 100,
        radius: 120,
        trackHomingState() {},
        _pred: { angle: 1, baseSpeed: 4, vx: 0, vy: 0 },
        homeRange: 275,
        increment: 2,
        reverse: true,
        reduced: true,
      },
    },
    area: { x: 0, y: 0, width: 1000, height: 500, zones: { list: () => [] } },
  };
  const element = {
    __reactFiber$test: { stateNode: { gameState, state: {} } },
  };
  const result = vm.runInNewContext(`(${observeGame.toString()})()`, {
    document: { querySelectorAll: () => [element] },
    performance: { now: () => 0 },
  });
  const homing = result.hazards[0].homing;
  assert.equal(homing.heading, 1);
  assert.equal(homing.speed, 240);
  assert.equal(homing.range, 275);
  assert.equal(homing.turnRate, 1);
  assert.equal(homing.reverse, true);
});

for (const [name, count] of [
  ["dense-homing", 34],
  ["frozen-homing", 12],
])
  test(`${name} optimization preserves exhaustive pursuit and collision results`, () => {
    const f = JSON.parse(
      readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)),
    );
    assert.equal(f.state.hazards.filter((h) => h.homing).length, count);
    const candidates = planActions(f.state, f.options);
    for (const expected of f.expected) {
      const actual = candidates.find((c) => c.action === expected.action);
      assert.equal(actual.collision, expected.collision, expected.action);
      assert.ok(
        Math.abs(actual.physicalClearance - expected.physicalClearance) < 1e-7,
        expected.action,
      );
      assert.ok(
        Math.abs(actual.score - expected.score) < 1e-7,
        expected.action,
      );
      if (expected.closestHazard !== undefined) {
        assert.equal(
          actual.closestHazard,
          expected.closestHazard,
          expected.action,
        );
        assert.equal(actual.closestAt, expected.closestAt, expected.action);
      }
      assert.deepEqual(actual.path, expected.path, expected.action);
    }
  });
