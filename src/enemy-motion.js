const angleDifference = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

function regression(points) {
  const meanX = points.reduce((s, p) => s + p.x, 0) / points.length;
  const meanY = points.reduce((s, p) => s + p.y, 0) / points.length;
  let variance = 0,
    covariance = 0;
  for (const p of points) {
    variance += (p.x - meanX) ** 2;
    covariance += (p.x - meanX) * (p.y - meanY);
  }
  const slope = variance > 1e-12 ? covariance / variance : 0;
  const intercept = meanY - slope * meanX;
  const error = Math.sqrt(
    points.reduce((s, p) => s + (p.y - intercept - slope * p.x) ** 2, 0) /
      points.length,
  );
  return { slope, intercept, error };
}

function sampleAt(history, at) {
  if (at < history[0].time - 1e-8 || at > history.at(-1).time + 1e-8)
    return undefined;
  let low = 0,
    high = history.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (history[mid].time <= at) low = mid;
    else high = mid;
  }
  const a = history[low],
    b = history[high],
    fraction = (at - a.time) / (b.time - a.time || 1);
  return {
    vx: a.vx + (b.vx - a.vx) * fraction,
    vy: a.vy + (b.vy - a.vy) * fraction,
  };
}

// Fit against older samples, then require the most recent samples to agree.
// This recognizes repeated waves/zigzags without hardcoding a map's period.
function periodicMotion(history, tickRate, peak) {
  const end = history.at(-1).time,
    span = end - history[0].time;
  if (span < 0.5 || history.length < 24) return undefined;
  const validation = history.slice(-6),
    training = history.slice(-24, -6);
  const variation =
    training.reduce(
      (sum, p) =>
        sum + Math.hypot(p.vx - training[0].vx, p.vy - training[0].vy),
      0,
    ) / training.length;
  if (variation < peak * 0.15) return undefined;
  const errorFor = (period, samples) => {
    let error = 0;
    for (const p of samples) {
      const old = sampleAt(history, p.time - period);
      if (!old) return Infinity;
      error += (p.vx - old.vx) ** 2 + (p.vy - old.vy) ** 2;
    }
    return Math.sqrt(error / samples.length);
  };
  let best,
    bestError = Infinity;
  const maxTicks = Math.min(180, Math.floor((span * tickRate) / 1.6));
  for (let ticks = 10; ticks <= maxTicks; ticks++) {
    const error = errorFor(ticks / tickRate, training);
    if (error < bestError - Math.max(0.05, peak * 0.001)) {
      best = ticks;
      bestError = error;
    }
  }
  if (best === undefined) return undefined;
  const coarse = best;
  for (let ticks = coarse - 0.75; ticks <= coarse + 0.75; ticks += 0.25) {
    const error = errorFor(ticks / tickRate, training);
    if (error < bestError) {
      best = ticks;
      bestError = error;
    }
  }
  const period = best / tickRate,
    validationError = errorFor(period, validation);
  if (
    bestError > Math.max(3, peak * 0.04) ||
    validationError > Math.max(4, peak * 0.06)
  )
    return undefined;
  const start = end - period,
    first = sampleAt(history, start);
  return {
    kind: "periodic",
    period,
    samples: [
      { time: 0, ...first },
      ...history
        .filter((p) => p.time > start)
        .map((p) => ({ time: p.time - start, vx: p.vx, vy: p.vy })),
    ],
    errorSpeed: Math.max(3, 2 * bestError, 2 * validationError),
  };
}

export class EnemyMotionTracker {
  histories = new Map();
  models = new Map();
  reset() {
    this.histories.clear();
    this.models.clear();
  }
  prune(ids) {
    for (const id of this.histories.keys())
      if (!ids.has(id)) {
        this.histories.delete(id);
        this.models.delete(id);
      }
  }

  update(hazard, packet, tickRate = 60) {
    if (
      !hazard.uncertainMotion ||
      !Number.isFinite(hazard.vx) ||
      !Number.isFinite(hazard.vy)
    )
      return undefined;
    let history = this.histories.get(hazard.id) ?? [];
    const time = packet / tickRate,
      previous = history.at(-1);
    if (previous?.time === time) return this.models.get(hazard.id)?.motion;
    if (previous && (time <= previous.time || time - previous.time > 0.15))
      history = [];
    if (hazard.motionEffects?.length) {
      this.histories.delete(hazard.id);
      this.models.delete(hazard.id);
      return undefined;
    }
    const speed = Math.hypot(hazard.vx, hazard.vy);
    history.push({
      time,
      vx: hazard.vx,
      vy: hazard.vy,
      speed,
      angle: Math.atan2(hazard.vy, hazard.vx),
    });
    history = history.filter((p) => time - p.time <= 5);
    this.histories.set(hazard.id, history);
    const peak = Math.max(hazard.uncertainSpeed ?? 0, speed);
    let motion;
    const previousModel = this.models.get(hazard.id);
    let periodCheckedAt = previousModel?.periodCheckedAt ?? -Infinity;
    // Searching periods is bounded and runs at 5 Hz per enemy.
    if (time - periodCheckedAt >= 0.2) {
      motion = periodicMotion(history, tickRate, peak);
      periodCheckedAt = time;
    }
    if (!motion && previousModel?.motion?.kind === "periodic") {
      const prior = previousModel.motion;
      const elapsed = time - previousModel.fittedAt;
      const agrees = history.slice(-6).every((p) => {
        const phase =
          (((p.time - previousModel.fittedAt) % prior.period) + prior.period) %
          prior.period;
        const expected = sampleAt(prior.samples, phase);
        return (
          expected &&
          Math.hypot(expected.vx - p.vx, expected.vy - p.vy) <=
            Math.max(4, peak * 0.08)
        );
      });
      if (agrees) motion = { ...prior, phase: elapsed };
    }
    if (!motion && history.length >= 6 && speed > 1) {
      const recent = history.slice(-7),
        rates = [];
      for (let i = 1; i < recent.length; i++) {
        const a = recent[i - 1],
          b = recent[i];
        if (a.speed < 1 || b.speed < 1) continue;
        rates.push({
          x: (a.time + b.time) / 2 - time,
          y: angleDifference(b.angle, a.angle) / (b.time - a.time),
        });
      }
      if (rates.length >= 4) {
        const turn = regression(rates),
          velocity = regression(
            recent.map((p) => ({ x: p.time - time, y: p.speed })),
          );
        if (
          turn.error < 1.5 &&
          velocity.error < Math.max(3, peak * 0.05) &&
          Math.abs(turn.slope) < 150 &&
          Math.abs(turn.intercept) < 60
        ) {
          motion = {
            kind: "curvature",
            turnRate: turn.intercept,
            turnAcceleration: turn.slope,
            speed,
            acceleration: velocity.slope,
            maxSpeed: Math.max(peak, speed),
            errorSpeed: Math.max(
              3,
              peak * 0.015 + turn.error * peak * 0.15 + velocity.error * 2,
            ),
          };
        }
      }
    }
    this.models.set(hazard.id, {
      periodCheckedAt,
      fittedAt:
        motion?.kind === "periodic" && motion.phase !== undefined
          ? previousModel.fittedAt
          : time,
      motion,
    });
    return motion;
  }
}

export function learnedVelocity(model, time, heading) {
  if (model.kind === "periodic")
    return sampleAt(model.samples, (time + (model.phase ?? 0)) % model.period);
  const angle =
    heading +
    model.turnRate * time +
    (model.turnAcceleration * time * time) / 2;
  const speed = Math.max(
    0,
    Math.min(model.maxSpeed * 1.5, model.speed + model.acceleration * time),
  );
  return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
}
