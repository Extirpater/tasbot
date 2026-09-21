import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planActions } from "../src/planner.js";

test("Area 35 indexing preserves all recorded-reference collision results and plans", () => {
  const f = JSON.parse(
    readFileSync(new URL("./fixtures/dense-auras.json", import.meta.url)),
  );
  assert.equal(f.state.hazards.length, 100);
  assert.equal(f.state.auras.length, 22);
  const candidates = planActions(f.state, f.options);
  for (const expected of f.expected) {
    const actual = candidates.find((c) => c.action === expected.action);
    assert.equal(actual.collision, expected.collision, expected.action);
    assert.ok(
      Math.abs(actual.physicalClearance - expected.physicalClearance) < 1e-7,
      expected.action,
    );
    assert.ok(Math.abs(actual.score - expected.score) < 1e-7, expected.action);
    assert.deepEqual(actual.path, expected.path, expected.action);
  }
});

test("spatial bins retain fast enemies sweeping across a cell boundary", () => {
  const state = {
    tickRate: 60,
    player: { x: 125, y: 250, radius: 15, speed: 510 },
    area: {
      x: 0,
      y: 0,
      width: 1000,
      height: 500,
      zones: [{ x: 0, y: 0, width: 1000, height: 500, type: 0 }],
    },
    hazards: [
      { id: 1, x: 260, y: 250, radius: 18, vx: -15000, vy: 0, bounce: false },
    ],
  };
  const candidates = planActions(state, { reactionTime: 0, fastPath: false });
  assert.ok(candidates.every((c) => c.physicalClearance <= 0));
});

test("spatial bins retain a large ball whose center is several cells away", () => {
  const state = {
    tickRate: 60,
    player: { x: 900125, y: 250, radius: 15, speed: 510 },
    area: {
      x: 900000,
      y: 0,
      width: 2000,
      height: 500,
      zones: [{ x: 900000, y: 0, width: 2000, height: 500, type: 0 }],
    },
    hazards: [
      { id: 1, x: 900500, y: 250, radius: 400, vx: 0, vy: 0, bounce: false },
    ],
  };
  const candidates = planActions(state, { reactionTime: 0, fastPath: false });
  assert.ok(candidates.every((c) => c.physicalClearance <= 0));
});
