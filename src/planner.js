export const ACTIONS = {
  stay: { dx: 0, dy: 0, keys: [] },
  up: { dx: 0, dy: -1, keys: ["ArrowUp"] },
  down: { dx: 0, dy: 1, keys: ["ArrowDown"] },
  left: { dx: -1, dy: 0, keys: ["ArrowLeft"] },
  right: { dx: 1, dy: 0, keys: ["ArrowRight"] },
  up_left: {
    dx: -1,
    dy: -1,
    keys: ["ArrowUp", "ArrowLeft"],
  },
  up_right: {
    dx: 1,
    dy: -1,
    keys: ["ArrowUp", "ArrowRight"],
  },
  down_left: {
    dx: -1,
    dy: 1,
    keys: ["ArrowDown", "ArrowLeft"],
  },
  down_right: {
    dx: 1,
    dy: 1,
    keys: ["ArrowDown", "ArrowRight"],
  },
};
// Focus is an ordinary Shift keypress and halves speed on both axes.
for (const [name, direction] of Object.entries(ACTIONS)) {
  if (name !== "stay")
    ACTIONS[`focus_${name}`] = {
      ...direction,
      scale: 0.5,
      keys: ["Shift", ...direction.keys],
    };
}
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const distance = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

// Index swept enemy bounds separately for every prediction tick. Queries still
// use exact circles/segments; bins only remove enemies too far away to matter.
function indexPaths(paths, area, steps, padding = 0) {
  const cellSize = 128;
  const nx = Math.ceil(area.width / cellSize),
    ny = Math.ceil(area.height / cellSize);
  const cells = nx * ny;
  if (!paths.length) return () => undefined;
  if (cells > 4096) return () => paths;
  const bins = new Array(cells * steps);
  for (const path of paths) {
    const radius = (path.queryRadius ?? path.radius) + padding;
    for (let step = 0; step < steps; step++) {
      const a = path.positions[step],
        b = path.positions[step + 1];
      const left = Math.max(
        0,
        Math.floor((Math.min(a.x, b.x) - radius - area.x) / cellSize),
      );
      const right = Math.min(
        nx - 1,
        Math.floor((Math.max(a.x, b.x) + radius - area.x) / cellSize),
      );
      const top = Math.max(
        0,
        Math.floor((Math.min(a.y, b.y) - radius - area.y) / cellSize),
      );
      const bottom = Math.min(
        ny - 1,
        Math.floor((Math.max(a.y, b.y) + radius - area.y) / cellSize),
      );
      for (let y = top; y <= bottom; y++)
        for (let x = left; x <= right; x++) {
          const index = step * cells + y * nx + x;
          (bins[index] ??= []).push(path);
        }
    }
  }
  return (position, step) =>
    bins[
      step * cells +
        clamp(Math.floor((position.y - area.y) / cellSize), 0, ny - 1) * nx +
        clamp(Math.floor((position.x - area.x) / cellSize), 0, nx - 1)
    ];
}

// Minimum circle-to-circle separation over an entire linear segment.
export function sweptClearance(p0, p1, h0, h1, radius) {
  const x = p0.x - h0.x,
    y = p0.y - h0.y;
  const dx = p1.x - p0.x - h1.x + h0.x;
  const dy = p1.y - p0.y - h1.y + h0.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator ? clamp(-(x * dx + y * dy) / denominator, 0, 1) : 0;
  return Math.sqrt((x + dx * t) ** 2 + (y + dy * t) ** 2) - radius;
}

export function hazardActiveFrom(hazard, tickRate = 60) {
  // Reserve one server tick at activation; never predict a future safe phase.
  return Math.max(0, (hazard.harmlessUntilMs ?? 0) / 1000 - 1 / tickRate);
}

// Check only the lethal part of a swept segment. This also handles activation
// between coarse navigation samples without blocking a completed safe crossing.
export function trajectoryClearance(p0, p1, h0, h1, trajectory, from, to) {
  if (trajectory.activeFrom > to) return Infinity;
  if (trajectory.activeFrom > from) {
    const fraction = (trajectory.activeFrom - from) / (to - from);
    p0 = {
      x: p0.x + (p1.x - p0.x) * fraction,
      y: p0.y + (p1.y - p0.y) * fraction,
    };
    h0 = {
      x: h0.x + (h1.x - h0.x) * fraction,
      y: h0.y + (h1.y - h0.y) * fraction,
    };
  }
  return sweptClearance(p0, p1, h0, h1, trajectory.radius);
}

export function circleInZone(p, zone, radius = 0) {
  return (
    p.x - radius >= zone.x &&
    p.x + radius <= zone.x + zone.width &&
    p.y - radius >= zone.y &&
    p.y + radius <= zone.y + zone.height
  );
}

// Triangle-wave reflection handles multiple bounces, including negative velocity.
export function reflectedPosition(position, velocity, time, min, max) {
  const width = max - min;
  if (width <= 0) return (min + max) / 2;
  const phase =
    (((position - min + velocity * time) % (2 * width)) + 2 * width) %
    (2 * width);
  return min + (phase <= width ? phase : 2 * width - phase);
}

export function hazardPosition(hazard, area, time, tickRate = 60) {
  if (hazard.motion === "perimeter")
    return perimeterPath(hazard, area, 1, time, tickRate)[1];
  const zone =
    hazard.bounce !== false &&
    area.zones.find((z) => z.type === 0 && circleInZone(hazard, z));
  if (!zone)
    return { x: hazard.x + hazard.vx * time, y: hazard.y + hazard.vy * time };
  return {
    x: reflectedPosition(
      hazard.x,
      hazard.vx,
      time,
      zone.x + hazard.radius,
      zone.x + zone.width - hazard.radius,
    ),
    y: reflectedPosition(
      hazard.y,
      hazard.vy,
      time,
      zone.y + hazard.radius,
      zone.y + zone.height - hazard.radius,
    ),
  };
}

// Dasher telemetry includes its prepare/dash/rest phase. Current velocity alone
// predicts that a paused dasher stays still, just before it launches at us.
function motionScaleAt(effects, timeMs) {
  let scale = 1;
  for (const effect of effects)
    if (effect.remainingMs === undefined || timeMs < effect.remainingMs)
      scale = Math.min(scale, effect.scale);
  return scale;
}

// Integrate effect changes inside a tick instead of rounding a stop's expiry
// down and inventing early movement away from the player.
function averageMotionScale(effects, fromMs, toMs) {
  let at = fromMs,
    scaledMs = 0;
  while (at < toMs) {
    let end = toMs;
    for (const effect of effects)
      if (effect.remainingMs > at && effect.remainingMs < end)
        end = effect.remainingMs;
    scaledMs += (end - at) * motionScaleAt(effects, at);
    at = end;
  }
  return scaledMs / (toMs - fromMs);
}

// Wall balls discard overshoot at a corner, rotate, then move along the next
// edge on the following server tick. Continuous perimeter distance puts them
// several units too far past the corner, inventing room for a crossing player.
function perimeterPath(hazard, area, steps, dt, tickRate) {
  const zone =
    hazard.bounce !== false &&
    area.zones.find((z) => z.type === 0 && circleInZone(hazard, z));
  const effects = hazard.motionEffects ?? [];
  const scale = motionScaleAt(effects, 0);
  let vx = hazard.baseVx ?? (scale > 0 ? hazard.vx / scale : 0),
    vy = hazard.baseVy ?? (scale > 0 ? hazard.vy / scale : 0),
    x = hazard.x,
    y = hazard.y,
    tick = 0;
  const clockwise =
    zone &&
    (x - zone.x - zone.width / 2) * vy - (y - zone.y - zone.height / 2) * vx >
      0;
  const path = [];
  for (let i = 0; i <= steps; i++) {
    const targetTick = i * dt * tickRate,
      whole = Math.floor(targetTick + 1e-9);
    while (tick < whole) {
      const amount =
        averageMotionScale(
          effects,
          (tick * 1000) / tickRate,
          ((tick + 1) * 1000) / tickRate,
        ) / tickRate;
      x += vx * amount;
      y += vy * amount;
      if (zone) {
        const nextX = clamp(
            x,
            zone.x + hazard.radius,
            zone.x + zone.width - hazard.radius,
          ),
          nextY = clamp(
            y,
            zone.y + hazard.radius,
            zone.y + zone.height - hazard.radius,
          );
        if (nextX !== x || nextY !== y) {
          const oldVx = vx;
          vx = clockwise ? -vy : vy;
          vy = clockwise ? oldVx : -oldVx;
          x = nextX;
          y = nextY;
        }
      }
      tick++;
    }
    const fraction = Math.max(0, targetTick - whole);
    const amount =
      fraction > 0
        ? (fraction / tickRate) *
          averageMotionScale(
            effects,
            (tick * 1000) / tickRate,
            ((tick + fraction) * 1000) / tickRate,
          )
        : 0;
    path.push({ x: x + vx * amount, y: y + vy * amount });
  }
  return path;
}

function homingModel(hazard, area, dt) {
  const h = hazard.reactive ?? hazard.homing;
  const zone =
    hazard.bounce !== false &&
    area.zones.find((z) => z.type === 0 && circleInZone(hazard, z));
  const turn = (h.turnRate ?? 1.5) * dt;
  return {
    ...h,
    speed: h.speed ?? Math.hypot(hazard.vx, hazard.vy),
    rangeSquared: (h.range ?? 200) ** 2,
    turn,
    cosTurn: Math.cos(turn),
    sinTurn: Math.sin(turn),
    tanTurn: Math.tan(turn),
    left: zone ? zone.x + hazard.radius : -Infinity,
    right: zone ? zone.x + zone.width - hazard.radius : Infinity,
    top: zone ? zone.y + hazard.radius : -Infinity,
    bottom: zone ? zone.y + zone.height - hazard.radius : Infinity,
  };
}

function homingStart(hazard) {
  if (hazard.reactive) return { ...hazard.reactive.initial };
  const angle =
    hazard.homing.heading ??
    Math.atan2(hazard.vy, hazard.vx) + (hazard.homing.reverse ? Math.PI : 0);
  const speed =
    (hazard.homing.speed ?? Math.hypot(hazard.vx, hazard.vy)) *
    (hazard.homing.reverse ? -1 : 1);
  return {
    x: hazard.x,
    y: hazard.y,
    angle,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
  };
}

// Mutate only the branch's private enemy state. A homing enemy reacts to that
// branch's player path, so a single shared straight forecast cannot check it.
function stepHoming(position, model, target, dt, scale, timeMs, targetAfter) {
  if (typeof model.step === "function")
    return model.step(position, model, target, dt, scale, timeMs, targetAfter);
  const tau = 2 * Math.PI;
  if (timeMs >= (model.stunMs ?? 0) && target) {
    const dx = target.x - position.x,
      dy = target.y - position.y;
    if (dx * dx + dy * dy <= model.rangeSquared) {
      // Cross/dot products give the same turn side and angular threshold
      // without atan2/modulo in the inner search loop. Use the angle rule near
      // boundaries, where floating-point roundoff can change the chosen side.
      const orientation = model.reverse ? -1 : 1;
      const cross = (position.vx * dy - position.vy * dx) * orientation;
      const dot = (position.vx * dx + position.vy * dy) * orientation;
      let sign;
      if (
        model.turn >= Math.PI / 2 ||
        Math.abs(cross) < 1e-8 ||
        (cross < 0 && dot > 0 && Math.abs(-cross - dot * model.tanTurn) < 1e-8)
      ) {
        const desired = Math.atan2(dy, dx);
        const difference = (((position.angle - desired) % tau) + tau) % tau;
        sign = difference >= model.turn ? (difference < Math.PI ? -1 : 1) : 0;
      } else
        sign =
          cross > 0 ? 1 : dot <= 0 || -cross >= dot * model.tanTurn ? -1 : 0;
      if (sign) {
        position.angle += sign * model.turn;
        // Rotate the existing vector; do not recompute trig for every enemy
        // on every tick of every candidate. Out-of-range enemies keep it.
        const vx = position.vx;
        position.vx = vx * model.cosTurn - position.vy * model.sinTurn * sign;
        position.vy = vx * model.sinTurn * sign + position.vy * model.cosTurn;
      }
    }
  }
  position.x += position.vx * scale * dt;
  position.y += position.vy * scale * dt;
  if (position.x < model.left || position.x > model.right) {
    position.x =
      position.x < model.left
        ? 2 * model.left - position.x
        : 2 * model.right - position.x;
    position.angle = Math.PI - position.angle;
    position.vx = -position.vx;
  }
  if (position.y < model.top || position.y > model.bottom) {
    position.y =
      position.y < model.top
        ? 2 * model.top - position.y
        : 2 * model.bottom - position.y;
    position.angle = -position.angle;
    position.vy = -position.vy;
  }
}

function spiralPath(hazard, area, steps, dt, tickRate) {
  const zone =
    hazard.bounce !== false &&
    area.zones.find((z) => z.type === 0 && circleInZone(hazard, z));
  const model = hazard.spiral,
    heading = Math.atan2(hazard.vy, hazard.vx);
  let x = hazard.x,
    y = hazard.y,
    tick = 0,
    flipX = 1,
    flipY = 1;
  const path = [{ x, y }];
  const advance = () => {
    const time = (tick + 1) / tickRate;
    const angle =
      heading +
      model.turnRate * time +
      (model.turnAcceleration * time * time) / 2;
    let nx = x + (Math.cos(angle) * model.speed * flipX) / tickRate,
      ny = y + (Math.sin(angle) * model.speed * flipY) / tickRate;
    let fx = flipX,
      fy = flipY;
    if (zone) {
      const left = zone.x + hazard.radius,
        right = zone.x + zone.width - hazard.radius,
        top = zone.y + hazard.radius,
        bottom = zone.y + zone.height - hazard.radius;
      if (nx < left || nx > right) {
        nx = reflectedPosition(nx, 0, 0, left, right);
        fx = -fx;
      }
      if (ny < top || ny > bottom) {
        ny = reflectedPosition(ny, 0, 0, top, bottom);
        fy = -fy;
      }
    }
    return { x: nx, y: ny, flipX: fx, flipY: fy };
  };
  for (let i = 1; i <= steps; i++) {
    const end = i * dt,
      until = Math.floor(end * tickRate + 1e-9);
    while (tick < until) {
      const next = advance();
      x = next.x;
      y = next.y;
      flipX = next.flipX;
      flipY = next.flipY;
      tick++;
    }
    // Coarse navigation samples interpolate the same server-tick path used by
    // local collision checks, including fractional samples and reflected ticks.
    const fraction = Math.max(0, end * tickRate - tick);
    if (fraction > 1e-9) {
      const next = advance();
      path.push({
        x: x + (next.x - x) * fraction,
        y: y + (next.y - y) * fraction,
      });
    } else path.push({ x, y });
  }
  return path;
}

export function predictHazardPath(
  hazard,
  area,
  steps,
  dt,
  targetAt,
  tickRate = 60,
) {
  // Optional simulator or live-adapter model; raw observations stay serializable.
  // Both local search and navigation use this entry point for their forecasts.
  if (typeof hazard.predictPath === "function")
    return hazard.predictPath(area, steps, dt, tickRate, targetAt);
  const effects = hazard.motionEffects;
  if (hazard.motion === "perimeter")
    return perimeterPath(hazard, area, steps, dt, tickRate);
  if (hazard.spiral && !effects?.length)
    return spiralPath(hazard, area, steps, dt, tickRate);
  if (hazard.homing || hazard.reactive) {
    const model = homingModel(hazard, area, dt),
      position = homingStart(hazard);
    const path = [{ x: position.x, y: position.y }];
    for (let i = 0; i < steps; i++) {
      const scale = effects?.length
        ? averageMotionScale(effects, i * dt * 1000, (i + 1) * dt * 1000)
        : 1;
      stepHoming(position, model, targetAt?.(i * dt), dt, scale, i * dt * 1000,
        hazard.reactive ? targetAt?.((i + 1) * dt) : undefined);
      path.push({ x: position.x, y: position.y });
    }
    return path;
  }
  if (!hazard.dash && !effects?.length)
    return Array.from({ length: steps + 1 }, (_, i) =>
      hazardPosition(hazard, area, i * dt),
    );
  if (!hazard.dash) {
    const scale = motionScaleAt(effects, 0);
    const base = {
      ...hazard,
      vx: hazard.baseVx ?? (scale > 0 ? hazard.vx / scale : 0),
      vy: hazard.baseVy ?? (scale > 0 ? hazard.vy / scale : 0),
    };
    let movingTime = 0;
    const path = [{ x: hazard.x, y: hazard.y }];
    for (let i = 0; i < steps; i++) {
      movingTime +=
        dt * averageMotionScale(effects, i * dt * 1000, (i + 1) * dt * 1000);
      path.push(hazardPosition(base, area, movingTime));
    }
    return path;
  }
  const zone = area.zones.find((z) => z.type === 0 && circleInZone(hazard, z));
  let { preparing, dashing, resting, peak, dx, dy, scale = 1 } = hazard.dash;
  // Older traces or an unrecognized effect can contradict the phase model.
  // Honor measured suppression when the phase implies substantial movement.
  // Near the natural end of preparation, zero speed is expected; keep predicting
  // the imminent launch rather than treating that normal pause as a freeze.
  if (
    !effects?.length &&
    Number.isFinite(hazard.vx) &&
    Number.isFinite(hazard.vy)
  ) {
    const expected =
      preparing > 0
        ? (peak / 5) * (1 - preparing / 750)
        : dashing > 0
          ? peak * (1 - dashing / 3000)
          : 0;
    const observed = Math.hypot(hazard.vx, hazard.vy);
    if (expected > 5 && observed < expected * 0.8)
      scale = Math.min(scale, observed / expected);
  }
  let x = hazard.x,
    y = hazard.y;
  const path = [{ x, y }];
  const tickMs = dt * 1000;
  for (let i = 0; i < steps; i++) {
    let speed = 0;
    if (preparing > 0) {
      preparing += tickMs;
      if (preparing > 750) {
        preparing = 0;
        dashing += tickMs;
        speed = peak;
      } else speed = (peak / 5) * (1 - preparing / 750);
    } else if (dashing > 0) {
      dashing += tickMs;
      if (dashing > 3000) dashing = 0;
      else speed = peak * (1 - dashing / 3000);
    } else if (resting < 750) resting += tickMs;
    else {
      resting = 0;
      preparing += tickMs;
      speed = peak / 5;
    }
    const effectiveScale = effects?.length
      ? averageMotionScale(effects, i * tickMs, (i + 1) * tickMs)
      : scale;
    x += dx * speed * effectiveScale * dt;
    y += dy * speed * effectiveScale * dt;
    if (zone) {
      const left = zone.x + hazard.radius,
        right = zone.x + zone.width - hazard.radius;
      const top = zone.y + hazard.radius,
        bottom = zone.y + zone.height - hazard.radius;
      if (x < left) {
        x = 2 * left - x;
        dx = Math.abs(dx);
      } else if (x > right) {
        x = 2 * right - x;
        dx = -Math.abs(dx);
      }
      if (y < top) {
        y = 2 * top - y;
        dy = Math.abs(dy);
      } else if (y > bottom) {
        y = 2 * bottom - y;
        dy = -Math.abs(dy);
      }
    }
    path.push({ x, y });
  }
  return path;
}

// Segment vs. expanded rectangle, conservative at corners. Also catches thin
// walls that would fall entirely between two simulation samples.
export function hitsRectangle(from, to, rectangle, radius) {
  // Most candidate steps are far from any wall (including the backward-exit
  // guard). Reject disjoint bounds before the more expensive slab intersection.
  if (
    Math.max(from.x, to.x) + radius < rectangle.x ||
    Math.min(from.x, to.x) - radius > rectangle.x + rectangle.width ||
    Math.max(from.y, to.y) + radius < rectangle.y ||
    Math.min(from.y, to.y) - radius > rectangle.y + rectangle.height
  ) return false;
  let enter = 0,
    leave = 1;
  for (const [axis, size] of [
    ["x", "width"],
    ["y", "height"],
  ]) {
    const min = rectangle[axis] - radius,
      max = rectangle[axis] + rectangle[size] + radius;
    const movement = to[axis] - from[axis];
    if (Math.abs(movement) < 1e-9) {
      if (from[axis] < min || from[axis] > max) return false;
    } else {
      const a = (min - from[axis]) / movement,
        b = (max - from[axis]) / movement;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
      if (enter > leave) return false;
    }
  }
  return true;
}

export function targetFor(state, heading = "right") {
  const { area, player } = state;
  const { dx, dy } = ACTIONS[heading];
  const exits = area.zones.filter((z) => z.type === 2 || z.type === 6);
  exits.sort(
    (a, b) =>
      (b.x + b.width / 2) * dx +
      (b.y + b.height / 2) * dy -
      (a.x + a.width / 2) * dx -
      (a.y + a.height / 2) * dy,
  );
  if (exits.length)
    return {
      x: exits[0].x + exits[0].width / 2,
      y: dx
        ? clamp(
            player.y,
            exits[0].y + player.radius,
            exits[0].y + exits[0].height - player.radius,
          )
        : exits[0].y + exits[0].height / 2,
    };
  return {
    x: dx
      ? area.x + (dx > 0 ? area.width - player.radius : player.radius)
      : player.x,
    y: dy
      ? area.y + (dy > 0 ? area.height - player.radius : player.radius)
      : player.y,
  };
}

// Simulate one server tick, including coasting when a direction is released.
export function advancePlayer(
  position,
  action,
  player,
  area,
  dt = 1 / 60,
  auraMultiplier = 1,
) {
  // Optional environment-specific movement model (e.g. a slippery floor).
  if (typeof player.predictStep === "function")
    return player.predictStep(position, action, player, area, dt, auraMultiplier);
  const direction = ACTIONS[action] ?? ACTIONS.stay;
  const zone = area.zones.find((z) => circleInZone(position, z));
  let speed = player.baseSpeed ?? player.speed;
  if (Number.isFinite(zone?.minimumSpeed))
    speed = Math.max(speed, zone.minimumSpeed);
  else if (Number.isFinite(zone?.maximumSpeed))
    speed = Math.min(speed, zone.maximumSpeed);
  speed = player.immobilized
    ? 0
    : (speed *
        (player.speedMultiplier ?? 1) *
        (player.ignoreAuras ? 1 : auraMultiplier) +
        (player.speedBonus ?? 0)) *
      (direction.scale ?? 1);
  const friction = Number.isFinite(zone?.friction)
    ? clamp(1 - zone.friction, 0, 1)
    : 0;
  // Releasing every direction hands control back to the mouse/gamepad when
  // pointer movement is active. It is not a brake in that mode. Match the
  // client's analog input, including reduced speed near the canvas center.
  let dx = direction.dx,
    dy = direction.dy;
  if (!dx && !dy && player.mouseInput) {
    const magnitude = Math.hypot(player.mouseInput.x, player.mouseInput.y);
    dx = magnitude > 0 ? player.mouseInput.x / magnitude : 0;
    dy = magnitude > 0 ? player.mouseInput.y / magnitude : 0;
    speed *= Math.min(1, magnitude / 150);
  }
  const vx = clamp(dx * speed + (position.vx ?? 0) * friction, -speed, speed);
  const vy = clamp(dy * speed + (position.vy ?? 0) * friction, -speed, speed);
  const x = clamp(
    position.x + vx * dt,
    area.x + player.radius,
    area.x + area.width - player.radius,
  );
  const y = clamp(
    position.y + vy * dt,
    area.y + player.radius,
    area.y + area.height - player.radius,
  );
  return { x, y, vx: x === position.x ? 0 : vx, vy: y === position.y ? 0 : vy };
}

export function planActions(
  state,
  {
    heading = "right",
    horizon = 0.9,
    margin = 14,
    previousAction = "stay",
    reactionTime = 0.15,
    inputIntervalTicks = 1,
    pendingInputs = [],
    segmentTime = 0.15,
    firstSegmentTime,
    beamWidth = 3,
    fastPath = true,
    focusRecovery = true,
    navigation,
    continuation,
    objective,
    maxPlanMs = Infinity,
    now = () => performance.now(),
  } = {},
) {
  if (!Number.isInteger(inputIntervalTicks) || inputIntervalTicks < 1)
    throw new RangeError("inputIntervalTicks must be a positive integer");
  // A deadline limits optional search, never collision-checking a returned path.
  const deadline = Number.isFinite(maxPlanMs)
    ? now() + Math.max(0, maxPlanMs)
    : Infinity;
  const expired = () => deadline !== Infinity && now() >= deadline;
  const { player: p, area, hazards } = state;
  const target = objective ?? targetFor(state, heading);
  const goal = area.zones.find(
    (z) =>
      !objective && (z.type === 2 || z.type === 6) && circleInZone(target, z),
  );
  const distanceBefore = distance(p, target);
  const routeAge =
    navigation?.packet !== undefined
      ? Math.max(0, (state.packet - navigation.packet) / (state.tickRate ?? 60))
      : 0;
  const routeRemaining = navigation?.distanceAt
    ? (position, time = 0) => navigation.distanceAt(position, routeAge + time)
    : (position) => distance(position, target);
  const remaining = objective
    ? (position, time = 0) =>
        distance(position, target) <= objective.radius
          ? 0
          : routeRemaining(position, time)
    : routeRemaining;
  const routeBefore = remaining(p);
  const speed = Math.max(
    0,
    p.speed,
    (p.baseSpeed ?? 0) * (p.speedMultiplier ?? 1) + (p.speedBonus ?? 0),
    ...area.zones.map(
      (z) =>
        (z.minimumSpeed ?? 0) * (p.speedMultiplier ?? 1) + (p.speedBonus ?? 0),
    ),
  );
  // Cover up to one input frame of timing error at the current speed. At 17
  // speed, a 25ms mismatch is almost a full player radius.
  margin += speed * Math.min(0.025, reactionTime);
  const tickRate = state.tickRate > 0 ? state.tickRate : 60;
  const steps = Math.ceil((horizon + reactionTime) * tickRate),
    dt = 1 / tickRate;
  // A key received between server updates affects the next update. Latency
  // fitting also samples at tick ENDS; using starts here delays every queued
  // reversal by another frame (22 units of error per axis at 660 speed).
  const reactionSteps = Math.max(
    0,
    Math.ceil(reactionTime * tickRate - 1e-9) - 1,
  );
  const candyExpires =
    p.candy?.active &&
    Number.isFinite(p.candy.remainingMs) &&
    Number.isFinite(p.speedBonusWithoutCandy)
      ? Math.max(0, Math.ceil((p.candy.remainingMs * tickRate) / 1000))
      : Infinity;
  const afterCandy =
    candyExpires < steps ? { ...p, speedBonus: p.speedBonusWithoutCandy } : p;
  const totalTime = steps * dt;
  const queuedActions = Array.from(
    { length: reactionSteps },
    (_, i) =>
      pendingInputs.findLast((input) => input.time <= (i + 1) * dt + 1e-9)
        ?.action ?? previousAction,
  );
  // Follow-up turns must fall on updates where another input can be sent.
  // Otherwise a retained plan can require a turn between two observations.
  const alignInput = ticks => Math.max(inputIntervalTicks,
    Math.ceil(ticks / inputIntervalTicks) * inputIntervalTicks);
  const segmentSteps = alignInput(Math.max(1, Math.round(segmentTime / dt)));
  // Bound the distance covered before the first possible turn. A 150 ms
  // segment at Candy speed travels 99 units on EACH axis.
  const firstSteps = Math.min(
    segmentSteps,
    alignInput(Math.max(1, Math.round((firstSegmentTime ?? 66 / Math.max(1, speed)) / dt))),
  );
  const walls = [
    ...(area.walls ?? []),
    ...area.zones.filter((z) => z.type === 3),
    ...(objective
      ? area.zones.filter((z) => z.type === 2 || z.type === 6)
      : []),
  ];
  const safeZones = area.zones.filter((z) => z.type === 4);
  // Keep the clearance buffer until the retreat is well inside shelter. A
  // one-tick error in a queued release must not turn "safe" into an exposed
  // stop at the entrance. Outer map walls cannot be crossed, so do not inset
  // those sides: hugging a wall deep inside a refuge is still sheltered.
  const shelterBounds = safeZones.map((z) => {
    const left = z.x + (z.x > area.x ? margin : 0),
      top = z.y + (z.y > area.y ? margin : 0),
      right =
        z.x + z.width - (z.x + z.width < area.x + area.width ? margin : 0),
      bottom =
        z.y + z.height - (z.y + z.height < area.y + area.height ? margin : 0);
    return { x: left, y: top, width: right - left, height: bottom - top };
  });
  const auraPaths = (state.auras ?? []).map((aura) => ({
    ...aura,
    queryRadius: p.radius + aura.auraRadius,
    multiplier: Math.max(0, 1 - aura.reduction * (p.effectsMultiplier ?? 1)),
    positions: predictHazardPath(aura, area, steps, dt, undefined, tickRate),
  }));
  const aurasAt = indexPaths(auraPaths, area, steps);
  const homing = [];
  const trajectories = hazards
    .filter((h) => hazardActiveFrom(h, tickRate) <= totalTime)
    .filter(
      (h) =>
        distance(p, h) <=
        (Math.SQRT2 * speed +
          Math.max(
            Math.hypot(h.vx, h.vy),
            h.dash?.peak ?? 0,
            h.homing?.speed ?? 0,
            h.reactive?.maxSpeed ?? 0,
          )) *
          totalTime +
          p.radius +
          h.radius +
          margin +
          80,
    )
    .map((h) => {
      const trajectory = {
        id: h.id,
        radius:
          p.radius +
          h.radius * (h.square ? Math.SQRT2 : 1) +
          (h.spiral?.padding ?? 0),
        activeFrom: hazardActiveFrom(h, tickRate),
      };
      if (h.homing || h.reactive) {
        const config = {
          id: h.id,
          radius: trajectory.radius,
          activeFrom: trajectory.activeFrom,
          initial: homingStart(h),
          model: homingModel(h, area, dt),
          scales: Array.from({ length: steps }, (_, i) =>
            h.motionEffects?.length
              ? averageMotionScale(
                  h.motionEffects,
                  i * dt * 1000,
                  (i + 1) * dt * 1000,
                )
              : 1,
          ),
        };
        if (config.scales.some((scale) => scale > 0)) {
          trajectory.homingIndex = homing.length;
          homing.push(config);
          trajectory.queryRadius = Math.max(
            trajectory.radius,
            h.reactive?.range ?? h.homing?.range ?? 200,
          );
        }
        // If it cannot move anywhere in this horizon, its turning cannot alter
        // clearance. Its frozen collision body still remains in the spatial index.
        // Until this branch enters targeting range, motion is independent of
        // its player path. Share that exact no-target forecast across branches.
        // Keep velocity/heading at each tick so pursuit can start without a jump.
        const position = { ...config.initial };
        trajectory.positions = [{ ...position }];
        for (let i = 0; i < steps; i++) {
          stepHoming(
            position,
            config.model,
            undefined,
            dt,
            config.scales[i],
            i * dt * 1000,
          );
          trajectory.positions.push({ ...position });
        }
      } else
        trajectory.positions = predictHazardPath(
          h,
          area,
          steps,
          dt,
          undefined,
          tickRate,
        );
      return trajectory;
    });
  // Scores saturate at 60 units of padded clearance. Beyond that, keep a
  // conservative lower bound and skip exact distances that cannot change a
  // collision, score, or guard decision. Cover the player's entire next step.
  const clearanceLimit = margin + 64;
  const staticAt = indexPaths(
    trajectories,
    area,
    steps,
    clearanceLimit + speed * dt,
  );
  const score = (node) => {
    const progress = routeBefore - remaining(node, node.time);
    return (
      (node.physicalClearance <= 0
        ? -100000 + node.firstCollision * 10000
        : 0) +
      (node.clearance < 0 ? -10000 : 0) -
      // When every route breaches the buffer, recover clearance before
      // chasing progress. A one-pixel graze is not a usable escape at 660.
      2000 * (Math.max(0, -node.clearance) / Math.max(1, margin)) ** 2 -
      (node.blocked ? 1000000 : 0) +
      Math.min(node.clearance, 60) * 0.6 +
      progress * 0.65 +
      node.progressIntegral * 0.35 -
      (node.ineffective ? 35 : 0) +
      (node.firstProgress ?? 0) * 0.25 -
      node.dangerCost * 0.04 +
      (node.goalTime !== undefined
        ? 1000 + (horizon - node.goalTime) * 100
        : 0) +
      (node.rescueTime !== undefined
        ? 1000 + (horizon - node.rescueTime) * 100
        : 0) -
      node.turns * 1.5 +
      (node.firstAction === previousAction ? 1 : 0)
    );
  };
  let unavoidableCollision = false;
  const extend = (node, action, from, to) => {
    const child = {
      ...node,
      lastAction: action,
      path: [...node.path, action],
      inputs: [...node.inputs, { tick: from, action }],
      turns: node.turns + (node.lastAction !== action ? 1 : 0),
      homing: node.homing?.slice(),
    };
    for (const i of child.homingIndices ?? [])
      child.homing[i] = { ...child.homing[i] };
    const homingBefore = homing.length ? { x: 0, y: 0 } : undefined;
    for (let step = from + 1; step <= to; step++) {
      if (
        child.goalTime !== undefined ||
        child.blocked ||
        (step > reactionSteps &&
          child.physicalClearance <= 0 &&
          !unavoidableCollision)
      )
        break;
      const time = step * dt;
      let auraMultiplier = 1;
      const localAuras = p.ignoreAuras ? undefined : aurasAt(child, step - 1);
      if (
        localAuras?.length &&
        !safeZones.some((z) => circleInZone(child, z, p.radius))
      ) {
        const applied = new Set();
        for (const aura of localAuras) {
          const other = aura.positions[step - 1];
          if (
            !applied.has(aura.type) &&
            (child.x - other.x) ** 2 + (child.y - other.y) ** 2 <
              aura.queryRadius ** 2
          ) {
            applied.add(aura.type);
            auraMultiplier *= aura.multiplier;
          }
        }
      }
      const next = advancePlayer(
        child,
        step <= reactionSteps ? queuedActions[step - 1] : action,
        step > candyExpires ? afterCandy : p,
        area,
        dt,
        auraMultiplier,
      );
      if (
        (area.zones.length &&
          !area.zones.some((z) => z.type !== 3 && circleInZone(next, z))) ||
        walls.some((w) => hitsRectangle(child, next, w, p.radius))
      )
        child.blocked = true;
      let gap = clearanceLimit;
      let nearestHazard;
      const sheltered = shelterBounds.some(
        (z) =>
          circleInZone(child, z, p.radius) && circleInZone(next, z, p.radius),
      );
      for (const i of child.homingIndices ?? []) {
        const config = homing[i];
        const position = child.homing[i];
        homingBefore.x = position.x;
        homingBefore.y = position.y;
        stepHoming(
          position,
          config.model,
          child,
          dt,
          config.scales[step - 1],
          (step - 1) * dt * 1000,
          next,
        );
        if (!sheltered) {
          const separation = trajectoryClearance(
            child,
            next,
            homingBefore,
            position,
            config,
            time - dt,
            time,
          );
          if (separation < gap) {
            gap = separation;
            nearestHazard = config.id;
          }
        }
      }
      const nearby = staticAt(child, step - 1);
      if (nearby)
        for (const trajectory of nearby) {
          let before = trajectory.positions[step - 1],
            after = trajectory.positions[step];
          if (trajectory.homingIndex !== undefined) {
            const i = trajectory.homingIndex,
              config = homing[i];
            if (child.homing[i]) continue; // Already advanced above.
            if (
              (child.x - before.x) ** 2 + (child.y - before.y) ** 2 <=
                config.model.rangeSquared &&
              (step - 1) * dt * 1000 >= (config.model.stunMs ?? 0)
            ) {
              after = { ...before };
              stepHoming(
                after,
                config.model,
                child,
                dt,
                config.scales[step - 1],
                (step - 1) * dt * 1000,
                next,
              );
              child.homing[i] = after;
              child.homingIndices = [...child.homingIndices, i];
            }
          }
          if (!sheltered) {
            const separation = trajectoryClearance(
              child,
              next,
              before,
              after,
              trajectory,
              time - dt,
              time,
            );
            if (separation < gap) {
              gap = separation;
              nearestHazard = trajectory.id;
            }
          }
        }
      if (gap < child.physicalClearance) {
        child.closestHazard = nearestHazard;
        child.closestAt = time;
      }
      child.physicalClearance = Math.min(child.physicalClearance, gap);
      child.clearance = Math.min(child.clearance, gap - margin);
      if (gap <= 0) child.firstCollision = Math.min(child.firstCollision, time);
      child.dangerCost +=
        Math.max(0, 40 - (gap - margin)) ** 2 * dt * Math.exp(-time);
      child.progressIntegral += (routeBefore - remaining(next, time)) * dt;
      child.x = next.x;
      child.y = next.y;
      child.vx = next.vx;
      child.vy = next.vy;
      child.motionState = next.motionState;
      child.time = time;
      if (goal && circleInZone(next, goal, p.radius)) child.goalTime = time;
      if (objective && distance(next, target) <= objective.radius)
        child.rescueTime ??= time;
    }
    child.score = score(child);
    return child;
  };
  const names = Object.keys(ACTIONS);
  const fullSpeedNames = names.filter((name) => !name.startsWith("focus_"));
  const initial = {
    x: p.x,
    y: p.y,
    vx: p.vx ?? 0,
    vy: p.vy ?? 0,
    motionState: p.motionState,
    time: 0,
    clearance: 1000,
    physicalClearance: 1000,
    firstCollision: totalTime,
    blocked: false,
    dangerCost: 0,
    progressIntegral: 0,
    turns: 0,
    path: [],
    inputs: [],
    lastAction: previousAction,
    homing: homing.length ? new Array(homing.length) : undefined,
    homingIndices: homing.length ? [] : undefined,
  };
  const resultFor = (action, best) => {
    const progress = routeBefore - remaining(best, best.time);
    const collision = best.clearance < 0 || best.blocked;
    return {
      action,
      clearance: best.clearance,
      progress,
      collision,
      risk: collision
        ? "predicted collision"
        : best.clearance < 20
          ? "tight clearance"
          : "clear",
      progressLabel:
        progress > 2
          ? "toward exit"
          : progress < -2
            ? "away from exit"
            : "no progress",
      firstCollision: best.firstCollision,
      physicalClearance: best.physicalClearance,
      clearanceCapped: best.physicalClearance >= clearanceLimit,
      closestHazard: best.closestHazard,
      closestAt: best.closestAt,
      blocked: best.blocked,
      firstMovement: best.firstMovement,
      firstProgress: best.firstProgress,
      ineffective: best.ineffective,
      exitProgress: distanceBefore - distance(best, target),
      score: best.score,
      path: best.path,
      firstDuration: best.firstDuration,
      plan: {
        areaId: area.id,
        packet: state.packet,
        tickRate,
        inputIntervalTicks,
        inputs: best.inputs,
      },
    };
  };
  // All choices share the same committed inputs. Simulate them only once.
  const committed = extend(initial, previousAction, 0, reactionSteps);
  unavoidableCollision = committed.physicalClearance <= 0;
  committed.path = [];
  committed.inputs = [];
  committed.turns = 0;
  // A nearby rescue is a small contact target, not an exit spanning the map.
  // Check a direct approach with precisely dated axis releases and braking.
  // This avoids overshooting a point while repeatedly deferring a coarse
  // 150 ms follow-up turn. Hold contact until confirmation, and check hazards
  // throughout that hold; unsafe direct approaches still use the normal beam.
  if (objective?.kind === "rescue") {
    const targetKey = `${objective.areaId}:${objective.id}:${objective.x}:${objective.y}:${objective.radius}`;
    const rescueResult = (action, node, continued = false) => {
      const result = resultFor(action, node);
      result.plan.rescueTarget = targetKey;
      return [
        {
          ...result,
          fastPath: true,
          rescueDirect: true,
          continuedPlan: continued,
        },
      ];
    };
    // Keep already scheduled axis releases when the observed position still
    // permits safe contact. Recomputing them on every packet turns a one-tick
    // delay error into alternating corrections before those keys arrive.
    const elapsed = state.packet - (continuation?.packet ?? NaN);
    if (
      continuation?.rescueTarget === targetKey &&
      (continuation.inputIntervalTicks ?? 1) === inputIntervalTicks &&
      continuation.areaId === area.id &&
      continuation.tickRate === tickRate &&
      elapsed >= 0 &&
      elapsed < steps
    ) {
      const inputs = continuation.inputs.map((input) => ({
        ...input,
        tick: input.tick - elapsed,
      }));
      const firstAction = inputs.findLast(
        (input) => input.tick <= reactionSteps,
      )?.action;
      if (ACTIONS[firstAction]) {
        let retained = { ...committed, firstAction },
          from = reactionSteps,
          action = firstAction;
        for (const next of [
          ...inputs.filter(
            (input) => input.tick > reactionSteps && input.tick < steps,
          ),
          { tick: steps },
        ]) {
          retained = extend(retained, action, from, next.tick);
          if (retained.firstDuration === undefined) {
            retained.firstDuration = (next.tick - from) * dt;
            retained.firstMovement = distance(committed, retained);
            retained.firstProgress =
              remaining(committed, committed.time) -
              remaining(retained, retained.time);
          }
          from = next.tick;
          action = next.action;
        }
        if (
          retained.rescueTime !== undefined &&
          !retained.blocked &&
          retained.clearance >= 12
        ) {
          retained.ineffective =
            firstAction !== "stay" && retained.firstMovement < 1;
          retained.score = score(retained);
          return rescueResult(firstAction, retained, true);
        }
      }
    }
    let approach = { ...committed };
    const xSign = Math.sign(target.x - committed.x),
      ySign = Math.sign(target.y - committed.y);
    // A body-sized deadband absorbs coasting and a sampled turn arriving one
    // tick either side of the axis. Chasing the exact centre makes left/right
    // corrections alternate before the earlier correction has even arrived.
    const axisTolerance = objective.radius * 0.6;
    let firstAction, lastAction, firstEnd;
    let contacted = false;
    for (let step = reactionSteps; step < steps; step++) {
      contacted ||= distance(approach, target) <= objective.radius;
      const dx =
        !contacted && (target.x - approach.x) * xSign > axisTolerance
          ? xSign
          : 0;
      const dy =
        !contacted && (target.y - approach.y) * ySign > axisTolerance
          ? ySign
          : 0;
      const action = Object.keys(ACTIONS).find(
        (name) =>
          !name.startsWith("focus_") &&
          ACTIONS[name].dx === dx &&
          ACTIONS[name].dy === dy,
      );
      firstAction ??= action;
      approach.firstAction = firstAction;
      if (action !== firstAction && firstEnd === undefined) {
        firstEnd = step;
        approach.firstMovement = distance(committed, approach);
        approach.firstDuration = (step - reactionSteps) * dt;
        approach.firstProgress =
          remaining(committed, committed.time) -
          remaining(approach, approach.time);
      }
      approach = extend(approach, action, step, step + 1);
      if (lastAction === action) {
        approach.inputs.pop();
        approach.path.pop();
      }
      lastAction = action;
      if (approach.blocked || approach.clearance < 12) break;
    }
    if (
      approach.rescueTime !== undefined &&
      !approach.blocked &&
      approach.clearance >= 12
    ) {
      if (firstEnd === undefined) {
        approach.firstMovement = distance(committed, approach);
        approach.firstDuration = (steps - reactionSteps) * dt;
        approach.firstProgress =
          remaining(committed, committed.time) -
          remaining(approach, approach.time);
      }
      approach.ineffective =
        firstAction !== "stay" && approach.firstMovement < 1;
      approach.score = score(approach);
      return rescueResult(firstAction, approach);
    }
  }
  // A clear full-speed forward path already achieves maximal forward speed.
  // A coarse waypoint may bend while this exact straight path remains clear.
  // Also accept it when the timed map says it preserves the route's travel
  // budget (allowing less than one grid cell of interpolation error).
  // Avoid thousands of unnecessary branches and never ask Jev to slow it down.
  const direct = extend(
    { ...committed, firstAction: heading },
    heading,
    reactionSteps,
    steps,
  );
  if (
    fastPath &&
    !objective &&
    ((navigation?.direct ?? true) ||
      (navigation?.timed &&
        remaining(committed, committed.time) - remaining(direct, direct.time) >=
          (direct.time - committed.time) * speed - 36)) &&
    !direct.blocked &&
    direct.clearance >= 12 &&
    distanceBefore - distance(direct, target) > 2
  ) {
    return [{ ...resultFor(heading, direct), fastPath: true }];
  }
  const firstEnd = Math.min(reactionSteps + firstSteps, steps);
  const firstNodes = names.map((action) => {
    const first = extend(
      { ...committed, firstAction: action },
      action,
      reactionSteps,
      firstEnd,
    );
    first.firstMovement = distance(committed, first);
    first.firstDuration = (firstEnd - reactionSteps) * dt;
    first.firstProgress =
      remaining(committed, committed.time) - remaining(first, first.time);
    first.ineffective = action !== "stay" && first.firstMovement < 1;
    first.score = score(first);
    return first;
  });
  // Keep complete fallback trajectories for every input before any optional
  // branching. A deadline must never promote a safe-looking partial escape.
  const candidates = firstNodes.map((first, index) =>
    resultFor(names[index], extend(first, names[index], firstEnd, steps)),
  );
  // Recheck the previously selected sequence against the NEW observation.
  // Its turn deadlines stay anchored to server packets: replanning must not
  // continually push an escape's second turn another 100–150 ms into the future.
  const elapsed = state.packet - (continuation?.packet ?? NaN);
  if (
    continuation &&
    (continuation.inputIntervalTicks ?? 1) === inputIntervalTicks &&
    continuation.areaId === area.id &&
    continuation.tickRate === tickRate &&
    elapsed >= 0 &&
    elapsed < steps &&
    continuation.inputs?.length
  ) {
    const inputs = continuation.inputs.map((input) => ({
      ...input,
      tick: input.tick - elapsed,
    }));
    const firstAction = inputs.findLast(
      (input) => input.tick <= reactionSteps,
    )?.action;
    if (ACTIONS[firstAction]) {
      let seed = { ...committed, firstAction };
      let action = firstAction,
        from = reactionSteps;
      for (const next of [
        ...inputs.filter(
          (input) => input.tick > reactionSteps && input.tick < steps,
        ),
        { tick: steps },
      ]) {
        seed = extend(seed, action, from, next.tick);
        if (seed.firstDuration === undefined) {
          seed.firstDuration = (next.tick - from) * dt;
          seed.firstMovement = distance(committed, seed);
          seed.firstProgress =
            remaining(committed, committed.time) - remaining(seed, seed.time);
          seed.ineffective = action !== "stay" && seed.firstMovement < 1;
        }
        from = next.tick;
        action = next.action;
      }
      seed.score = score(seed);
      const index = candidates.findIndex(
        (candidate) => candidate.action === firstAction,
      );
      if (seed.score > candidates[index].score)
        candidates[index] = {
          ...resultFor(firstAction, seed),
          continuedPlan: true,
        };
    }
  }
  // Check the old turn sequence BEFORE exploring new alternatives. Its fixed
  // packet deadlines remain available even when dense pursuit exhausts time.
  const search = (first, width) => {
    let beam = [first];
    for (let from = firstEnd; from < steps; from += segmentSteps) {
      const expanded = [];
      for (const node of beam) {
        if (expired()) return;
        const actions =
          trajectories.length || walls.length
            ? node.lastAction.startsWith("focus_")
              ? [...fullSpeedNames, node.lastAction]
              : fullSpeedNames
            : [first.firstAction];
        for (const action of actions)
          expanded.push(
            extend(node, action, from, Math.min(from + segmentSteps, steps)),
          );
      }
      expanded.sort((a, b) => b.score - a.score);
      const seen = new Set();
      beam = [];
      for (const node of expanded) {
        const key = `${Math.round(node.x / 12)}:${Math.round(node.y / 12)}:${Math.sign(node.vx)}:${Math.sign(node.vy)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        beam.push(node);
        if (beam.length >= width) break;
      }
    }
    return beam[0];
  };
  const bounded = deadline !== Infinity;
  // Sparse, player-independent motion already fits a normal beam cheaply.
  // Avoid paying for a preliminary pass there; reserve it for pursuit or a
  // crowded forecast, where completing one wide root can consume the budget.
  const progressive =
    bounded &&
    beamWidth > 1 &&
    (homing.length > 0 || trajectories.length >= 40);
  const order = names.map((_, index) => index);
  if (bounded) order.sort((a, b) => firstNodes[b].score - firstNodes[a].score);
  let searchedRoots = 0;
  // A full-speed follow-up can miss a narrow escape that needs a DIFFERENT
  // focused direction. If the ordinary search and retained plan are all unsafe,
  // try those finer turns before accepting a graze. Reuse first segments and
  // shared forecasts, keep one continuation per input, and stop at a safe route.
  // Once a committed/first-segment gap is already unsafe, no later turn can
  // repair it; avoid spending another search on those branches.
  const recoverFocus = () => {
    if (
      focusRecovery &&
      committed.clearance >= 0 &&
      candidates.every((candidate) => candidate.collision)
    ) {
      const roots = candidates
        .map((candidate, index) => ({ candidate, index }))
        .sort((a, b) => b.candidate.score - a.candidate.score);
      for (const { index } of roots) {
        if (expired()) break;
        let node = firstNodes[index];
        if (node.clearance < 0 || node.blocked) continue;
        for (let from = firstEnd; from < steps; from += segmentSteps) {
          if (expired()) {
            node = undefined;
            break;
          }
          let nextBest;
          for (const action of names) {
            const next = extend(
              node,
              action,
              from,
              Math.min(from + segmentSteps, steps),
            );
            if (next.clearance < 0 || next.blocked) continue;
            if (!nextBest || next.score > nextBest.score) nextBest = next;
          }
          node = nextBest;
          if (!node) break;
        }
        if (node) {
          candidates[index] = {
            ...resultFor(names[index], node),
            recoveredFocusPlan: true,
          };
          break;
        }
      }
    }
  };
  // First find cheap multi-turn escapes across inputs. Spend remaining time on
  // wider alternatives instead of fully searching each input in fixed order.
  for (const width of progressive ? [1, beamWidth] : [beamWidth]) {
    for (const index of order) {
      if (expired()) break;
      const best = search(firstNodes[index], width);
      if (!best) break;
      searchedRoots++;
      if (
        best.score > candidates[index].score ||
        (!bounded &&
          !candidates[index].continuedPlan &&
          best.score === candidates[index].score)
      )
        candidates[index] = resultFor(names[index], best);
    }
    // Try precision recovery before widening an entirely unsafe coarse pass.
    if (progressive && width === 1) recoverFocus();
  }
  if (!progressive) recoverFocus();
  if (bounded) {
    const searchLimited = expired();
    for (const candidate of candidates) {
      candidate.searchLimited = searchLimited;
      candidate.searchedRoots = searchedRoots;
    }
  }
  return candidates;
}

// Reserve this calculation's time before predicting key arrival. A slow route
// map has already finished when this starts, so its actual cost is included.
// Recheck once when actual timing differs by over a tick. This catches both
// overruns (e.g. GC) and shortcuts that would otherwise send precise turns
// earlier than forecast, especially when approaching a rescue target.
export function planResponsiveActions(
  state,
  {
    predictionAt,
    inputMs = 5,
    maxPlanMs = 18,
    now = () => performance.now(),
    ...options
  },
) {
  const deliveryMs = Math.max(5, inputMs);
  let commandAt = now() + maxPlanMs + deliveryMs;
  let prediction = predictionAt(commandAt);
  let candidates = planActions(state, {
    ...options,
    ...prediction,
    maxPlanMs,
    now,
  });
  const timingErrorMs = now() + deliveryMs - commandAt;
  const tickMs = 1000 / (state.tickRate ?? 60);
  const lagRecheck = timingErrorMs > tickMs;
  const timingRecheck = Math.abs(timingErrorMs) > tickMs;
  if (timingRecheck) {
    const recheckMs = 8;
    commandAt = now() + recheckMs + deliveryMs;
    prediction = predictionAt(commandAt);
    candidates = planActions(state, {
      ...options,
      ...prediction,
      continuation: candidates.find((c) => c.action === bestAction(candidates))
        .plan,
      maxPlanMs: recheckMs,
      now,
    });
  }
  return { candidates, prediction, lagRecheck, timingRecheck, commandAt };
}

export function bestAction(candidates) {
  return candidates.reduce((best, candidate) =>
    candidate.score > best.score ? candidate : best,
  ).action;
}

export function guardAction(action, candidates) {
  const candidate = candidates.find((c) => c.action === action);
  const best = candidates.find((c) => c.action === bestAction(candidates));
  // A stale model preference must not choose a tight gap over a clear escape.
  return candidate &&
    !candidate.collision &&
    !(candidate.clearance < 20 && best.clearance > candidate.clearance + 10) &&
    !(
      best.clearance >= 0 &&
      best.progress > candidate.progress + 10 &&
      best.score > candidate.score + 10
    )
    ? action
    : best.action;
}
