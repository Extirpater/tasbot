import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { ENEMY_TYPES } from "../src/enemies.js";
import { EnemyMotionTracker, learnedVelocity } from "../src/enemy-motion.js";
import { observeGame, MotionTracker } from "../src/observe.js";
import { KeyboardController } from "../src/controller.js";
import * as planner from "../src/planner.js";
import { MovementPolicy } from "../src/movement.js";
import { replayEncounter } from "../scripts/replay-encounter.js";
import { Navigation } from "../src/navigation.js";
import {
  advancePlayer,
  bestAction,
  forecastHazard,
  planActions,
  predictHazardPath,
  trajectoryClearance,
} from "../src/planner.js";

const state = () => ({
  packet: 100,
  tickRate: 60,
  time: 1000,
  player: { x: 100, y: 250, radius: 10, speed: 150 },
  area: {
    id: "test",
    x: 0,
    y: 0,
    width: 1000,
    height: 500,
    zones: [{ x: 0, y: 0, width: 1000, height: 500, type: 0 }],
    walls: [],
  },
  hazards: [],
});
const observe = (entities, keys = []) => {
  const s = state();
  const gameState = {
    self: { entity: { ...s.player, deathTimer: -1 } },
    area: { ...s.area, zones: { list: () => s.area.zones } },
    entities,
    keys: { get: () => keys },
  };
  const element = { __reactFiber$test: { stateNode: { gameState } } };
  return vm.runInNewContext(`(${observeGame.toString()})(types)`, {
    types: ENEMY_TYPES,
    performance: { now: () => 1000 },
    document: {
      querySelectorAll: () => [element],
      activeElement: { matches: () => false },
    },
  });
};
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));

test("observer retains every flagged enemy and projectile, including harmless and unknown types", () => {
  const entries = Object.entries(ENEMY_TYPES);
  const enemies = entries.map(([type, value]) => ({
    id: Number(type),
    entityType: Number(type),
    x: 300,
    y: 200,
    radius: 18,
    isEnemy: value.name.endsWith("_enemy"),
    isEnemyProjectile: value.name.endsWith("_projectile"),
    isHarmless: true,
    velocityX: 2,
    velocityY: 0,
  }));
  const result = observe([
    ...enemies,
    { id: 9999, entityType: 9999, x: 300, y: 200, isEnemy: true },
    { id: 9998, x: 300, y: 200, isEnemy: true, removed: true },
    { id: 9997, x: 300, y: 200, isPlayer: true },
    { id: 9996, x: 300, y: 200, isPlayerProjectile: true },
  ]);
  assert.equal(result.hazards.length, entries.length + 1);
  for (const [id, type] of entries)
    assert.equal(
      result.hazards.find((h) => h.id === Number(id)).typeName,
      type.name,
    );
  assert.ok(result.hazards.some((h) => h.id === 9999));
  assert.ok(!result.hazards.some((h) => [9996, 9997, 9998].includes(h.id)));
});

test("observer records Switch timers, Sizing phase, Turning rate and actual direction keys", () => {
  const body = {
    x: 300,
    y: 200,
    radius: 24,
    isEnemy: true,
    velocityX: 2,
    velocityY: 0,
  };
  const result = observe(
    [
      {
        ...body,
        id: 1,
        entityType: 217,
        isHarmless: true,
        harmlessTime: 200,
        switchedHarmless: true,
        switchTime: 400,
        grassHarmless: true,
        grassTime: 100,
      },
      { ...body, id: 2, entityType: 191, sizingMultiplier: 1.2, growing: true },
      {
        ...body,
        id: 3,
        entityType: 225,
        trackTurningDirection() {},
        _pred: { turnMag: 0.03, turnSign: -1 },
      },
      { ...body, id: 4, entityType: 242 },
    ],
    [10, 6, 8, 3],
  );
  assert.equal(result.hazards[0].harmlessUntilMs, 400);
  assert.equal(result.hazards[0].switchState.harmless, true);
  assert.equal(result.hazards[1].sizing.baseRadius, 20);
  assert.equal(result.hazards[1].sizing.growing, true);
  assert.ok(Math.abs(result.hazards[2].turning.rate + 1.8) < 1e-10);
  assert.equal(result.hazards[3].uncertainMotion, true);
  assert.deepEqual(Array.from(result.input.controllerKeys), [
    "ArrowRight",
    "ArrowDown",
    "Shift",
    "x",
  ]);
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

test("harmless crossing is safe only before the body becomes lethal", () => {
  const p0 = { x: -20, y: 0 },
    p1 = { x: 20, y: 0 },
    h = { x: 0, y: 0 };
  const gap = (activeFrom) =>
    trajectoryClearance(p0, p1, h, h, { radius: 5, activeFrom }, 1, 1);
  assert.equal(gap(2), Infinity);
  assert.equal(gap(0.75), 5);
  assert.equal(gap(0.5), -5);
  assert.equal(gap(0), -5);
});

test("Sizing grows, reverses at its limit, and reserves a peak between coarse samples", () => {
  const s = state(),
    h = {
      x: 500,
      y: 250,
      vx: 0,
      vy: 0,
      radius: 20,
      sizing: { baseRadius: 20, multiplier: 1, growing: true },
    };
  const path = predictHazardPath(h, s.area, 60, 1 / 60);
  assert.ok(Math.abs(path.at(-1).radius - 44) < 1e-9);
  const peak = {
    ...h,
    radius: 49.8,
    sizing: { ...h.sizing, multiplier: 2.49 },
  };
  const turning = predictHazardPath(peak, s.area, 2, 1 / 60);
  assert.ok(turning[1].radius > 50);
  assert.ok(turning[2].radius < turning[1].radius);
  const coarse = forecastHazard(peak, 10, s.area, 1, 0.25);
  assert.ok(coarse.radii[1] > 60);
});

test("spatial culling retains a distant body that grows into the player", () => {
  const s = state();
  s.player.speed = 0;
  s.hazards = [
    {
      id: 1,
      x: 410,
      y: 250,
      vx: 0,
      vy: 0,
      radius: 80,
      bounce: false,
      sizing: { baseRadius: 200, multiplier: 0.4, growing: true },
    },
  ];
  const c = planActions(s, { reactionTime: 0, horizon: 1, fastPath: false });
  assert.ok(c.find((c) => c.action === "stay").physicalClearance < 0);
});

test("Turning follows its observed angular rate and reverses rotation at a wall", () => {
  const s = state(),
    angle = Math.PI / 60;
  const h = {
    x: 500,
    y: 250,
    vx: 60,
    vy: 0,
    radius: 18,
    turning: { rate: Math.PI },
  };
  const path = predictHazardPath(h, s.area, 30, 1 / 60);
  let x = h.x,
    y = h.y;
  for (let i = 1; i <= 30; i++) {
    x += Math.cos(i * angle);
    y += Math.sin(i * angle);
  }
  assert.ok(Math.hypot(path[30].x - x, path[30].y - y) < 1e-8);
  const wall = predictHazardPath({ ...h, x: 982 }, s.area, 2, 1 / 60);
  assert.ok(Math.abs(wall[1].x - (982 - Math.cos(angle))) < 1e-9);
  assert.ok(Math.abs(wall[2].x - (wall[1].x - Math.cos(2 * angle))) < 1e-9);
  assert.ok(Math.abs(wall[2].y - (wall[1].y + Math.sin(2 * angle))) < 1e-9);
});

test("uncertain motion remembers peak speed through a pause and resets for a new area", () => {
  const tracker = new MotionTracker(),
    s = state();
  s.hazards = [
    {
      id: 1,
      x: 300,
      y: 250,
      vx: 120,
      vy: 0,
      radius: 18,
      uncertainMotion: true,
      uncertainSpeed: 120,
    },
  ];
  tracker.update(s);
  const paused = {
    ...s,
    packet: 101,
    hazards: [
      {
        ...s.hazards[0],
        vx: 0,
        uncertainSpeed: 0,
        motionEffects: [{ scale: 0, remainingMs: 100 }],
      },
    ],
  };
  const h = tracker.update(paused).hazards[0];
  assert.equal(h.uncertainSpeed, 120);
  const path = predictHazardPath(h, s.area, 12, 1 / 60);
  assert.equal(path[6].radius, 18);
  assert.ok(Math.abs(path[12].radius - 30) < 1e-9);
  assert.equal(
    tracker.update({ ...paused, area: { ...s.area, id: "next" } }).hazards[0]
      .uncertainSpeed,
    0,
  );
});

test("recorded Wacky Area 16 Spiral stays inside the reserved region despite sharp turns", () => {
  const f = fixture("wacky-spiral"),
    h = f.motion.start;
  let maximumError = 0;
  for (const sample of f.motion.samples) {
    const predicted = predictHazardPath(h, f.state.area, 1, sample.time)[1];
    maximumError = Math.max(
      maximumError,
      Math.hypot(sample.hazard.x - predicted.x, sample.hazard.y - predicted.y),
    );
    const region = predictHazardPath(
      { ...h, uncertainMotion: true, uncertainSpeed: Math.hypot(h.vx, h.vy) },
      f.state.area,
      1,
      sample.time,
    )[1];
    assert.ok(
      Math.hypot(sample.hazard.x - region.x, sample.hazard.y - region.y) +
        h.radius <=
        region.radius + 0.1,
    );
  }
  assert.ok(maximumError > 80);
});

test("Wacky Area 16 rejects the recorded fatal turn while a buffered alternative remains", () => {
  const f = fixture("wacky-spiral");
  f.state.hazards = f.state.hazards.map((h) => ({
    ...h,
    uncertainMotion: ENEMY_TYPES[h.entityType]?.uncertainMotion,
    uncertainSpeed: Math.hypot(h.vx, h.vy),
  }));
  const c = planActions(f.state, { ...f.options, fastPath: false });
  assert.ok(f.originalClearance > 29);
  assert.ok(c.find((c) => c.action === f.originalAction).physicalClearance < 0);
  const best = c.find((candidate) => candidate.action === bestAction(c));
  assert.notEqual(best.action, f.originalAction);
  assert.ok(best.clearance > 0);
});

test("Monumental Area 44 reconstruction catches an upcoming Switch activation", () => {
  const f = fixture("switch-activation");
  const missing = planActions(f.state, { ...f.options, fastPath: false });
  assert.ok(missing.find((c) => c.action === f.originalAction).clearance > 0);
  f.state.hazards.push(f.reconstructedHazard);
  const c = planActions(f.state, { ...f.options, fastPath: false });
  assert.ok(c.find((c) => c.action === f.originalAction).clearance < 0);
  assert.ok(
    c.find((candidate) => candidate.action === bestAction(c)).clearance > 0,
  );
});

test("coarse route costs include activation time and future growth", () => {
  const s = state();
  s.area.zones.push({ x: 950, y: 0, width: 50, height: 500, type: 2 });
  s.hazards = [{ id: 1, x: 150, y: 250, vx: 0, vy: 0, radius: 18 }];
  const point = { x: 150, y: 250 };
  const lethal = new Navigation().update(s, 0).distanceAt(point, 0);
  s.hazards[0].harmlessUntilMs = 4000;
  const harmless = new Navigation().update(s, 0).distanceAt(point, 0);
  assert.ok(lethal > harmless + 10);
  s.hazards[0].harmlessUntilMs = 0;
  s.hazards[0].sizing = { baseRadius: 18, multiplier: 1, growing: true };
  assert.ok(new Navigation().update(s, 0).distanceAt(point, 0) > lethal);
});

test("observer retains the actual Slippery aura radius and labels its steering effect", () => {
  const result = observe([
    {
      id: 1,
      entityType: 193,
      isEnemy: true,
      x: 300,
      y: 200,
      radius: 4,
      velocityX: 1,
      velocityY: 0,
      effects: { list: () => [{ effectType: 53, radius: 117 }] },
    },
  ]);
  assert.equal(result.auras.length, 1);
  assert.equal(result.auras[0].kind, "slippery");
  assert.equal(result.auras[0].auraRadius, 117);
  assert.equal(result.auras[0].reduction, 0);
});

test("Restless Ridge recorded slide ignores the requested turn and Shift brake", () => {
  const f = fixture("restless-slippery"),
    { player, area } = f.state;
  for (const action of ["up_right", "up", "stay", "focus_left"]) {
    let position = { ...player };
    let packet = f.state.packet;
    for (const sample of f.samples) {
      while (packet < sample.packet) {
        position = advancePlayer(
          position,
          action,
          player,
          area,
          1 / 60,
          1,
          true,
        );
        packet++;
      }
      assert.ok(
        Math.hypot(position.x - sample.player.x, position.y - sample.player.y) <
          0.01,
      );
    }
  }
  const normal = advancePlayer(player, "up_right", player, area);
  assert.ok(normal.y < player.y);
});

test("Slippery steering recovers after leaving its field or hitting an outer wall", () => {
  const s = state(),
    p = { ...s.player, x: 100, vx: 150, vy: 0, trackSliding: true };
  const locked = advancePlayer(p, "up", p, s.area, 1 / 60, 1, true);
  assert.equal(locked.y, p.y);
  assert.ok(advancePlayer(locked, "up", p, s.area).y < p.y);
  const atWall = { ...p, x: 990 };
  let position = advancePlayer(atWall, "up", p, s.area, 1 / 60, 1, true);
  assert.equal(position.slideWallEscape, true);
  position = advancePlayer(position, "up", p, s.area, 1 / 60, 1, true);
  position = advancePlayer(position, "up", p, s.area, 1 / 60, 1, true);
  assert.ok(position.y < p.y);
  const immune = advancePlayer(
    p,
    "up",
    { ...p, effectsMultiplier: 0 },
    s.area,
    1 / 60,
    1,
    true,
  );
  assert.ok(immune.y < p.y);
});

test("planner stops promising a turn inside a Slippery field and steers before entry", () => {
  const s = state();
  s.player.vx = 150;
  s.player.vy = 0;
  s.hazards = [{ id: 1, x: 180, y: 250, radius: 4, vx: 0, vy: 0 }];
  const options = { reactionTime: 0, fastPath: false };
  const noAura = planActions(s, options);
  assert.ok(noAura.find((c) => c.action === bestAction(noAura)).clearance > 0);
  s.auras = [
    {
      ...s.hazards[0],
      type: 53,
      auraRadius: 100,
      reduction: 0,
      kind: "slippery",
    },
  ];
  const locked = planActions(s, options);
  assert.ok(locked.every((c) => c.physicalClearance <= 0));
  s.player.x = 40;
  const beforeEntry = planActions(s, options);
  const escape = beforeEntry.find((c) => c.action === bestAction(beforeEntry));
  assert.ok(escape.clearance > 0);
  assert.notEqual(escape.action, "right");
});

test("Pumpkin windup and dormancy override stale cached prediction velocity", () => {
  const enemy = {
    id: 1,
    entityType: 138,
    isEnemy: true,
    x: 300,
    y: 200,
    radius: 30,
    pumpkinActivated: false,
    imageName: "pumpkin_off",
    velocityX: 0,
    velocityY: 0,
    _pred: { vx: 4, vy: 0 },
  };
  const dormant = observe([enemy]).hazards[0];
  assert.equal(dormant.vx, 0);
  const area = state().area;
  assert.equal(predictHazardPath(dormant, area, 60, 1 / 60).at(-1).x, 300);
  const arming = observe([
    {
      ...enemy,
      imageName: "pumpkin_on",
      velocityX: 4,
      pumpkinActivationTimer: 500,
    },
  ]).hazards[0];
  const forecast = predictHazardPath(arming, area, 60, 1 / 60);
  assert.equal(forecast[30].radius, 30);
  assert.ok(forecast[60].radius > 149);
  const active = observe([
    {
      ...enemy,
      pumpkinActivated: true,
      imageName: "pumpkin_on",
      movementTime: 1450,
      velocityX: 4,
    },
  ]).hazards[0];
  const path = predictHazardPath(active, area, 60, 1 / 60);
  assert.equal(path.at(-1).x, 312);
});

test("a repeated Wavy velocity pattern predicts through held-out future cycles", () => {
  const tracker = new EnemyMotionTracker();
  let model;
  for (let packet = 0; packet < 240; packet++) {
    model = tracker.update(
      {
        id: 1,
        uncertainMotion: true,
        uncertainSpeed: 220,
        vx: 180,
        vy: 120 * Math.sin((2 * Math.PI * packet) / 60),
      },
      packet,
    );
    if (packet > 150) assert.equal(model?.kind, "periodic");
  }
  for (const time of [0.1, 0.3, 0.7, 1.1]) {
    const v = learnedVelocity(model, time, 0);
    assert.ok(
      Math.abs(v.vy - 120 * Math.sin(2 * Math.PI * (239 / 60 + time))) < 0.1,
    );
  }
  const changed = tracker.update(
    { id: 1, uncertainMotion: true, uncertainSpeed: 220, vx: -180, vy: -100 },
    240,
  );
  assert.notEqual(changed?.kind, "periodic");
  tracker.reset();
  assert.equal(
    tracker.update({ id: 1, uncertainMotion: true, vx: 180, vy: 0 }, 241),
    undefined,
  );
});

test("Spiral learns angular acceleration from past samples and forecasts actual future positions", () => {
  const f = fixture("wacky-spiral"),
    tracker = new MotionTracker();
  let totalError = 0,
    checks = 0,
    maximumError = 0,
    learned;
  for (let i = 0; i < f.history.length; i++) {
    const row = f.history[i];
    const s = tracker.update({
      ...f.state,
      packet: row.packet,
      hazards: row.hazards.map((h) => ({
        ...h,
        uncertainMotion: ENEMY_TYPES[h.entityType]?.uncertainMotion,
      })),
    });
    if (i === 184) learned = s;
    const h = s.hazards.find((h) => h.id === 1922);
    if (i < 30 || !h?.learnedMotion) continue;
    const next = f.history.find((g) => g.packet >= row.packet + 15);
    if (!next) continue;
    const p = predictHazardPath(
      h,
      s.area,
      1,
      (next.packet - row.packet) / 60,
    )[1];
    const actual = next.hazards.find((h) => h.id === 1922);
    const error = Math.hypot(p.x - actual.x, p.y - actual.y);
    maximumError = Math.max(maximumError, error);
    totalError += error;
    checks++;
  }
  assert.ok(checks > 100);
  assert.ok(totalError / checks < 1);
  assert.ok(maximumError < 5);
  const h = learned.hazards.find((h) => h.id === 1922);
  const path = predictHazardPath(h, learned.area, 60, 1 / 60);
  assert.ok(path.at(-1).radius < h.radius + 10);
  const c = planActions(learned, { ...f.options, fastPath: false });
  assert.ok(
    c.find((candidate) => candidate.action === bestAction(c)).clearance > 0,
  );
});

test("learned Wacky patterns advance faster with fewer turns in the recorded encounter", () => {
  const f = fixture("wacky-spiral"),
    tracker = new MotionTracker();
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
  const envelope = {
    ...trace,
    frames: frames.map((frame) => ({
      ...frame,
      state: {
        ...frame.state,
        hazards: frame.state.hazards.map((h) => ({
          ...h,
          learnedMotion: undefined,
        })),
      },
    })),
  };
  const old = replayEncounter(envelope, planner, MovementPolicy, {
    fromFrame: 140,
  });
  const learned = replayEncounter(trace, planner, MovementPolicy, {
    fromFrame: 140,
  });
  assert.ok(old.survivedRecordedWindow && learned.survivedRecordedWindow);
  assert.ok(learned.minimumClearance > 50);
  assert.ok(learned.progress > old.progress + 80);
  assert.ok(learned.turns < old.turns);
  assert.equal(learned.focusFraction, 0);
});
