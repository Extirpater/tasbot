import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { observeGame, MotionTracker } from "../src/observe.js";
import {
  planActions,
  bestAction,
  guardAction,
  sweptClearance,
  targetFor,
  hazardPosition,
  reflectedPosition,
  ACTIONS,
  advancePlayer,
  predictHazardPath,
} from "../src/planner.js";
import { JevPolicy } from "../src/jev.js";
import {
  DecisionLoop,
  KeyboardController,
  installControls,
} from "../src/controller.js";
import { speedUpgradeKey } from "../src/upgrades.js";
import { InputTiming } from "../src/timing.js";
import { MovementPolicy } from "../src/movement.js";
import { Navigation } from "../src/navigation.js";

function state(overrides = {}) {
  return {
    ready: true,
    time: 1000,
    packet: 1,
    area: {
      id: "test:1",
      x: 0,
      y: 0,
      width: 1000,
      height: 500,
      zones: [
        { x: 0, y: 0, width: 1000, height: 500, type: 0 },
        { x: 960, y: 0, width: 40, height: 500, type: 2 },
      ],
    },
    player: { x: 100, y: 250, radius: 10, speed: 150, downed: false },
    hazards: [],
    ...overrides,
  };
}

test("swept collision detects hazards crossing between frames", () => {
  const p = { x: 0, y: 0 };
  assert.equal(
    sweptClearance(p, p, { x: -100, y: 0 }, { x: 100, y: 0 }, 10),
    -10,
  );
});

test("open corridor advances, incoming collision overrides a model choice", () => {
  assert.equal(bestAction(planActions(state())), "right");
  const candidates = planActions(
    state({ hazards: [{ id: 1, x: 150, y: 250, radius: 12, vx: -60, vy: 0 }] }),
  );
  assert.ok(candidates.find((c) => c.action === "right").collision);
  assert.notEqual(guardAction("right", candidates), "right");
  assert.equal(
    guardAction("not_an_action", candidates),
    bestAction(candidates),
  );
});

test("chooses forward exit using the configured heading", () => {
  const s = state();
  s.area.zones.push({ x: 0, y: 0, width: 40, height: 500, type: 2 });
  assert.equal(targetFor(s, "right").x, 980);
  assert.equal(targetFor(s, "left").x, 20);
});

test("velocity estimates survive repeat reads but reset on area transitions", () => {
  const tracker = new MotionTracker();
  const s = state({ hazards: [{ id: 1, x: 100, y: 100, radius: 10 }] });
  tracker.update(s);
  const moved = {
    ...s,
    packet: 2,
    time: 1100,
    hazards: [{ ...s.hazards[0], x: 120 }],
  };
  assert.ok(Math.abs(tracker.update(moved).hazards[0].vx - 200) < 0.001);
  assert.equal(tracker.update({ ...moved, time: 1150 }).hazards[0].vx, 200);
  assert.equal(
    tracker.update({ ...moved, area: { ...s.area, id: "test:2" } }).hazards[0]
      .vx,
    0,
  );
});

test("observer finds React component state and excludes currently harmless enemies", () => {
  const gameState = {
    self: {
      entity: { id: 1, x: 100, y: 200, radius: 10, speed: 150, deathTimer: -1 },
    },
    packetNumber: 5,
    sequence: 12,
    previousKeys: { get: () => [10, 19] },
    mouseDown: { x: 239, y: -4 },
    keys: { get: () => [4, 5] },
    serverTickRate: 60,
    area: {
      x: 0,
      y: 0,
      width: 1000,
      height: 500,
      index: 1,
      regionName: "test",
      zones: { list: () => [] },
    },
    entities: {
      1: { id: 1, isPlayer: true, x: 100, y: 200 },
      2: {
        id: 2,
        isEnemy: true,
        x: 150,
        y: 200,
        radius: 10,
        velocityX: -3,
        velocityY: 2,
        trackDashDirection() {},
        _pred: { dashDirX: -1, dashDirY: 0 },
        dashSpeed: 300,
        timePreparing: 740,
        effects: { list: () => [{ effectType: 48, radius: 150 }] },
      },
      3: { id: 3, isEnemy: true, isHarmless: true, x: 200, y: 200 },
      4: { wall: true, x: 0, y: -2000, width: 1000, height: 2000 },
      5: { wall: true, x: 400, y: 100, width: 30, height: 100, texture: 1 },
      6: { id: 6, isPlayer: true, x: 240, y: 180, radius: 15, deathTimer: -1 },
    },
  };
  const element = {
    __reactFiber$test: {
      return: { stateNode: { gameState, state: { menuState: 0 } } },
    },
  };
  const result = vm.runInNewContext(`(${observeGame.toString()})()`, {
    document: {
      querySelectorAll: () => [element],
      activeElement: { matches: () => false },
    },
    performance: { now: () => 1000 },
  });
  assert.equal(result.ready, true);
  assert.equal(result.input.sentSequence, 12);
  assert.deepEqual(Array.from(result.input.sentKeys), [10, 19]);
  assert.equal(result.hazards.length, 1);
  assert.ok(!result.hazards.some((h) => h.id === 3));
  assert.equal(result.hazards[0].id, 2);
  assert.equal(result.otherPlayers.length, 1);
  assert.equal(result.otherPlayers[0].id, 6);
  assert.equal(result.otherPlayers[0].downed, false);
  assert.equal(result.otherPlayers[0].areaId, result.area.id);
  assert.equal(result.otherPlayers[0].rescueable, true);
  assert.equal(result.hazards[0].vx, -180);
  assert.equal(result.hazards[0].vy, 120);
  assert.equal(result.hazards[0].bounce, true);
  assert.equal(result.hazards[0].dash.peak, 300);
  assert.equal(result.hazards[0].dash.preparing, 740);
  assert.equal(result.auras[0].type, 48);
  assert.equal(result.auras[0].reduction, 0.3);
  assert.equal(result.player.baseSpeed, 150);
  assert.equal(result.player.mouseInput.x, 239);
  assert.equal(result.player.mouseInput.y, -4);
  assert.deepEqual(Array.from(result.input.heldKeys), [4, 5]);
  assert.equal(result.player.vx, undefined);
  assert.equal(result.player.downed, false);
  assert.equal(result.area.walls.length, 1);
  assert.equal(result.area.walls[0].x, 400);
  gameState.spectating = true;
  assert.equal(
    vm.runInNewContext(`(${observeGame.toString()})()`, {
      document: { querySelectorAll: () => [element] },
    }).ready,
    false,
  );
});

test("missing velocity uses server packet time instead of browser sampling jitter", () => {
  const tracker = new MotionTracker();
  const s = state({
    tickRate: 60,
    hazards: [{ id: 1, x: 100, y: 100, radius: 10 }],
  });
  tracker.update(s);
  const moved = {
    ...s,
    packet: 4,
    time: 1040,
    hazards: [{ ...s.hazards[0], x: 107.5 }],
  };
  assert.equal(tracker.update(moved).hazards[0].vx, 150);
});

test("ability speed bonuses are included before Shift halves the predicted speed", () => {
  const player = {
    id: 1,
    x: 100,
    y: 200,
    radius: 15,
    speed: 315,
    totalSpeed: 232.5,
    deathTimer: -1,
    nightActivated: true,
    abilityOne: { abilityType: 61, level: 5 },
  };
  const gameState = {
    self: { entity: player },
    packetNumber: 1,
    serverTickRate: 60,
    entities: {},
    area: { x: 0, y: 0, width: 1000, height: 500, zones: { list: () => [] } },
  };
  const element = {
    __reactFiber$test: { stateNode: { gameState, state: {} } },
  };
  const observe = () =>
    vm.runInNewContext(`(${observeGame.toString()})()`, {
      document: { querySelectorAll: () => [element] },
      performance: { now: () => 0 },
    });
  let s = observe();
  assert.equal(s.player.speedBonus, 150);
  assert.equal(
    advancePlayer(s.player, "focus_right", s.player, s.area).vx,
    232.5,
  );
  player.nightActivated = false;
  player.inStreamPath = true;
  player.streamPathSpeedBoost = 150;
  player.isBurning = true;
  s = observe();
  assert.equal(
    advancePlayer(s.player, "right", s.player, s.area, 1 / 60, 0.3).vx,
    465,
  );
  player.inStreamPath = false;
  player.isBurning = false;
  player.streamPathSpeedBoost = 0;
  player.effects = { list: () => [{ effectType: 0 }] };
  player.abilityOne = { abilityType: 29, level: 4 };
  assert.equal(observe().player.speedBonus, 150);
});

test("enemy tick displacement is converted using the negotiated server rate", () => {
  const gameState = {
    self: {
      entity: { id: 1, x: 100, y: 200, radius: 15, speed: 150, deathTimer: -1 },
    },
    serverTickRate: 30,
    packetNumber: 1,
    area: { x: 0, y: 0, width: 1000, height: 500, zones: { list: () => [] } },
    entities: {
      2: {
        id: 2,
        isEnemy: true,
        x: 200,
        y: 200,
        radius: 20,
        velocityX: 4,
        velocityY: -2,
        _pred: { vx: 1, vy: -0.5 },
      },
    },
  };
  const element = {
    __reactFiber$test: { stateNode: { gameState, state: {} } },
  };
  const result = vm.runInNewContext(`(${observeGame.toString()})()`, {
    document: { querySelectorAll: () => [element] },
    performance: { now: () => 1000 },
  });
  assert.equal(result.hazards[0].vx, 30); // Predicted motion includes slow/freeze effects.
  assert.equal(result.hazards[0].vy, -15);
  assert.equal(result.player.speed, 150); // Player speed is already per second.
});

test("bounce prediction includes radius and multiple wall reflections", () => {
  assert.equal(reflectedPosition(90, 40, 1, 0, 100), 70);
  assert.equal(reflectedPosition(10, -40, 1, 0, 100), 30);
  assert.equal(reflectedPosition(10, 1000, 1, 0, 100), 10);
  const s = state();
  const ball = { x: 950, y: 200, vx: 200, vy: 0, radius: 20, bounce: true };
  assert.equal(hazardPosition(ball, s.area, 0.5).x, 910);
  assert.equal(hazardPosition({ ...ball, bounce: false }, s.area, 0.5).x, 1050);
});

test("dodges a ball returning from the wall instead of assuming it travels offscreen", () => {
  const s = state({
    player: { x: 910, y: 250, radius: 15, speed: 150 },
    hazards: [{ x: 960, y: 250, radius: 20, vx: 240, vy: 0, bounce: true }],
  });
  const candidates = planActions(s, { reactionTime: 0.05 });
  assert.ok(candidates.find((c) => c.action === "stay").collision);
  const chosen = candidates.find((c) => c.action === bestAction(candidates));
  assert.ok(chosen.physicalClearance > 0); // Escape remains possible inside the larger uncertainty buffer.
  assert.ok(chosen.action.includes("up") || chosen.action.includes("down"));
});

test("escaping an existing safety margin beats driving farther into a ball", () => {
  const s = state({
    hazards: [{ x: 137, y: 250, radius: 20, vx: 0, vy: 0, bounce: false }],
  });
  const candidates = planActions(s, { reactionTime: 0 });
  const chosen = candidates.find((c) => c.action === bestAction(candidates));
  assert.ok(chosen.physicalClearance > 0);
  assert.notEqual(chosen.action, "right");
});

test("models actual per-axis keyboard speed and rejects thin intervening walls", () => {
  assert.equal(ACTIONS.up_right.dx, 1);
  assert.equal(ACTIONS.up_right.dy, -1);
  const s = state();
  s.area.walls = [{ x: 120, y: 220, width: 1, height: 60 }];
  const candidates = planActions(s);
  assert.ok(candidates.find((c) => c.action === "right").collision);
  assert.notEqual(bestAction(candidates), "right");
});

test("plans a turn around a barrier that no straight forward path clears", () => {
  const s = state();
  s.player.speed = 300;
  s.area.walls = [{ x: 170, y: 195, width: 20, height: 110 }];
  const straight = planActions(s, { segmentTime: 0.9, reactionTime: 0 });
  const turning = planActions(s, { reactionTime: 0 });
  const best = turning.find((c) => c.action === bestAction(turning));
  assert.ok(!best.collision);
  assert.ok(new Set(best.path).size > 1);
  assert.ok(best.progress > 150);
  assert.ok(
    best.progress >
      straight.find((c) => c.action === bestAction(straight)).progress + 50,
  );
});

test("wall balls turn around either direction of a perimeter corner", () => {
  const area = state().area;
  const h = { x: 975, y: 20, radius: 20, vx: 330, vy: 0, motion: "perimeter" };
  // The first tick clamps at the corner; it cannot spend its remaining 0.5
  // units on the next edge. Rotation takes effect on the following tick.
  assert.deepEqual(hazardPosition(h, area, 1 / 60), { x: 980, y: 20 });
  assert.deepEqual(hazardPosition(h, area, 2 / 60), { x: 980, y: 25.5 });
  assert.deepEqual(hazardPosition({ ...h, x: 25, vx: -330 }, area, 2 / 60), {
    x: 20,
    y: 25.5,
  });
});

test("focus halves movement, friction retains momentum, and safe-zone speed ends at its boundary", () => {
  const s = state();
  s.player.baseSpeed = 150;
  const full = advancePlayer(s.player, "right", s.player, s.area);
  const focused = advancePlayer(s.player, "focus_right", s.player, s.area);
  assert.equal(focused.x - s.player.x, (full.x - s.player.x) / 2);
  s.area.zones[0].friction = 0.25;
  const drifting = advancePlayer(
    { ...s.player, vx: 150 },
    "stay",
    s.player,
    s.area,
  );
  assert.equal(drifting.vx, 112.5);
  const reversing = advancePlayer(
    { ...s.player, vx: 150 },
    "left",
    s.player,
    s.area,
  );
  assert.equal(reversing.vx, -37.5);
  s.player.speed = 300; // Current minimum speed in refuge, base remains 150.
  assert.equal(advancePlayer(s.player, "right", s.player, s.area).vx, 150);
  assert.equal(
    advancePlayer(s.player, "right", s.player, s.area, 1 / 60, 0.7).vx,
    105,
  );
});

test("enters the exit instead of postponing its last movement indefinitely", () => {
  const s = state();
  Object.assign(s.player, { x: 880, speed: 390 });
  s.hazards = [{ x: 700, y: 250, radius: 20, vx: 0, vy: 0 }];
  assert.equal(bestAction(planActions(s)), "right");
});

test("speed upgrades require a live, fully sheltered player with points", () => {
  const s = state();
  Object.assign(s.player, { baseSpeed: 150, upgradePoints: 4 });
  assert.equal(speedUpgradeKey(s), null);
  s.area.zones.unshift({ x: 0, y: 0, width: 200, height: 500, type: 4 });
  assert.equal(speedUpgradeKey(s), "1");
  s.player.baseSpeed = 510;
  assert.equal(speedUpgradeKey(s), null);
  s.player.baseSpeed = 300;
  assert.equal(speedUpgradeKey(s), "1");
  s.player.y = s.player.radius - 0.001;
  assert.equal(speedUpgradeKey(s), "1"); // Telemetry can sit a fraction below the boundary.
  assert.equal(speedUpgradeKey(s, 300), null);
  assert.equal(speedUpgradeKey(s, 450), "1");
  s.player.baseSpeed = 295;
  assert.equal(speedUpgradeKey(s, 300), null); // Do not overshoot the cap by one upgrade.
  s.player.baseSpeed = 150;
  s.player.downed = true;
  assert.equal(speedUpgradeKey(s), null);
});

test("maximum speed advances without Shift on a clear route, even after focus", () => {
  const s = state();
  Object.assign(s.player, { baseSpeed: 510, speed: 255 });
  const candidates = planActions(s, { previousAction: "focus_right" });
  assert.equal(bestAction(candidates), "right");
  assert.equal(candidates[0].fastPath, true);
  assert.equal(guardAction("focus_right", candidates), "right");
});

function route(action, score, overrides = {}) {
  return {
    action,
    score,
    clearance: 25,
    physicalClearance: 50,
    collision: false,
    blocked: false,
    progress: 200,
    ...overrides,
  };
}

test("safe discretionary turns wait for an in-flight input before changing again", () => {
  const movement = new MovementPolicy();
  movement.observe(state(), 0, 150);
  movement.record("up_right", 0);
  const candidates = [route("up_right", 200), route("down_right", 300)];
  assert.equal(movement.select(candidates, undefined, 110), "up_right");
  assert.equal(movement.reason, "let input arrive");
  assert.equal(movement.select(candidates, undefined, 151), "down_right");
});

test("input settling never blocks a dangerous route override or a scheduled turn", () => {
  const movement = new MovementPolicy();
  movement.observe(state(), 0, 200);
  movement.select(
    [route("up_right", 200, { firstDuration: 0.05 })],
    undefined,
    0,
  );
  movement.record("up_right", 0);
  assert.equal(
    movement.select(
      [
        route("up_right", 200, {
          physicalClearance: -1,
          clearance: -10,
          collision: true,
        }),
        route("down_right", 300),
      ],
      undefined,
      25,
    ),
    "down_right",
  );
  assert.equal(movement.reason, "safety override");
  assert.equal(
    movement.select(
      [
        route("up_right", 200),
        route("down_right", 300, { continuedPlan: true }),
      ],
      undefined,
      75,
    ),
    "down_right",
  );
});

test("small alternating route advantages do not reverse a committed dodge", () => {
  const movement = new MovementPolicy();
  movement.record("up_right", 0);
  for (let at = 17; at < 1000; at += 17) {
    const candidates = [
      route("up_right", 200),
      route("down_right", 200 + (Math.floor(at / 17) % 2 ? 15 : -15)),
    ];
    const action = movement.select(candidates, undefined, at);
    assert.equal(action, "up_right");
    movement.record(action, at);
  }
  assert.equal(movement.age(1000), 1000);
  assert.equal(
    movement.select(
      [route("up_right", 200), route("down_right", 280)],
      undefined,
      1000,
    ),
    "down_right",
  );
});

test("a short dodge completes before switching to a more profitable safe route", () => {
  const movement = new MovementPolicy();
  movement.record("up_right", 0);
  const candidates = [route("up_right", 150), route("right", 250)];
  assert.equal(movement.planOptions(50).fastPath, false);
  assert.equal(movement.select(candidates, undefined, 50), "up_right");
  assert.equal(movement.select(candidates, undefined, 101), "right");
});

test("a fresh predicted collision interrupts a dodge without waiting for its commitment", () => {
  const s = state({
    player: { x: 100, y: 250, radius: 10, speed: 510 },
    hazards: [{ x: 145, y: 250, radius: 15, vx: 0, vy: 0 }],
  });
  const movement = new MovementPolicy();
  movement.record("right", 0);
  const candidates = planActions(s, {
    ...movement.planOptions(10),
    reactionTime: 0,
  });
  assert.ok(
    candidates.find((c) => c.action === "right").physicalClearance <= 0,
  );
  const action = movement.select(candidates, undefined, 10);
  assert.notEqual(action, "right");
  assert.ok(candidates.find((c) => c.action === action).physicalClearance > 0);
  assert.equal(movement.reason, "safety override");
});

test("new walls and deteriorating clearance also override commitment", () => {
  for (const unsafe of [
    { blocked: true, collision: true },
    { clearance: -12, physicalClearance: 14, collision: true },
  ]) {
    const movement = new MovementPolicy();
    movement.record("up_right", 0);
    const action = movement.select(
      [route("up_right", 200, unsafe), route("down_right", 250)],
      undefined,
      10,
    );
    assert.equal(action, "down_right");
    assert.equal(movement.reason, "safety override");
  }
});

test("commitment releases Shift immediately on a clear full-speed forward route", () => {
  const movement = new MovementPolicy();
  movement.record("focus_up_right", 0);
  const s = state();
  Object.assign(s.player, { baseSpeed: 510, speed: 255 });
  const candidates = planActions(s, movement.planOptions(10));
  assert.equal(movement.select(candidates, "focus_up_right", 10), "right");
  assert.equal(candidates[0].fastPath, true);
});

test("pause and area reset discard the previous movement commitment", () => {
  const movement = new MovementPolicy();
  movement.record("up_right", 0);
  movement.reset();
  assert.equal(movement.planOptions(10).previousAction, "stay");
  assert.equal(
    movement.select([route("stay", 10), route("right", 20)], undefined, 10),
    "right",
  );
});

test("wall-clamped commands have no useful first movement even if later turns promise progress", () => {
  const s = state();
  s.player.y = s.area.height - s.player.radius;
  s.hazards = [{ x: 300, y: 450, radius: 10, vx: 0, vy: 0 }];
  const candidates = planActions(s, {
    previousAction: "focus_down",
    fastPath: false,
    reactionTime: 0,
  });
  const down = candidates.find((c) => c.action === "focus_down");
  assert.equal(down.ineffective, true);
  assert.equal(down.firstMovement, 0);
  assert.ok(down.progress > 0); // That later progress must not justify holding down.
  assert.ok(candidates.find((c) => c.action === "right").firstMovement > 4);
});

test("a stalled player takes a checked escape instead of preserving a near-tied stationary route", () => {
  const movement = new MovementPolicy();
  movement.record("focus_down", 0);
  const s = state();
  movement.observe(s, 0);
  movement.observe({ ...s, packet: 2 }, 450);
  assert.equal(movement.stalled, true);
  const candidates = [
    route("focus_down", 200, { firstMovement: 0, ineffective: true }),
    route("focus_right", 195, { firstMovement: 25 }),
  ];
  assert.equal(movement.select(candidates, "focus_down", 450), "focus_right");
  assert.equal(movement.reason, "escape stall");
  candidates[1].collision = true;
  candidates[1].physicalClearance = -2;
  assert.equal(movement.select(candidates, "focus_down", 451), "focus_down");
  movement.reset();
  assert.equal(movement.stalled, false);
});

test("route awareness backs out of a deep pocket whose opening is beyond the local horizon", () => {
  const s = state();
  Object.assign(s.player, { x: 560, speed: 300 });
  s.area.walls = [
    { x: 280, y: 120, width: 440, height: 20 },
    { x: 700, y: 120, width: 20, height: 260 },
    { x: 280, y: 360, width: 440, height: 20 },
  ];
  const navigation = new Navigation();
  const routeMap = navigation.update(s, 0);
  assert.ok(routeMap.waypoint.x < s.player.x);
  assert.equal(routeMap.direct, false);
  const candidates = planActions(s, { navigation: routeMap, reactionTime: 0 });
  const chosen = candidates.find((c) => c.action === bestAction(candidates));
  assert.ok(ACTIONS[chosen.action].dx < 0);
  assert.equal(chosen.collision, false);
  assert.ok(chosen.progress > 0);
  assert.ok(chosen.exitProgress < 0); // Temporary retreat is progress along the escape route.
});

test("route planning notices a crowded lane beyond the immediate dodge horizon", () => {
  const s = state();
  Object.assign(s.player, { x: 100, y: 430, speed: 300 });
  s.hazards = [550, 730].map((x) => ({
    x,
    y: 360,
    radius: 120,
    vx: 0,
    vy: 0,
    bounce: false,
  }));
  const navigation = new Navigation();
  const routeMap = navigation.update(s, 0);
  assert.ok(routeMap.waypoint.y < s.player.y - 36);
  assert.equal(routeMap.direct, false);
  assert.equal(navigation.update({ ...s, packet: 2 }, 100), routeMap);
  navigation.reset();
  assert.equal(navigation.route, undefined);
});

test("a dasher preparing to launch is predicted moving even when currently nearly stopped", () => {
  const s = state();
  const h = {
    x: 200,
    y: 250,
    radius: 12,
    vx: 0,
    vy: 0,
    dash: { preparing: 740, dashing: 0, resting: 0, peak: 210, dx: -1, dy: 0 },
  };
  const path = predictHazardPath(h, s.area, 30, 1 / 60);
  assert.ok(path[1].x < 197);
  assert.ok(path[30].x < 110);
  assert.equal(path[30].y, 250);
  const paused = predictHazardPath(
    { ...h, dash: { ...h.dash, scale: 0 } },
    s.area,
    30,
    1 / 60,
  );
  assert.equal(paused[30].x, 200);
});

test("forward shortcut is rejected when a stopped dasher launches into that route", () => {
  const s = state();
  s.player.speed = 510;
  s.hazards = [
    {
      x: 410,
      y: 250,
      radius: 15,
      vx: 0,
      vy: 0,
      dash: {
        preparing: 740,
        dashing: 0,
        resting: 0,
        peak: 300,
        dx: -1,
        dy: 0,
      },
    },
  ];
  const candidates = planActions(s);
  assert.ok(candidates.length > 1);
  assert.notEqual(bestAction(candidates), "right");
  assert.ok(
    !candidates.find((c) => c.action === bestAction(candidates)).collision,
  );
});

test("recorded stationary dasher makes the fatal downward command unsafe", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/stopped-dasher.json", import.meta.url),
      "utf8",
    ),
  );
  const h = fixture.state.hazards.find((h) => h.id === fixture.hazardId);
  const path = predictHazardPath(
    h,
    fixture.state.area,
    fixture.observedStationaryTicks,
    1 / 60,
  );
  assert.ok(path.every((p) => p.x === h.x && p.y === h.y));
  const candidates = planActions(fixture.state, fixture.options);
  const fatal = candidates.find((c) => c.action === fixture.recordedAction);
  assert.ok(fixture.oldPredictedClearance > 0);
  assert.ok(fatal.physicalClearance < 0);
  assert.equal(fatal.closestHazard, fixture.hazardId);
  const movement = new MovementPolicy();
  movement.record(fixture.recordedAction, 0);
  const action = movement.select(candidates, fixture.recordedAction, 20);
  assert.notEqual(action, fixture.recordedAction);
  assert.ok(candidates.find((c) => c.action === action).physicalClearance > 0);
  assert.equal(movement.reason, "safety override");
});

test("a stopped dasher keeps advancing its phase and resumes when the stop expires", () => {
  const s = state();
  const h = {
    x: 400,
    y: 250,
    radius: 18,
    vx: 0,
    vy: 0,
    dash: {
      preparing: 740,
      dashing: 0,
      resting: 0,
      peak: 510,
      dx: 1,
      dy: 0,
      scale: 0,
    },
    motionEffects: [{ name: "sugarRushTimeLeft", scale: 0, remainingMs: 100 }],
  };
  const path = predictHazardPath(h, s.area, 12, 1 / 60);
  for (const point of path.slice(0, 7)) assert.equal(point.x, 400);
  assert.ok(path[7].x > 407);
  assert.ok(path[12].x > 440);
});

test("ordinary enemies remain stopped until overlapping stop timers expire", () => {
  const s = state();
  const h = {
    x: 200,
    y: 250,
    radius: 18,
    vx: 0,
    vy: 0,
    baseVx: 120,
    baseVy: 0,
    motionEffects: [
      { name: "sugarRushTimeLeft", scale: 0, remainingMs: 50 },
      { name: "stompedStunTime", scale: 0, remainingMs: 100 },
    ],
  };
  const path = predictHazardPath(h, s.area, 18, 1 / 60);
  assert.equal(path[6].x, 200);
  assert.ok(Math.abs(path[18].x - 224) < 1e-6);
  h.vx = 30;
  h.motionEffects = [
    { name: "vengeanceTimeLeft", scale: 0.25, remainingMs: 100 },
  ];
  const slowed = predictHazardPath(h, s.area, 12, 1 / 60);
  assert.ok(Math.abs(slowed[6].x - 203) < 1e-6);
  assert.ok(Math.abs(slowed[12].x - 215) < 1e-6);
});

test("observer retains timed Sugar Rush stops for dashers and their auras", () => {
  const enemy = {
    id: 2,
    isEnemy: true,
    x: 400,
    y: 250,
    radius: 18,
    velocityX: -1.7,
    velocityY: 0,
    _pred: { vx: 0, vy: 0, dashDirX: -1, dashDirY: 0 },
    trackDashDirection() {},
    dashSpeed: 510,
    timePreparing: 100,
    sugarRushTimeLeft: 800,
    effects: { list: () => [{ effectType: 48, radius: 150 }] },
  };
  const gameState = {
    self: {
      entity: { id: 1, x: 100, y: 250, radius: 15, speed: 510, deathTimer: -1 },
    },
    packetNumber: 1,
    serverTickRate: 60,
    entities: { 2: enemy },
    area: { x: 0, y: 0, width: 1000, height: 500, zones: { list: () => [] } },
  };
  const element = {
    __reactFiber$test: { stateNode: { gameState, state: {} } },
  };
  const s = vm.runInNewContext(`(${observeGame.toString()})()`, {
    document: { querySelectorAll: () => [element] },
    performance: { now: () => 0 },
  });
  assert.equal(s.hazards.length, 1); // A stop must not silently remove a potentially lethal enemy.
  assert.equal(s.hazards[0].dash.scale, 0);
  assert.equal(s.hazards[0].motionEffects[0].remainingMs, 800);
  assert.equal(s.hazards[0].motionEffects[0].name, "sugarRushTimeLeft");
  assert.equal(s.auras[0].motionEffects[0].remainingMs, 800);
  assert.equal(s.hazards[0].baseVx, -102);
});

test("model cannot choose waiting or Shift when a clear full-speed route advances faster", () => {
  const candidates = [
    {
      action: "right",
      collision: false,
      clearance: 35,
      progress: 300,
      score: 220,
    },
    {
      action: "focus_right",
      collision: false,
      clearance: 50,
      progress: 150,
      score: 125,
    },
    {
      action: "stay",
      collision: false,
      clearance: 100,
      progress: 0,
      score: 60,
    },
  ];
  assert.equal(guardAction("focus_right", candidates), "right");
  assert.equal(guardAction("stay", candidates), "right");
});

test("queued movement is unavoidable until a new input can take effect", () => {
  const s = state();
  s.player.speed = 450;
  s.hazards = [{ x: 180, y: 250, radius: 20, vx: 0, vy: 0 }];
  const immediate = planActions(s, { reactionTime: 0, maxSpeed: 510 });
  assert.ok(immediate.some((c) => !c.collision));
  const queued = planActions(s, {
    reactionTime: 0.2,
    maxSpeed: 510,
    previousAction: "stay",
    pendingInputs: [{ time: 0, action: "right" }],
  });
  assert.ok(queued.every((c) => c.physicalClearance <= 0));
});

test("pending input history preserves old turns and pause resets it", () => {
  const timing = new InputTiming();
  timing.record("right", 1000);
  timing.record("up", 1100);
  timing.record("focus_left", 1200);
  assert.deepEqual(timing.pending(1200), {
    reactionTime: 0.15,
    pendingInputs: [
      { time: 0, action: "right" },
      { time: 0.05, action: "up" },
      { time: 0.15, action: "focus_left" },
    ],
  });
  timing.reset();
  assert.equal(timing.actionAt(1200), "stay");
  assert.equal(timing.samples, 0);
});

test("delay fitting detects 125ms lag despite distant auras in the same area", () => {
  const timing = new InputTiming();
  const sequence = ["right", "up", "left", "down"];
  const directions = {
    right: [1, 0],
    up: [0, -1],
    left: [-1, 0],
    down: [0, 1],
  };
  let x = 500,
    y = 250;
  for (let at = 0; at <= 3000; at += 25) {
    const active =
      at >= 125 ? sequence[Math.floor((at - 125) / 200) % 4] : "stay";
    const [dx, dy] = directions[active] ?? [0, 0];
    // 40 Hz telemetry, no friction. Advance from the keys 125 ms earlier.
    x += (dx * 150) / 40;
    y += (dy * 150) / 40;
    const s = state({
      packet: at / 25,
      tickRate: 40,
      time: at,
      auras: [{ x: 900, y: 450, auraRadius: 150, vx: 0, vy: 0 }],
    });
    s.player = { ...s.player, x, y, vx: dx * 150, vy: dy * 150 };
    timing.observe(s, at);
    timing.record(sequence[Math.floor(at / 200) % 4], at);
  }
  assert.ok(timing.samples >= 12);
  assert.equal(timing.delayMs, 125);
});

test("delay fitting skips nearby auras with unknown slow parameters", () => {
  const timing = new InputTiming();
  timing.record("right", 0);
  timing.record("up", 300);
  const s = state({
    packet: 16,
    tickRate: 40,
    auras: [{ x: 120, y: 250, auraRadius: 150, vx: 0, vy: 0 }],
  });
  timing.observe(s, 400);
  timing.observe({ ...s, packet: 17, player: { ...s.player, x: 103.75 } }, 425);
  assert.equal(timing.samples, 0);
});

function controlsHarness() {
  const listeners = {},
    documentListeners = {},
    events = [];
  let now = 0,
    watchdog;
  class Element {
    closest() {
      return this.typing;
    }
  }
  const window = {
    addEventListener: (name, fn) => {
      listeners[name] = fn;
    },
    removeEventListener: (name) => delete listeners[name],
    dispatchEvent: (e) => events.push(e),
  };
  const document = {
    hidden: false,
    body: { append() {} },
    createElement: () => ({
      style: {},
      addEventListener() {},
      remove() {},
      blur() {},
    }),
    addEventListener: (name, fn) => {
      documentListeners[name] = fn;
    },
    removeEventListener: (name) => delete documentListeners[name],
  };
  const originalGlobals = Object.keys(window);
  const controls = vm.runInNewContext(
    `(${installControls.toString()})(() => ({ ready: false }))`,
    {
      window,
      document,
      Element,
      performance: { now: () => now },
      setInterval: (fn) => {
        watchdog = fn;
        return 1;
      },
      clearInterval: () => {
        watchdog = undefined;
      },
      KeyboardEvent: class {
        constructor(type, data) {
          Object.assign(this, { type }, data);
        }
      },
    },
  );
  assert.deepEqual(Object.keys(window), originalGlobals);
  const target = new Element();
  const event = {
    code: "KeyP",
    target,
    shiftKey: true,
    preventDefault() {},
    stopImmediatePropagation() {},
  };
  return {
    controls,
    listeners,
    documentListeners,
    document,
    events,
    target,
    event,
    advance(ms) {
      now += ms;
      watchdog?.();
    },
    hasWatchdog() {
      return Boolean(watchdog);
    },
  };
}

test("batched input keeps held keys, repairs missing keys, and releases reversals once", () => {
  const h = controlsHarness();
  h.listeners.keydown(h.event);
  const { epoch } = h.controls.read().control;
  assert.equal(
    h.controls.apply(epoch, true, ["Shift", "ArrowUp", "ArrowRight"], [])
      .changes,
    3,
  );
  h.events.length = 0;
  assert.equal(
    h.controls.apply(
      epoch,
      true,
      ["Shift", "ArrowUp", "ArrowRight"],
      ["Shift", "ArrowUp", "ArrowRight"],
    ).changes,
    0,
  );
  assert.equal(
    h.controls.apply(
      epoch,
      true,
      ["ArrowDown", "ArrowLeft"],
      ["Shift", "ArrowUp", "ArrowRight"],
    ).changes,
    5,
  );
  assert.deepEqual(
    h.events.map((e) => [e.type, e.key]),
    [
      ["keyup", "Shift"],
      ["keyup", "ArrowUp"],
      ["keyup", "ArrowRight"],
      ["keydown", "ArrowDown"],
      ["keydown", "ArrowLeft"],
    ],
  );
  assert.ok(
    h.events
      .filter((e) => e.type === "keydown")
      .every((e) => !e.shiftKey && !e.repeat),
  );
  h.events.length = 0;
  h.controls.apply(epoch, true, ["ArrowDown", "ArrowLeft"], ["ArrowLeft"]);
  assert.deepEqual(
    h.events.map((e) => [e.type, e.key]),
    [
      ["keyup", "ArrowDown"],
      ["keydown", "ArrowDown"],
    ],
  );
});

test("batched input rejects a pause between planning and applying, including candy", () => {
  const h = controlsHarness();
  h.listeners.keydown(h.event);
  const { epoch } = h.controls.read().control;
  h.controls.apply(epoch, true, ["ArrowRight", "x"], []);
  h.listeners.keydown(h.event);
  h.events.length = 0;
  assert.equal(
    h.controls.apply(epoch, true, ["ArrowDown", "x"], ["ArrowRight"]).active,
    false,
  );
  assert.ok(h.events.every((e) => e.type === "keyup"));
  h.listeners.keydown(h.event);
  h.events.length = 0;
  assert.equal(h.controls.apply(epoch, true, ["ArrowDown"], []).active, false);
  assert.equal(h.events.length, 0);
});

test("batched input pauses if chat gains focus while planning", () => {
  const h = controlsHarness();
  h.listeners.keydown(h.event);
  const { epoch } = h.controls.read().control;
  h.document.activeElement = { matches: () => true };
  assert.equal(h.controls.apply(epoch, true, ["ArrowRight"], []).active, false);
  assert.equal(h.controls.read().control.enabled, false);
  assert.ok(h.events.every((e) => e.type === "keyup"));
});

test("paused batches leave manually held arrows alone", () => {
  const h = controlsHarness();
  const { epoch } = h.controls.read().control;
  const result = h.controls.apply(
    epoch,
    false,
    [],
    ["ArrowDown", "ArrowRight"],
  );
  assert.equal(result.active, false);
  h.controls.release();
  assert.equal(h.events.length, 0);
});

test("P still pauses when the bot holds Shift, releases Shift, and ignores chat", () => {
  const { controls, listeners, target, event, events } = controlsHarness();
  listeners.keydown(event);
  const active = controls.read().control;
  assert.equal(active.enabled, true);
  assert.equal(controls.isActive(active.epoch), true);
  target.typing = true;
  listeners.keydown(event);
  assert.equal(controls.read().control.enabled, true);
  target.typing = false;
  listeners.keydown(event);
  assert.equal(controls.read().control.enabled, false);
  assert.equal(controls.isActive(active.epoch), false);
  assert.ok(events.some((e) => e.key === "Shift" && e.type === "keyup"));
  listeners.keydown(event);
  assert.equal(controls.read().control.enabled, true);
  assert.equal(controls.isActive(active.epoch), false);
});

test("R requests and cancels rescue while preserving pause and typing controls", () => {
  const h = controlsHarness();
  const press = (extra = {}) =>
    h.listeners.keydown({ ...h.event, code: "KeyR", ...extra });
  press();
  assert.equal(h.controls.read().control.enabled, false);
  assert.equal(h.controls.read().control.rescueRequest, 1);
  h.listeners.keydown(h.event);
  const active = h.controls.read().control;
  press();
  const rescue = h.controls.read().control;
  assert.equal(rescue.enabled, true);
  assert.equal(rescue.rescueRequest, 2);
  assert.equal(h.controls.isActive(active.epoch), false);
  press({ repeat: true });
  press({ ctrlKey: true });
  h.target.typing = true;
  press();
  h.target.typing = false;
  assert.equal(h.controls.read().control.rescueRequest, 2);
  press();
  assert.equal(h.controls.read().control.rescueRequest, 3);
  h.listeners.keydown({ ...h.event, code: "Escape" });
  assert.equal(h.controls.isActive(rescue.epoch), false);
});

test("control watchdog releases movement after a lost heartbeat", () => {
  const { controls, listeners, event, events, advance } = controlsHarness();
  advance(5000);
  listeners.keydown(event);
  advance(1000);
  assert.equal(controls.read().control.enabled, true);
  advance(1500);
  assert.equal(events.length, 0);
  advance(100);
  assert.equal(controls.read().control.enabled, false);
  assert.ok(events.some((e) => e.key === "ArrowRight" && e.type === "keyup"));
  assert.ok(events.some((e) => e.key === "x" && e.type === "keyup"));
  const released = events.length;
  advance(2000);
  assert.equal(events.length, released);
});

test("WASD hands control to the player instead of mixing with bot arrows", () => {
  const h = controlsHarness();
  h.listeners.keydown(h.event);
  const active = h.controls.read().control;
  h.listeners.keydown({ ...h.event, code: "KeyW" });
  assert.equal(h.controls.read().control.enabled, false);
  assert.equal(h.controls.isActive(active.epoch), false);
  assert.ok(h.events.some((e) => e.key === "ArrowRight" && e.type === "keyup"));
});

test("Escape, blur, hidden pages, and navigation invalidate pending inputs", () => {
  const h = controlsHarness();
  for (const pause of [
    () => h.listeners.keydown({ ...h.event, code: "Escape" }),
    () => h.listeners.blur(),
    () => {
      h.document.hidden = true;
      h.documentListeners.visibilitychange();
    },
    () => h.listeners.pagehide(),
  ]) {
    h.document.hidden = false;
    h.listeners.keydown(h.event);
    const { epoch } = h.controls.read().control;
    assert.equal(h.controls.isActive(epoch), true);
    pause();
    assert.equal(h.controls.isActive(epoch), false);
    assert.equal(h.controls.read().control.enabled, false);
  }
});

test("disposing page controls releases keys and removes listeners and watchdog", () => {
  const h = controlsHarness();
  h.listeners.keydown(h.event);
  h.controls.dispose();
  assert.equal(h.controls.read().control.enabled, false);
  assert.ok(h.events.some((e) => e.key === "Shift" && e.type === "keyup"));
  assert.equal(h.hasWatchdog(), false);
  assert.deepEqual(Object.keys(h.listeners), []);
  assert.deepEqual(Object.keys(h.documentListeners), []);
});

test("Jev sends documented Choice schema, restricts choices, and validates answers", async () => {
  const candidates = planActions(state());
  let payload;
  const policy = new JevPolicy({
    apiKey: "test-only",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(init.headers.Authorization, "Bearer test-only");
      payload = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          answers: {
            movement: { type: "choice", choice: "right", confidence: 0.8 },
          },
          usage: { input_tokens: 100 },
        }),
      };
    },
  });
  assert.equal((await policy.decide(candidates)).action, "right");
  assert.equal(payload.model, "jev-latest");
  assert.equal(payload.questions.movement.type, "choice");
  assert.ok(payload.questions.movement.criteria.right);
  policy.fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      answers: {
        movement: { type: "choice", choice: "teleport", confidence: 1 },
      },
    }),
  });
  await assert.rejects(policy.decide(candidates), /invalid movement/);
  policy.fetchImpl = async () => ({ ok: false, status: 401 });
  await assert.rejects(policy.decide(candidates), /HTTP 401/);
});

test("late model response cannot survive pause or area change", async () => {
  let finish;
  const policy = {
    decide: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  };
  const loop = new DecisionLoop(policy);
  const now = performance.now();
  loop.request([], "area1", now);
  loop.reset();
  finish({ action: "right", confidence: 1, inputTokens: 10 });
  await nextTurn();
  assert.equal(loop.get("area1"), null);
  loop.request([], "area1", now + 1000);
  finish({ action: "right", confidence: 1, inputTokens: 10 });
  await nextTurn();
  assert.equal(loop.get("area1", now + 1100).action, "right");
  assert.equal(loop.get("area2", now + 1100), null);
  assert.equal(loop.get("area1", now + 1501), null);
});

test("keyboard releases old directions and all movement on pause", async () => {
  const events = [];
  const keyboard = new KeyboardController({
    down: async (key) => events.push(["down", key]),
    up: async (key) => events.push(["up", key]),
  });
  await keyboard.set("up_right");
  await keyboard.set("right");
  await keyboard.release();
  assert.deepEqual(events, [
    ["down", "ArrowUp"],
    ["down", "ArrowRight"],
    ["up", "ArrowUp"],
    ["up", "ArrowRight"],
  ]);
  assert.equal(keyboard.held.size, 0);
  await keyboard.set("focus_right");
  await keyboard.release();
  assert.ok(events.some(([event, key]) => event === "up" && key === "Shift"));
  assert.equal(keyboard.held.size, 0);
});

test("keyboard repairs the Vicious Valley missing Down key without resetting held Right", async () => {
  // The recording selected down_right while game.keys contained only native ID 10.
  const events = [],
    keyboard = new KeyboardController({
      up: async (key) => events.push(["up", key]),
      down: async (key) => events.push(["down", key]),
    });
  await keyboard.set("down_right");
  events.length = 0;
  await keyboard.set("down_right", [], ["ArrowRight"]);
  assert.deepEqual(events, [
    ["up", "ArrowDown"],
    ["down", "ArrowDown"],
  ]);
  events.length = 0;
  await keyboard.set("down_right", [], ["ArrowRight", "ArrowDown"]);
  assert.equal(events.length, 0);
  await keyboard.set(
    "down_right",
    [],
    ["ArrowRight", "ArrowDown", "ArrowUp", "Shift"],
  );
  assert.deepEqual(events, [
    ["up", "ArrowUp"],
    ["up", "Shift"],
  ]);
  await keyboard.release();
  assert.equal(keyboard.held.size, 0);
});
