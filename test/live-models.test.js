import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { observeGame } from "../src/observe.js";
import { ACTIONS, advancePlayer, predictHazardPath, planActions, bestAction } from "../src/planner.js";
import { withLiveModels, prepareLivePlanning } from "../src/live-models.js";
import { InputTiming } from "../src/timing.js";
import { replayEncounter } from "../scripts/replay-encounter.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/live-client-models.json", import.meta.url)));
function nativeContext(rate = 60) {
  const context = vm.createContext({
    Wy: class {}, jg: a => a.zones.find(z => z.type === 0),
    Ug: (i, p) => { p.x += p.vx; p.y += p.vy; },
    jh: { ZoneType: { ACTIVE_ZONE: 0, VICTORY_ZONE: 6 }, KeyType: { FOCUS_KEY: 8 },
      HeroType: { GLOB: 1, FACTORB: 2 }, AbilityType: {} },
    Ec: () => 1000 / rate, dp: () => false, sp: () => 0, fp: () => 0,
    op: p => p.effectsMultiplier ?? 1, np: () => 1,
  });
  for (const [name, code] of Object.entries(fixture.code)) {
    if (["icicle", "turning", "liquid", "dasher", "slipperyPost"].includes(name))
      vm.runInContext(`globalThis.${name} = (${code})`, context);
    else vm.runInContext(code, context);
  }
  return context;
}
const state = () => ({
  ready: true, tickRate: 60, packet: 1,
  area: { id: "live-test", x: 0, y: 0, width: 1000, height: 500, walls: [],
    zones: [{ type: 0, x: 0, y: 0, width: 1000, height: 500 }] },
  player: { id: 1, x: 450, y: 250, radius: 15, speed: 660, baseSpeed: 510,
    speedBonus: 150, vx: 660, vy: 0, slideAngle: 0, effectsMultiplier: 1 },
  hazards: [], auras: [], otherPlayers: [],
});
const near = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function nativePath(context, kind, h, s, ticks, target) {
  const rate = s.tickRate, enemy = new context[kind]();
  enemy._pred = { vx: h.vx / rate, vy: h.vy / rate };
  const p = { x: h.x, y: h.y, vx: h.vx / rate, vy: h.vy / rate, radius: h.radius };
  if (kind === "icicle") {
    Object.assign(enemy, { wallHit: h.icicle.paused, wallTimeLeft: h.icicle.remainingMs });
    Object.assign(enemy._pred, { moveVx: h.icicle.vx / rate, moveVy: h.icicle.vy / rate });
  } else if (kind === "turning") {
    Object.assign(enemy._pred, { turnMag: Math.abs(h.turning.rate) / rate, turnSign: Math.sign(h.turning.rate) });
  } else if (kind === "liquid") {
    const speed = Math.hypot(h.liquid.vx, h.liquid.vy);
    Object.assign(enemy, { activated: h.liquid.active, playerDetectionRadius: h.liquid.range });
    Object.assign(enemy._pred, { baseDirX: h.liquid.vx / speed, baseDirY: h.liquid.vy / speed, baseSpeed: speed / rate });
  } else if (kind === "dasher") {
    Object.assign(enemy, { timePreparing: h.dash.preparing, timeDashing: h.dash.dashing,
      timeSinceLastDash: h.dash.resting, dashSpeed: h.dash.peak });
    Object.assign(enemy._pred, { dashDirX: h.dash.dx, dashDirY: h.dash.dy });
  }
  const options = { pred: enemy._pred, tickTime: 1000 / rate, area: s.area,
    playerPathFn: target ? i => target((i + 1) / rate) : null };
  enemy.initStep(p, options);
  const path = [{ x: p.x, y: p.y }];
  context.Wg({ cur: p, ticks, area: s.area, walls: s.area.walls,
    zone: enemy.zonePolicy, pathOut: path, step: (i, p) => enemy.stepTick(i, p, options),
    onZoneBounce: enemy.onZoneBounce?.bind(enemy), onWallBounce: enemy.onWallBounce?.bind(enemy) });
  return path;
}

test("live Icicle and Turning forecasts match independent public-client ticks, wall corners and coarse samples", () => {
  for (const rate of [30, 60]) for (const kind of ["icicle", "turning"])
    for (const paused of [false, true]) for (const wall of [false, true]) {
      const s = state(); s.tickRate = rate;
      if (wall) s.area.walls.push({ x: 510, y: 240, width: 20, height: 90 });
      const h = { id: 2, x: wall ? 465 : 977, y: 225, radius: 18, vx: 270, vy: 170,
        ...(kind === "icicle" ? { icicle: { paused, remainingMs: 20, vx: -270, vy: -170 } }
          : { turning: { rate: -2.4 } }) };
      s.hazards = [h];
      const modeled = withLiveModels(s).hazards[0];
      const native = nativePath(nativeContext(rate), kind, h, s, 150);
      const actual = predictHazardPath(modeled, s.area, 150, 1 / rate, undefined, rate);
      for (let i = 0; i < native.length; i++) { near(actual[i].x, native[i].x); near(actual[i].y, native[i].y); }
      const coarse = predictHazardPath(modeled, s.area, 30, 4.5 / rate, undefined, rate);
      for (let i = 0; i < coarse.length; i++) {
        const t = i * 4.5, a = native[Math.floor(t)], b = native[Math.ceil(t)];
        near(coarse[i].x, (a.x + b.x) / 2); near(coarse[i].y, (a.y + b.y) / 2);
      }
    }
});

test("Liquid uses previous activation, native radius threshold and reflected bounces for each candidate", () => {
  for (const active of [true, false]) {
    const s = state(), h = { id: 2, x: 950, y: 250, radius: 18, vx: 150, vy: 60,
      liquid: { active, range: 160, vx: 150, vy: 60 } };
    s.hazards = [h];
    const modeled = withLiveModels(s).hazards[0];
    for (const target of [t => ({ x: 790 + t * 180, y: 250 }), () => ({ x: 40, y: 40 })]) {
      const native = nativePath(nativeContext(), "liquid", h, s, 90, target);
      const actual = predictHazardPath(modeled, s.area, 90, 1 / 60, target);
      for (let i = 0; i < native.length; i++) { near(actual[i].x, native[i].x); near(actual[i].y, native[i].y); }
      const coarse = predictHazardPath(modeled, s.area, 20, 4.5 / 60, target);
      for (let i = 0; i < coarse.length; i++) {
        const a = native[Math.floor(i * 4.5)], b = native[Math.ceil(i * 4.5)];
        near(coarse[i].x, (a.x + b.x) / 2); near(coarse[i].y, (a.y + b.y) / 2);
      }
    }
    assert.equal(h.liquid.active, active, "branches must not modify the observation");
  }
});

test("live Dasher keeps phase-before-movement semantics instead of importing Ravel's order", () => {
  for (const preparing of [700, 749, 750]) {
    const s = state(), h = { id: 2, x: 700, y: 200, radius: 90,
      vx: 600 / 5 * (1 - preparing / 750), vy: 0,
      dash: { preparing, dashing: 0, resting: 0, peak: 600, dx: 1, dy: 0, scale: 1 } };
    s.hazards = [h];
    const native = nativePath(nativeContext(), "dasher", h, s, 120);
    const actual = predictHazardPath(withLiveModels(s).hazards[0], s.area, 120, 1 / 60);
    for (let i = 0; i < native.length; i++) near(actual[i].x, native[i].x);
    const coarse = predictHazardPath(withLiveModels(s).hazards[0], s.area, 20, 4.5 / 60);
    for (let i = 0; i < coarse.length; i++) near(coarse[i].x,
      (native[Math.floor(i * 4.5)].x + native[Math.ceil(i * 4.5)].x) / 2);
  }
});

test("Slippery lock, delayed steering, Shift and wall boost match the public client", () => {
  for (const wall of [false, true]) for (const initiallyMoving of [false, true]) {
    const s = state(); s.player.x = wall ? 980 : 400;
    if (!initiallyMoving) s.player.vx = 0;
    s.auras = [{ id: 2, type: 53, kind: "slippery", x: 500, y: 250, radius: 5,
      auraRadius: 1000, reduction: 0, vx: 0, vy: 0 }];
    const model = withLiveModels(s), context = nativeContext(), p = s.player;
    const nativePlayer = { ...p, speed: 510, sweetToothConsumed: true, sweetToothConsumedTime: 10000, sweetToothStatBoost: 150 };
    const clip = (x, y) => ({ x: Math.max(15, Math.min(985, x)), y: Math.max(15, Math.min(485, y)),
      hitX: x < 15 || x > 985, hitY: y < 15 || y > 485 });
    const slip = { movementAngle: initiallyMoving ? 0 : undefined, stationary: !initiallyMoving,
      wallEscape: false, pendingBoost: Boolean(initiallyMoving && wall), active: true };
    context.Fp = () => {};
    context.zp = (e, t, r) => r;
    context.Bp = (e, t, r) => context.slipperyPost(e.slippery, r.stepped, r.wasSlide, r.refreshDir, r.inputAngle, r.stepDist);
    const env = { state: { serverTickRate: 60 }, self: nativePlayer, effectStates: { slippery: slip }, clampFn: clip, tickTime: 1000 / 60 };
    let native = { x: p.x, y: p.y }, actual = { ...p };
    for (let i = 0; i < 75; i++) {
      const action = i < 3 ? "focus_up" : i < 40 ? "down_left" : "stay", a = ACTIONS[action];
      const inputAngle = a.dx || a.dy ? Math.atan2(a.dy, a.dx) : undefined;
      native = context.um(env, null, native, { inputAngle }, i, 1);
      actual = { ...advancePlayer(actual, action, model.player, s.area), time: (i + 1) / 60 };
      near(actual.x, native.x); near(actual.y, native.y);
      near(actual.vx, native.vx * 60); near(actual.vy, native.vy * 60);
    }
  }
});

test("Ice forecasts cover imminent shots aimed at candidate and other visible players without firing into shelter", () => {
  const s = state();
  s.hazards = [{ id: 2, entityType: 77, x: 650, y: 250, radius: 18, vx: 0, vy: 0,
    iceSniper: { remainingMs: 100, radius: 10, speed: 480 } }];
  s.otherPlayers = [{ id: 3, x: 650, y: 450, radius: 15 }, { id: 4, x: 500, y: 300, downed: true }];
  const modeled = withLiveModels(s), shot = modeled.hazards.find(h => h.reactive);
  assert.equal(modeled.hazards.length, 3);
  assert.equal(shot.harmlessUntilMs, 100); assert.equal(shot.radius, 18);
  const toward = predictHazardPath(shot, s.area, 30, 1 / 60, () => s.player);
  const away = predictHazardPath(shot, s.area, 30, 1 / 60, () => ({ x: 850, y: 250 }));
  assert.equal(toward[5].x, 650); assert.ok(toward[30].x < 500); assert.ok(away[30].x > 800);
  const other = modeled.hazards.find(h => h.id === "future-ice:2:3");
  assert.ok(predictHazardPath(other, s.area, 30, 1 / 60)[30].y > 400);
  const safe = predictHazardPath(shot, s.area, 30, 1 / 60, () => ({ x: -100, y: 250 }));
  assert.equal(safe[30].x, 650);
  assert.equal(s.hazards.length, 1);
});

test("an impending Ice shot is checked during queued inputs, before the projectile exists", () => {
  const s = state();
  s.hazards = [{ id: 2, x: 535, y: 250, radius: 18, vx: 0, vy: 0,
    iceSniper: { remainingMs: 50, radius: 10, speed: 480 } }];
  const options = { reactionTime: 0.3, pendingInputs: [{ time: 0, action: "stay" }], maxPlanMs: 0 };
  assert.ok(planActions(s, options).some(c => !c.collision));
  assert.ok(planActions(withLiveModels(s), options).every(c => c.collision));
});

test("Slippery forecasting honors Candy expiry and normal movement outside the aura", () => {
  const s = state();
  s.auras = [{ id: 2, type: 53, kind: "slippery", x: 450, y: 250, radius: 5,
    auraRadius: 50, reduction: 0, vx: 0, vy: 0 }];
  const p = withLiveModels(s).player;
  near(advancePlayer(p, "focus_up", p, s.area).vx, 660);
  near(advancePlayer(p, "focus_up", { ...p, speedBonus: 0 }, s.area).vx, 510);
  const outside = { ...p, x: 300, vx: 0, vy: 0 };
  const actual = advancePlayer(outside, "focus_up", p, s.area);
  const expected = advancePlayer(outside, "focus_up", s.player, s.area);
  near(actual.y, expected.y); near(actual.vy, expected.vy);
  assert.equal(actual.motionState.pendingBoost, false);
});

test("live preparation preserves raw observations, respects rescue, and aligns turns to command cadence", () => {
  const s = state();
  s.area.zones.push({ type: 2, x: 0, y: 0, width: 40, height: 500 },
    { type: 2, x: 960, y: 0, width: 40, height: 500 });
  const before = structuredClone(s), prep = prepareLivePlanning(s, { decisionMs: 51 });
  assert.equal(prep.state.area.walls.length, 1);
  assert.equal(prep.state.area.walls[0].x, 0);
  assert.equal(prep.options.inputIntervalTicks, 4);
  assert.equal(prepareLivePlanning(s, { decisionMs: 49, previousIntervalTicks: 4 }).options.inputIntervalTicks, 4);
  assert.equal(prepareLivePlanning(s, { decisionMs: 40, previousIntervalTicks: 4 }).options.inputIntervalTicks, 3);
  assert.equal(prepareLivePlanning(s, { objective: { kind: "rescue" } }).state.area.walls.length, 0);
  assert.equal(prepareLivePlanning(s, { heading: "left" }).state.area.walls[0].x, 960);
  s.player.x = 20;
  assert.equal(prepareLivePlanning(s).state.area.walls.length, 0);
  s.player.x = before.player.x;
  assert.deepEqual(s, before);
  const candidates = planActions(prep.state, { ...prep.options, reactionTime: 0, fastPath: false });
  assert.ok(candidates.some(c => c.action === bestAction(candidates)));
  assert.equal(candidates[0].plan.inputIntervalTicks, 4);
});

test("missing or suppressed telemetry keeps the prior model; longer lookahead is targeted", () => {
  const s = state(), h = { id: 2, x: 700, y: 250, radius: 18, vx: 150, vy: 50, entityType: 79 };
  s.hazards = [h];
  assert.equal(withLiveModels(s).hazards[0], h);
  h.icicle = { paused: true, remainingMs: 400, vx: 150, vy: 50 };
  h.motionEffects = [{ name: "frozenTimeLeft", scale: 0, remainingMs: 100 }];
  assert.equal(withLiveModels(s).hazards[0], h);
  delete h.icicle; delete h.motionEffects;
  h.dash = { preparing: 500, dashing: 0, resting: 0, peak: 600, dx: 1, dy: 0, scale: 1 };
  assert.equal(prepareLivePlanning(s).options.horizon, 0.9);
  h.radius = 100;
  assert.equal(prepareLivePlanning(s).options.horizon, 1.5);
});

test("observer exports live phases, Slippery scanner immunity, and harmless freeze projectiles", () => {
  const s = state(), player = { ...s.player, speed: 510, totalSpeed: 660, shieldAngle: 1.2, deathTimer: -1 };
  const base = { isEnemy: true, x: 500, y: 250, radius: 18, velocityX: 2, velocityY: 1 };
  const entities = [
    { ...base, id: 2, entityType: 79, wallHit: true, wallTimeLeft: 300, _pred: { moveVx: 2, moveVy: 1, vx: 0, vy: 0 } },
    { ...base, id: 3, entityType: 96, activated: true, playerDetectionRadius: 160,
      _pred: { baseDirX: 1, baseDirY: 0, baseSpeed: 2 } },
    { ...base, id: 4, entityType: 225, trackTurningDirection() {}, _pred: { turnMag: 0.1, turnSign: -1 } },
    { ...base, id: 5, entityType: 77, releaseTime: 120 },
    { ...base, id: 6, entityType: 78, isEnemy: false, isEnemyProjectile: true, isHarmless: true },
    { ...base, id: 7, effects: { list: () => [{ effectType: 53, radius: 150 }] } },
  ];
  const gameState = { self: { entity: player }, serverTickRate: 60, packetNumber: 1,
    area: { ...s.area, zones: { list: () => s.area.zones } }, entities: Object.fromEntries(entities.map(e => [e.id, e])) };
  const element = { __reactFiber$test: { stateNode: { gameState, state: {} } } };
  const observe = () => vm.runInNewContext(`(${observeGame.toString()})()`, {
    document: { querySelectorAll: () => [element] }, performance: { now: () => 0 },
  });
  const actual = observe();
  assert.equal(actual.hazards[0].icicle.vx, 120);
  assert.equal(actual.hazards[1].liquid.vx, 120);
  assert.equal(actual.hazards[2].turning.rate, -6);
  assert.equal(actual.hazards[3].iceSniper.remainingMs, 120);
  assert.ok(actual.hazards.some(h => h.id === 6));
  assert.equal(actual.auras[0].kind, "slippery");
  assert.equal(actual.player.slideAngle, 1.2);
  player.roboScannerId = 6;
  assert.equal(observe().auras.length, 0);
});

test("Slippery motion cannot corrupt the latency fit, including while slow-aura immunity is active", () => {
  for (const ignoreAuras of [false, true]) for (const nearby of [true, false]) {
    const timing = new InputTiming(); timing.delayMs = 125; timing.record("right", 0);
    for (let i = 0; i < 40; i++) {
      const s = state(), at = 1000 + i * 1000 / 60;
      s.packet = i; s.player.x = 50 + i * 11; s.player.ignoreAuras = ignoreAuras;
      s.auras = [{ id: 8, type: 53, kind: "slippery", reduction: 0, auraRadius: 200,
        x: nearby ? s.player.x : 10000, y: s.player.y, vx: 0, vy: 0 }];
      timing.record(i % 3 ? "right" : "up", at - 100);
      timing.observe(s, at);
    }
    if (nearby) { assert.equal(timing.samples, 0); assert.equal(timing.delayMs, 125); }
    else assert.ok(timing.samples > 0);
  }
});

test("recorded-position replay rejects new mechanics whose actual counterfactual paths it cannot simulate", () => {
  for (const kind of ["liquid", "iceSniper", "slippery"]) {
    const s = state();
    if (kind === "slippery") s.auras = [{ kind }];
    else s.hazards = [{ [kind]: {} }];
    assert.throws(() => replayEncounter({ frames: [{ state: s }] }, null, null, { fromFrame: 0 }),
      /use native simulation/);
  }
});
