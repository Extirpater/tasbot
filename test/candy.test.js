import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { CandyPolicy } from "../src/candy.js";
import { KeyboardController } from "../src/controller.js";
import { observeGame } from "../src/observe.js";
import { planActions } from "../src/planner.js";

function state() {
  return {
    ready: true,
    player: {
      x: 120,
      y: 120,
      radius: 15,
      energy: 30,
      maxEnergy: 30,
      downed: false,
      candy: {
        level: 5,
        locked: false,
        disabled: false,
        cooldownMs: 0,
        energyCost: 5,
        active: false,
        remainingMs: 0,
        boost: 0,
      },
    },
    area: { zones: [{ x: 0, y: 0, width: 256, height: 480, type: 4 }] },
  };
}

test("Sweet Tooth starts in shelter, uses a short pulse, and awaits acknowledgement", () => {
  const s = state(),
    policy = new CandyPolicy();
  assert.deepEqual(policy.keys(s, "right", 0), ["x"]);
  s.player.candy.cooldownMs = 5000;
  assert.deepEqual(policy.keys(s, "right", 20), ["x"]);
  assert.deepEqual(policy.keys(s, "right", 51), []);
  s.player.candy.cooldownMs = 0; // Unchanged/stale observation is not a new cast.
  assert.deepEqual(policy.keys(s, "right", 100), []);
  Object.assign(s.player.candy, {
    active: true,
    remainingMs: 14000,
    boost: 150,
  });
  assert.deepEqual(policy.keys(s, "right", 1001), []);
});

test("Sweet Tooth refreshes before expiry and replenishes low energy while moving", () => {
  const s = state();
  s.area.zones = [];
  Object.assign(s.player.candy, {
    active: true,
    remainingMs: 3000,
    boost: 150,
  });
  assert.deepEqual(new CandyPolicy().keys(s, "right", 0), ["x"]);
  s.player.candy.remainingMs = 10000;
  s.player.energy = 14;
  assert.deepEqual(new CandyPolicy().keys(s, "right", 0), ["x"]);
  // Starting/changing speed inside a crowded lane must wait for shelter.
  s.player.candy.boost = 120;
  assert.deepEqual(new CandyPolicy().keys(s, "right", 0), []);
});

test("Sweet Tooth respects energy, cooldown, lock, death, focus, and pause", () => {
  for (const mutate of [
    (s) => (s.player.energy = 4),
    (s) => (s.player.candy.cooldownMs = 1),
    (s) => (s.player.candy.level = 0),
    (s) => (s.player.candy.locked = true),
    (s) => (s.player.candy.disabled = true),
    (s) => (s.player.downed = true),
    (s) => (s.ready = false),
    (s) => delete s.player.candy,
  ]) {
    const s = state();
    mutate(s);
    assert.deepEqual(new CandyPolicy().keys(s, "right", 0), []);
  }
  const s = state(),
    policy = new CandyPolicy();
  assert.deepEqual(policy.keys(s, "focus_right", 0), []);
  assert.deepEqual(policy.keys(s, "right", 10), ["x"]);
  policy.release();
  assert.deepEqual(policy.keys(s, "right", 20), []);
});

test("Candy key pulses preserve movement and release with the controller", async () => {
  const calls = [],
    keyboard = new KeyboardController({
      down: async (key) => calls.push(["down", key]),
      up: async (key) => calls.push(["up", key]),
    });
  await keyboard.set("right", ["x"]);
  await keyboard.set("right");
  assert.deepEqual(calls, [
    ["down", "ArrowRight"],
    ["down", "x"],
    ["up", "x"],
  ]);
  await keyboard.set("right", ["x"]);
  await keyboard.release();
  assert.equal(keyboard.held.size, 0);
  assert.deepEqual(calls.slice(-2), [
    ["up", "ArrowRight"],
    ["up", "x"],
  ]);
});

test("observer reads Sweet Tooth readiness and confirmed consumption", () => {
  const player = {
    id: 1,
    x: 100,
    y: 100,
    radius: 15,
    speed: 510,
    energy: 22,
    maxEnergy: 30,
    deathTimer: -1,
    sweetToothConsumed: true,
    sweetToothConsumedTime: 2700,
    sweetToothStatBoost: 150,
    abilityTwo: {
      abilityType: 106,
      level: 5,
      energyCost: 5,
      cooldown: 0,
      locked: false,
      disabled: false,
    },
  };
  const gameState = {
    self: { entity: player },
    packetNumber: 1,
    entities: {},
    area: { x: 0, y: 0, width: 1000, height: 500, zones: { list: () => [] } },
  };
  const element = {
    __reactFiber$test: { stateNode: { gameState, state: {} } },
  };
  const s = vm.runInNewContext(`(${observeGame.toString()})()`, {
    document: { querySelectorAll: () => [element] },
    performance: { now: () => 0 },
  });
  assert.equal(s.player.candy.cooldownMs, 0);
  assert.equal(s.player.candy.remainingMs, 2700);
  assert.equal(s.player.candy.boost, 150);
  assert.equal(s.player.candy.active, true);
  assert.equal(s.player.maxEnergy, 30);
  assert.equal(s.player.speedBonus, 150);
  assert.equal(s.player.speedBonusWithoutCandy, 0);
});

test("forecast stops using a Candy boost when its observed timer expires", () => {
  const s = {
    ready: true,
    tickRate: 60,
    packet: 1,
    player: {
      x: 100,
      y: 250,
      radius: 15,
      speed: 660,
      baseSpeed: 510,
      speedBonus: 150,
      speedBonusWithoutCandy: 0,
      candy: { active: true, remainingMs: 100 },
    },
    area: {
      id: "expiry",
      x: 0,
      y: 0,
      width: 1000,
      height: 500,
      zones: [{ x: 0, y: 0, width: 1000, height: 500, type: 0 }],
    },
    hazards: [],
  };
  const candidates = planActions(s, { reactionTime: 0 });
  assert.equal(candidates[0].action, "right");
  assert.ok(Math.abs(candidates[0].progress - (510 * 0.9 + 150 * 0.1)) < 1e-6);
});
