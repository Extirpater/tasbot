import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { observeGame } from "../src/observe.js";
import { Navigation } from "../src/navigation.js";
import {
  bestAction,
  hazardActiveFrom,
  planActions,
  trajectoryClearance,
} from "../src/planner.js";

const state = () => ({
  packet: 100,
  tickRate: 60,
  player: { x: 100, y: 250, radius: 10, speed: 150 },
  area: {
    id: "switch-test",
    x: 0,
    y: 0,
    width: 1000,
    height: 500,
    zones: [{ x: 0, y: 0, width: 1000, height: 500, type: 0 }],
    walls: [],
  },
  hazards: [],
});

test("observer keeps harmless Switch bodies and countdowns without retaining unrelated harmless enemies", () => {
  const s = state();
  const enemy = { isEnemy: true, x: 300, y: 250, radius: 18, isHarmless: true };
  const gameState = {
    self: { entity: { ...s.player, deathTimer: -1 } },
    area: { ...s.area, zones: { list: () => s.area.zones } },
    entities: {
      1: {
        ...enemy,
        id: 1,
        entityType: 217,
        switchedHarmless: true,
        switchTime: 250,
      },
      2: { ...enemy, id: 2 },
      3: { ...enemy, id: 3, entityType: 217, switchedHarmless: true },
      4: {
        ...enemy,
        id: 4,
        entityType: 217,
        switchedHarmless: false,
        switchTime: 500,
      },
      5: {
        ...enemy,
        id: 5,
        switchedHarmless: true,
        switchTime: 100,
        removed: true,
      },
      6: { ...enemy, id: 6, switchedHarmless: true, switchTime: 300 },
      7: { ...enemy, id: 7, entityType: 207 },
    },
  };
  const element = { __reactFiber$test: { stateNode: { gameState } } };
  const result = vm.runInNewContext(`(${observeGame.toString()})()`, {
    performance: { now: () => 1000 },
    document: {
      querySelectorAll: () => [element],
      activeElement: { matches: () => false },
    },
  });
  assert.deepEqual(
    Array.from(result.hazards, (h) => h.id),
    [1, 3, 4, 6, 7],
  );
  assert.equal(result.hazards[0].harmlessUntilMs, 250);
  assert.equal(result.hazards[0].switchState.harmless, true);
  assert.equal(result.hazards[0].switchState.remainingMs, 250);
  assert.equal(hazardActiveFrom(result.hazards[1]), 0);
  assert.equal(hazardActiveFrom(result.hazards[2]), 0);
  assert.equal(result.hazards[3].harmlessUntilMs, 300);
  assert.equal(hazardActiveFrom(result.hazards[4]), 0);
});

test("a crossing is safe only if it finishes before Switch activation", () => {
  const p0 = { x: -20, y: 0 },
    p1 = { x: 20, y: 0 },
    h = { x: 0, y: 0 };
  const gap = (activeFrom) =>
    trajectoryClearance(p0, p1, h, h, { radius: 5, activeFrom }, 0, 1);
  assert.equal(gap(2), Infinity);
  assert.equal(gap(0.75), 5);
  assert.equal(gap(0.5), -5);
  assert.equal(gap(0), -5);
  assert.equal(gap(1), 15);
  assert.equal(hazardActiveFrom({ harmlessUntilMs: 250 }, 40), 0.225);
  assert.equal(hazardActiveFrom({ harmlessUntilMs: 10 }, 40), 0);
});

test("local collision checks account for Switch activation while preserving safe early crossings", () => {
  const s = state();
  s.hazards.push({
    id: 1,
    x: 170,
    y: 250,
    radius: 18,
    vx: 0,
    vy: 0,
    harmlessUntilMs: 2000,
  });
  const options = {
    reactionTime: 0,
    horizon: 0.6,
    segmentTime: 0.6,
    firstSegmentTime: 0.6,
  };
  const right = () => planActions(s, options).find((c) => c.action === "right");
  assert.equal(right().collision, false);
  s.hazards[0].harmlessUntilMs = 250;
  assert.ok(right().physicalClearance <= 0);
  // Pursuit bodies take a separate branch; harmlessness must apply there too.
  s.hazards[0].homing = {
    heading: Math.PI,
    speed: 30,
    turnRate: 1.5,
    range: 200,
  };
  s.hazards[0].harmlessUntilMs = 2000;
  assert.equal(right().collision, false);
  s.hazards[0].harmlessUntilMs = 250;
  assert.ok(right().physicalClearance <= 0);
});

test("coarse route costs include upcoming activation instead of treating harmless bodies as permanent barriers", () => {
  const s = state();
  s.area.zones.push({ x: 950, y: 0, width: 50, height: 500, type: 2 });
  s.hazards = [{ id: 1, x: 150, y: 250, vx: 0, vy: 0, radius: 18 }];
  const point = { x: 150, y: 250 };
  const lethal = new Navigation().update(s, 0).distanceAt(point, 0);
  s.hazards[0].harmlessUntilMs = 4000;
  const harmless = new Navigation().update(s, 0).distanceAt(point, 0);
  assert.ok(lethal > harmless + 10);
  s.hazards[0].harmlessUntilMs = 20;
  assert.ok(new Navigation().update(s, 0).distanceAt(point, 0) > harmless + 10);
});

test("Wacky 36 reconstruction rejects the blind approach before the turn becomes committed", () => {
  const f = JSON.parse(
    readFileSync(
      new URL("./fixtures/switch36-activation.json", import.meta.url),
    ),
  );
  const missing = planActions(f.state, f.options);
  assert.ok(missing.find((c) => c.action === f.originalAction).clearance > 0);
  // Hidden positions and the activation bracket are reconstructed, explicitly
  // labelled in the fixture. Vary the phase by a tick rather than claiming a
  // precise unrecorded countdown or full encounter survival.
  for (const ticks of [-1, 0, 1]) {
    const s = structuredClone(f.state);
    s.hazards.push(
      ...f.reconstructedHazards.map((h) => ({
        ...h,
        harmlessUntilMs: h.harmlessUntilMs + (ticks * 1000) / s.tickRate,
      })),
    );
    const candidates = planActions(s, f.options);
    assert.ok(
      candidates.find((c) => c.action === f.originalAction).clearance < 0,
    );
    const chosen = candidates.find((c) => c.action === bestAction(candidates));
    assert.notEqual(chosen.action, f.originalAction);
    assert.ok(chosen.clearance > 0);
  }
});
