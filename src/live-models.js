import { ACTIONS, advancePlayer, circleInZone, predictHazardPath } from "./planner.js";

// Adapted from the public Evades client, not from Ravel's update order.
// See docs/live-port.md for source, assumptions, and validation boundaries.
export const LIVE_PROFILE = "ravel-transfer-v1";
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const activeZone = (h, area) => area.zones.find(z => z.type === 0 && circleInZone(h, z));
const exposed = (p, area, radius = p?.radius ?? 15) => p && !p.downed && !p.untargetable &&
  area.zones.some(z => (z.type === 0 || z.type === 6) &&
    (p.x - clamp(p.x, z.x, z.x + z.width)) ** 2 +
    (p.y - clamp(p.y, z.y, z.y + z.height)) ** 2 < radius ** 2);

function zoneBounce(p, zone, radius, clampOnly = false) {
  if (!zone) return [false, false];
  let hitX = false, hitY = false;
  for (const [axis, size] of [["x", "width"], ["y", "height"]]) {
    const lo = zone[axis] + radius, hi = zone[axis] + zone[size] - radius;
    if (p[axis] < lo || p[axis] > hi) {
      p[axis] = clampOnly ? clamp(p[axis], lo, hi) :
        p[axis] < lo ? 2 * lo - p[axis] : 2 * hi - p[axis];
      if (axis === "x") hitX = true; else hitY = true;
    }
  }
  return [hitX, hitY];
}

// Circle/rectangle push-out also handles rounded wall corners. The client
// resolves enemy walls with radius - .01, then reflects along the displacement.
function pushOut(x, y, radius, wall) {
  const dx = x - clamp(x, wall.x, wall.x + wall.width);
  const dy = y - clamp(y, wall.y, wall.y + wall.height);
  const squared = dx * dx + dy * dy;
  if (squared >= radius * radius) return { x, y, hit: false };
  if (squared > 1e-8) {
    const length = Math.sqrt(squared), shift = radius - length;
    return { x: x + dx / length * shift, y: y + dy / length * shift, hit: true };
  }
  const sides = [x - wall.x, wall.x + wall.width - x, y - wall.y, wall.y + wall.height - y];
  switch (sides.indexOf(Math.min(...sides))) {
    case 0: x = wall.x - radius; break;
    case 1: x = wall.x + wall.width + radius; break;
    case 2: y = wall.y - radius; break;
    case 3: y = wall.y + wall.height + radius; break;
  }
  return { x, y, hit: true };
}

function enemyWalls(p, radius, walls) {
  const x = p.x, y = p.y;
  let hit = false;
  for (let i = 0; i < walls.length; i++) {
    let changed = false;
    for (const wall of walls) {
      const result = pushOut(p.x, p.y, radius - 0.01, wall);
      if (result.hit) { p.x = result.x; p.y = result.y; hit = changed = true; }
    }
    if (!changed) break;
  }
  if (!hit) return false;
  const dx = p.x - x, dy = p.y - y;
  if (dx && dy) {
    const speed = Math.hypot(p.vx, p.vy), length = Math.hypot(dx, dy);
    p.vx = dx / length * speed; p.vy = dy / length * speed;
  } else if (dx) { if (p.vx * dx < 0) p.vx = -p.vx; }
  else if (p.vy * dy < 0) p.vy = -p.vy;
  return true;
}

function resample(fine, steps, dt, rate) {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const at = i * dt * rate, lo = Math.min(fine.length - 1, Math.floor(at));
    const a = fine[lo], b = fine[Math.min(lo + 1, fine.length - 1)], f = at - lo;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  });
}

function sampleTicks(initial, steps, dt, rate, advance) {
  const p = { ...initial }, fine = [{ x: p.x, y: p.y }];
  for (let i = 0; i < Math.ceil(steps * dt * rate - 1e-9); i++) {
    advance(p, i);
    fine.push({ x: p.x, y: p.y });
  }
  return resample(fine, steps, dt, rate);
}

function atNativeTicks(h) {
  return { ...h, predictPath: (area, steps, dt, rate = 60, targetAt) => resample(
    predictHazardPath(h, area, Math.ceil(steps * dt * rate - 1e-9), 1 / rate, targetAt, rate),
    steps, dt, rate) };
}

export function predictLiveIcicle(h, area, steps, dt, rate = 60) {
  const zone = activeZone(h, area), walls = area.walls ?? [];
  const pause = p => {
    if (p.paused || p.bounced) return;
    p.bounced = true; p.resumeVx = -p.vx; p.resumeVy = -p.vy;
    p.vx = p.vy = 0; p.paused = true; p.remainingMs = 1000;
  };
  return sampleTicks({ ...h, ...h.icicle, vx: h.icicle.paused ? 0 : h.vx,
    vy: h.icicle.paused ? 0 : h.vy, resumeVx: h.icicle.vx, resumeVy: h.icicle.vy },
  steps, dt, rate, p => {
    p.bounced = false;
    if (p.paused) {
      p.remainingMs -= 1000 / rate;
      if (p.remainingMs < 0) {
        p.paused = false; p.vx = p.resumeVx; p.vy = p.resumeVy;
      }
      // Unlocking consumes this tick; movement resumes on the following tick.
    } else { p.x += p.vx / rate; p.y += p.vy / rate; }
    const [hitX, hitY] = zoneBounce(p, zone, h.radius, true);
    if (hitX || hitY) pause(p);
    // Icicle ignores the wall's reflected velocity and reverses BOTH axes.
    const vx = p.vx, vy = p.vy;
    if (enemyWalls(p, h.radius, walls)) { p.vx = vx; p.vy = vy; pause(p); }
  });
}

export function predictLiveTurning(h, area, steps, dt, rate = 60) {
  const zone = activeZone(h, area), walls = area.walls ?? [];
  return sampleTicks({ ...h, rotation: h.turning.rate / rate }, steps, dt, rate, p => {
    const c = Math.cos(p.rotation), s = Math.sin(p.rotation), vx = p.vx;
    p.vx = vx * c - p.vy * s; p.vy = vx * s + p.vy * c;
    p.x += p.vx / rate; p.y += p.vy / rate;
    const [hitX, hitY] = zoneBounce(p, zone, h.radius);
    if (hitX) p.vx = -p.vx; if (hitY) p.vy = -p.vy;
    if (hitX || hitY) p.rotation = -p.rotation;
    if (enemyWalls(p, h.radius, walls)) p.rotation = -p.rotation;
  });
}

export function predictLiveZoning(h, area, steps, dt, rate = 60) {
  const zone = activeZone(h, area), walls = area.walls ?? [];
  const speed = Math.hypot(h.vx, h.vy);
  return sampleTicks({ ...h, speed, dx: h.vx / speed, dy: h.vy / speed }, steps, dt, rate, p => {
    p.speed = Math.max(0, p.speed - h.zoning.deceleration / rate);
    p.vx = p.dx * p.speed; p.vy = p.dy * p.speed;
    p.x += p.vx / rate; p.y += p.vy / rate;
    const [hitX, hitY] = zoneBounce(p, zone, h.radius);
    if (hitX) p.vx = -p.vx; if (hitY) p.vy = -p.vy;
    enemyWalls(p, h.radius, walls);
    if (p.speed > 0) { p.dx = p.vx / p.speed; p.dy = p.vy / p.speed; }
    // The later perpendicular turn is not observable yet. Hold the stop
    // position until a fresh packet establishes the next phase; do not
    // invent an unobserved turn direction or reuse Ravel's private clock.
  });
}

function liveLiquid(h, state) {
  const { area, player } = state, zone = activeZone(h, area), walls = area.walls ?? [];
  const others = (state.otherPlayers ?? []).filter(p => exposed(p, area));
  const triggerSquared = h.liquid.range ** 2 + h.radius;
  return {
    range: h.liquid.range + 128, maxSpeed: Math.hypot(h.liquid.vx, h.liquid.vy) * 5,
    initial: { x: h.x, y: h.y, vx: h.liquid.vx, vy: h.liquid.vy, active: h.liquid.active },
    step(p, bounds, target, dt, scale, timeMs, targetAfter = target) {
      // Native Liquid checks the next player position against the enemy's
      // current position, then moves using the PREVIOUS activation state.
      const near = t => (t.x - p.x) ** 2 + (t.y - p.y) ** 2 < triggerSquared;
      const active = Boolean(!player.untargetable && exposed(targetAfter, area, player.radius) &&
        near(targetAfter) || others.some(near));
      const multiplier = p.active ? 5 : 1;
      p.x += p.vx * multiplier * dt * scale; p.y += p.vy * multiplier * dt * scale;
      p.active = active;
      const [hitX, hitY] = zoneBounce(p, zone, h.radius);
      if (hitX) p.vx = -p.vx; if (hitY) p.vy = -p.vy;
      enemyWalls(p, h.radius, walls);
    },
  };
}

function slipperyPlayer(state) {
  const { player, area } = state, rate = state.tickRate ?? 60;
  const ordinary = { ...player, predictStep: undefined }, walls = area.walls ?? [];
  const speeds = new Map([[player.speedBonus, ordinary]]);
  const auras = state.auras.filter(a => a.kind === "slippery").map(a => ({
    radius: a.auraRadius + player.radius,
    path: predictHazardPath(a, area, Math.ceil(3 * rate), 1 / rate, undefined, rate),
  }));
  const slipping = (p, time) => !player.auraImmune && (player.effectsMultiplier ?? 1) > 0 &&
    exposed({ ...p, untargetable: false }, area, player.radius) && auras.some(a => {
      const at = a.path[Math.min(a.path.length - 1, Math.round(time * rate))];
      return (p.x - at.x) ** 2 + (p.y - at.y) ** 2 < a.radius ** 2;
    });
  const clip = (x, y) => {
    const originalX = x, originalY = y;
    x = clamp(x, area.x + player.radius, area.x + area.width - player.radius);
    y = clamp(y, area.y + player.radius, area.y + area.height - player.radius);
    for (const wall of walls) ({ x, y } = pushOut(x, y, player.radius, wall));
    return { x, y, hitX: x !== originalX, hitY: y !== originalY };
  };
  const moving = Math.hypot(player.vx ?? 0, player.vy ?? 0) > 0.001;
  const angle = moving ? player.slideAngle ?? Math.atan2(player.vy, player.vx) : undefined;
  const speed = () => player.immobilized ? 0 : Math.max(0,
    (player.baseSpeed ?? player.speed) * (player.speedMultiplier ?? 1) + (player.speedBonus ?? 0));
  const next = angle === undefined ? {} : clip(player.x + Math.cos(angle) * speed() / rate,
    player.y + Math.sin(angle) * speed() / rate);
  const initial = { angle, stationary: !moving, wallEscape: false,
    pendingBoost: Boolean(slipping(player, 0) && (next.hitX || next.hitY)) };
  return { ...player, motionState: initial,
    predictStep(position, action, currentPlayer, unusedArea, dt, auraMultiplier) {
      const previous = position.motionState ?? initial, active = slipping(position, position.time ?? 0);
      const direction = ACTIONS[action] ?? ACTIONS.stay;
      let dx = direction.dx, dy = direction.dy;
      if (!dx && !dy && player.mouseInput) { dx = player.mouseInput.x; dy = player.mouseInput.y; }
      const inputAngle = dx || dy ? Math.atan2(dy, dx) : undefined;
      const refresh = !active || previous.wallEscape || previous.stationary;
      let result;
      if (active) {
        // No Shift or zone speed cap while sliding. Steering refreshes AFTER
        // this step when stationary or escaping a wall, not before it.
        const velocity = currentPlayer.immobilized || previous.angle === undefined ? 0 : Math.max(0,
          (currentPlayer.baseSpeed ?? currentPlayer.speed) * (currentPlayer.speedMultiplier ?? 1) *
          (currentPlayer.ignoreAuras ? 1 : auraMultiplier) + (currentPlayer.speedBonus ?? 0)) *
          (previous.pendingBoost ? 2 : 1);
        const vx = Math.cos(previous.angle ?? 0) * velocity, vy = Math.sin(previous.angle ?? 0) * velocity;
        result = { ...clip(position.x + vx * dt, position.y + vy * dt), vx, vy };
      } else {
        if (!speeds.has(currentPlayer.speedBonus)) speeds.set(currentPlayer.speedBonus,
          { ...ordinary, speedBonus: currentPlayer.speedBonus });
        const plain = advancePlayer(position, action, speeds.get(currentPlayer.speedBonus), area, dt, auraMultiplier);
        // advancePlayer has already clipped outer walls and may have zeroed a
        // blocked velocity. Preserve that wall contact for the slide lifecycle.
        const raw = clip(plain.x, plain.y);
        const friction = (area.zones.find(z => circleInZone(position, z))?.friction ?? 1) < 1;
        raw.hitX ||= Math.abs(plain.x - position.x - plain.vx * dt) > 1e-8 ||
          plain.x === area.x + player.radius && (dx < 0 || !dx && friction && position.vx < 0) ||
          plain.x === area.x + area.width - player.radius && (dx > 0 || !dx && friction && position.vx > 0);
        raw.hitY ||= Math.abs(plain.y - position.y - plain.vy * dt) > 1e-8 ||
          plain.y === area.y + player.radius && (dy < 0 || !dy && friction && position.vy < 0) ||
          plain.y === area.y + area.height - player.radius && (dy > 0 || !dy && friction && position.vy > 0);
        result = { ...plain, ...raw };
      }
      const hit = result.hitX || result.hitY;
      return { x: result.x, y: result.y, vx: result.hitX ? 0 : result.vx, vy: result.hitY ? 0 : result.vy,
        motionState: { angle: refresh ? inputAngle : previous.angle,
          stationary: Math.hypot(result.x - position.x, result.y - position.y) < 0.001,
          wallEscape: Boolean(hit || !refresh && previous.wallEscape),
          pendingBoost: Boolean(hit || !active && previous.pendingBoost) } };
    },
  };
}

function futureIceShot(h, state, parent, fixedTarget) {
  const rate = state.tickRate ?? 60, gun = h.iceSniper;
  const atTime = time => parent[Math.min(parent.length - 1, Math.round(time * rate))];
  const shot = {
    id: `future-ice:${h.id}:${fixedTarget?.id ?? "self"}`,
    entityType: 78, forecast: true, x: h.x, y: h.y, vx: h.vx, vy: h.vy, bounce: false,
    radius: gun.radius + gun.speed / rate, harmlessUntilMs: gun.remainingMs,
    reactive: {
      // Target range is not public. Activate every retained candidate forecast;
      // the planner already culls shots that cannot reach us in its horizon.
      range: Math.hypot(state.area.width, state.area.height) + 64,
      maxSpeed: Math.max(gun.speed, Math.hypot(h.vx, h.vy)),
      initial: { x: h.x, y: h.y, vx: 0, vy: 0, elapsed: 0, born: false },
      step(p, bounds, target, dt, scale, timeMs, targetAfter = target) {
        p.elapsed += dt;
        if (p.born) { p.x += p.vx * dt; p.y += p.vy * dt; return; }
        const source = atTime(p.elapsed); p.x = source.x; p.y = source.y;
        const aim = fixedTarget ?? targetAfter;
        if (p.elapsed * 1000 + 1e-6 < gun.remainingMs || !aim ||
          (!fixedTarget && state.player.untargetable) ||
          !exposed(aim, state.area, aim.radius ?? state.player.radius)) return;
        const angle = Math.atan2(aim.y - p.y, aim.x - p.x);
        p.born = true; p.vx = Math.cos(angle) * gun.speed; p.vy = Math.sin(angle) * gun.speed;
      },
    },
  };
  // Shots aimed at other visible players are shared paths; only a shot aimed
  // at us needs candidate-dependent simulation. Target choice is not public.
  if (fixedTarget) {
    const reactive = shot.reactive;
    shot.predictPath = (area, steps, dt) => sampleTicks(reactive.initial, steps, dt, rate,
      p => reactive.step(p, null, fixedTarget, 1 / rate, 1));
    delete shot.reactive;
  }
  return fixedTarget ? shot : atNativeTicks(shot);
}

export function withLiveModels(state) {
  const hazards = state.hazards.map(h => {
    if (h.liquid) return atNativeTicks({ ...h, reactive: liveLiquid(h, state) });
    // Giant bodies need the longer corridor forecast at native tick resolution.
    // Keep ordinary Dasher navigation on its established live path: replacing
    // that coarse route forecast regressed progress in a delayed Cata replay.
    if (h.dash && h.radius * 2 >= state.area.height * 0.25) return atNativeTicks(h);
    if (h.motionEffects?.length) return h;
    if (h.zoning) return { ...h, predictPath: (a, n, dt, r) => predictLiveZoning(h, a, n, dt, r) };
    if (h.icicle) return { ...h, predictPath: (a, n, dt, r) => predictLiveIcicle(h, a, n, dt, r) };
    if (h.turning) return { ...h, predictPath: (a, n, dt, r) => predictLiveTurning(h, a, n, dt, r) };
    // The existing live Dasher and causal Spiral models already use live rules.
    return h;
  });
  for (const h of state.hazards) {
    if (!h.iceSniper || h.motionEffects?.length || h.iceSniper.remainingMs > 2400) continue;
    const rate = state.tickRate ?? 60;
    const parent = predictHazardPath(h, state.area, Math.ceil(3 * rate), 1 / rate, undefined, rate);
    hazards.push(futureIceShot(h, state, parent));
    for (const other of state.otherPlayers ?? [])
      if (exposed(other, state.area)) hazards.push(futureIceShot(h, state, parent, other));
  }
  let player = state.player;
  if (state.auras?.some(a => a.kind === "slippery")) player = slipperyPlayer(state);
  return { ...state, hazards, player };
}

export function prepareLivePlanning(state, { heading = "right", objective, decisionMs = 50,
  previousIntervalTicks } = {}) {
  let prepared = withLiveModels(state);
  // A backward transition discards progress. Keep the entry refuge usable and
  // permit walking out of an exit if the observation starts inside it.
  if (!objective) {
    const { dx, dy } = ACTIONS[heading];
    const midpoint = (state.area.x + state.area.width / 2) * dx +
      (state.area.y + state.area.height / 2) * dy;
    const backwards = state.area.zones.filter(z => (z.type === 2 || z.type === 6) &&
      (z.x + z.width / 2) * dx + (z.y + z.height / 2) * dy < midpoint &&
      !circleInZone(state.player, z, -state.player.radius));
    if (backwards.length) prepared = { ...prepared,
      area: { ...state.area, walls: [...(state.area.walls ?? []), ...backwards] } };
  }
  const giantDasher = state.hazards.some(h => h.dash && h.radius * 2 >= state.area.height * 0.25);
  const slipping = Boolean(prepared.player.predictStep);
  // Use the observed command cadence, not network round-trip delay, to space
  // follow-up turns. Round to server ticks and keep pathological stalls bounded.
  let inputIntervalTicks = Math.max(1, Math.min(12,
    Math.ceil(Math.max(1000 / (state.tickRate ?? 60), decisionMs) * (state.tickRate ?? 60) / 1000)));
  // Increase immediately on sustained slower observations; require half a
  // tick of headroom to decrease. Small timing noise must not discard every
  // retained plan by toggling its input grid between adjacent tick intervals.
  if (Number.isInteger(previousIntervalTicks) && previousIntervalTicks > inputIntervalTicks &&
    decisionMs > (previousIntervalTicks - 1.5) * 1000 / (state.tickRate ?? 60))
    inputIntervalTicks = previousIntervalTicks;
  return { state: prepared,
    options: { horizon: slipping ? 2 : giantDasher ? 1.5 : 0.9, inputIntervalTicks },
    models: { icicle: state.hazards.filter(h => h.icicle && !h.motionEffects?.length).length,
      zoning: state.hazards.filter(h => h.zoning && !h.motionEffects?.length).length,
      turning: state.hazards.filter(h => h.turning && !h.motionEffects?.length).length,
      liquid: state.hazards.filter(h => h.liquid).length,
      iceShots: prepared.hazards.filter(h => h.forecast).length, slippery: slipping } };
}
