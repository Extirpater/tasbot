// Runs in the page. Read only: no patching the client, packets, or game rules.
export function observeGame() {
  const candidates = document.querySelectorAll(".no-scroll, #root, #app");
  let component;
  for (const element of candidates) {
    const key = Object.keys(element).find((k) => k.startsWith("__reactFiber$"));
    let fiber = element[key];
    for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
      if (fiber.stateNode?.gameState?.self) {
        component = fiber.stateNode;
        break;
      }
    }
    if (component) break;
  }
  if (!component)
    return { ready: false, reason: "Join a game and select a hero." };
  const game = component.gameState;
  const player = game.self.entity;
  if (
    game.initial ||
    game.disconnected ||
    !player ||
    !Number.isFinite(player.x)
  ) {
    return { ready: false, reason: "Waiting for game state." };
  }
  if (game.spectating) return { ready: false, reason: "Spectating." };
  if (component.state?.selectingHero || component.state?.menuState) {
    return { ready: false, reason: "Close the in-game menu." };
  }
  const focused = document.activeElement;
  if (focused?.matches('input, textarea, [contenteditable="true"]')) {
    return { ready: false, reason: "A text field is focused." };
  }
  if (game.predictedArea) return { ready: false, reason: "Changing areas." };
  const rectangle = (obj) => ({
    x: obj.x,
    y: obj.y,
    width: obj.width,
    height: obj.height,
  });
  const zones = game.area.zones?.list?.() ?? game.area.zones?.zones ?? [];
  const tickRate = game.serverTickRate > 0 ? game.serverTickRate : 60;
  const mouseInput =
    Number.isFinite(game.mouseDown?.x) && Number.isFinite(game.mouseDown?.y)
      ? { x: game.mouseDown.x, y: game.mouseDown.y }
      : null;
  const entities = Object.values(game.entities);
  const playerEffects = player.effects?.list?.() ?? [];
  const hasEffect = (type) =>
    playerEffects.some((e) => e.effectType === type && !e.removed);
  const abilityLevel = (name, type) =>
    [player.abilityOne, player.abilityTwo, player.abilityThree].find(
      (a) => a?.name === name || a?.abilityType === type,
    )?.level ?? 0;
  const sweetTooth =
    player.abilityTwo?.abilityType === 106 ||
    player.abilityTwo?.name === "Sweet Tooth"
      ? player.abilityTwo
      : undefined;
  const otherSpeedBonus = Math.max(
    hasEffect(0) ? 30 + 30 * Math.max(1, abilityLevel("Flow", 29)) : 0,
    player.nightActivated
      ? 37.5 * Math.max(0, abilityLevel("Night", 61) - 1)
      : 0,
    player.streamPathSpeedBoost ?? 0,
  );
  const sourPenalty = player.sourCandyConsumed
    ? 30 * (player.sourCandyStatReduction ?? 0)
    : 0;
  // Match the public client's enemy movement modifiers. A stopped enemy can
  // remain lethal, and dash phase timers continue advancing while it is held.
  const timedMotionEffects = [
    ["frozenTimeLeft", 0],
    ["sugarRushTimeLeft", 0],
    ["sparkTimeLeft", 0],
    ["lightningTimeLeft", 0],
    ["mortarTime", 0],
    ["stompedStunTime", 0],
    ["vengeanceTimeLeft", 0.25],
    ["poisonTimeLeft", 0.334],
    ["lavaTimeLeft", 0.05],
    ["earthquakeTime", 0.25],
  ];
  const flaggedMotionEffects = [
    ["petrified", 0],
    ["isDestroyed", 0],
    ["vengeanceFrozen", 0],
    ["reduced", 0.5],
  ];
  const motionFor = (e) => {
    const motionEffects = [];
    for (const [name, scale] of timedMotionEffects) {
      if (Number.isFinite(e[name]) && e[name] > 0)
        motionEffects.push({ name, scale, remainingMs: e[name] });
    }
    for (const [name, scale] of flaggedMotionEffects) {
      if (e[name] === true)
        motionEffects.push({
          name,
          scale,
          remainingMs:
            name === "vengeanceFrozen" && e.vengeanceTimeLeft > 0
              ? e.vengeanceTimeLeft
              : undefined,
        });
    }
    const scale = Math.min(1, ...motionEffects.map((effect) => effect.scale));
    return {
      // _pred reflects current stops/slows; velocityX/Y retain the nominal
      // direction needed to forecast movement after a timed effect expires.
      vx: Number.isFinite(e._pred?.vx ?? e.velocityX)
        ? (e._pred?.vx ?? e.velocityX) * tickRate
        : undefined,
      vy: Number.isFinite(e._pred?.vy ?? e.velocityY)
        ? (e._pred?.vy ?? e.velocityY) * tickRate
        : undefined,
      baseVx:
        motionEffects.length && Number.isFinite(e.velocityX)
          ? e.velocityX * tickRate
          : undefined,
      baseVy:
        motionEffects.length && Number.isFinite(e.velocityY)
          ? e.velocityY * tickRate
          : undefined,
      motionEffects: motionEffects.length ? motionEffects : undefined,
      bounce: Boolean(e.isEnemy && !e.isEnemyProjectile),
      motion:
        typeof e.resolveClockwise === "function" && e.zonePolicy === "clamp"
          ? "perimeter"
          : "bounce",
      homing:
        typeof e.trackHomingState === "function"
          ? {
              heading:
                e._pred?.angle ??
                Math.atan2(e.velocityY ?? 0, e.velocityX ?? 0) +
                  (e.reverse ? Math.PI : 0),
              speed:
                (e._pred?.baseSpeed ??
                  Math.hypot(e.velocityX ?? 0, e.velocityY ?? 0) /
                    (scale || 1)) * tickRate,
              turnRate: (e.increment ?? 1.5) * (e.reduced ? 0.5 : 1),
              range: e.homeRange ?? 200,
              reverse: Boolean(e.reverse),
              stunMs: e.stompedStunTime ?? 0,
            }
          : undefined,
      dash:
        typeof e.trackDashDirection === "function" &&
        e.dashSpeed > 0 &&
        Number.isFinite(e._pred?.dashDirX) &&
        Number.isFinite(e._pred?.dashDirY)
          ? {
              preparing: e.timePreparing ?? 0,
              dashing: e.timeDashing ?? 0,
              resting: e.timeSinceLastDash ?? 0,
              peak: e.dashSpeed,
              dx: e._pred.dashDirX,
              dy: e._pred.dashDirY,
              scale,
            }
          : undefined,
      // Public-client telemetry, kept separate from Ravel's phase fields.
      icicle:
        e.entityType === 79 && Number.isFinite(e._pred?.moveVx) &&
        Number.isFinite(e._pred?.moveVy) && Number.isFinite(e.wallTimeLeft)
          ? { paused: e.wallHit === true, remainingMs: e.wallTimeLeft,
              vx: e._pred.moveVx * tickRate, vy: e._pred.moveVy * tickRate }
          : undefined,
      liquid:
        e.entityType === 96 && Number.isFinite(e.playerDetectionRadius) &&
        Number.isFinite(e._pred?.baseSpeed) &&
        Number.isFinite(e._pred?.baseDirX) && Number.isFinite(e._pred?.baseDirY)
          ? { active: e.activated === true, range: e.playerDetectionRadius,
              vx: e._pred.baseDirX * e._pred.baseSpeed * tickRate,
              vy: e._pred.baseDirY * e._pred.baseSpeed * tickRate }
          : undefined,
      turning:
        typeof e.trackTurningDirection === "function" &&
        Number.isFinite(e._pred?.turnMag)
          ? { rate: (e._pred.turnSign || 1) * e._pred.turnMag * tickRate }
          : undefined,
      iceSniper:
        e.entityType === 77 && Number.isFinite(e.releaseTime)
          ? { remainingMs: Math.max(0, e.releaseTime), speed: 480, radius: 10 }
          : undefined,
    };
  };
  // These are effect IDs from the current public client configuration, not
  // the separate alphabetically sorted EffectType enum.
  const slowEffects = {
    48: { reduction: 0.3, scanner: 1 },
    52: { reduction: 0.85, scanner: 5 },
    53: { reduction: 0, scanner: 6, kind: "slippery" },
    70: { reduction: 0.2, scanner: 49 },
  };
  const auras = entities
    .filter((e) => e.isEnemy && !e.removed)
    .flatMap((e) =>
      (e.effects?.list?.() ?? [])
        .filter(
          (effect) =>
            slowEffects[effect.effectType] &&
            effect.radius > 0 &&
            !effect.removed &&
            !(
              (!player.abilityOne || !player.abilityOne.disabled) &&
              player.roboScannerId === slowEffects[effect.effectType].scanner
            ),
        )
        .map((effect) => ({
          id: e.id,
          x: e.x,
          y: e.y,
          radius: e.radius ?? 0,
          ...motionFor(e),
          vx: (e._pred?.vx ?? e.velocityX ?? 0) * tickRate,
          vy: (e._pred?.vy ?? e.velocityY ?? 0) * tickRate,
          type: effect.effectType,
          auraRadius: effect.radius,
          reduction: slowEffects[effect.effectType].reduction,
          kind: slowEffects[effect.effectType].kind,
        })),
    );
  const hazards = entities
    .filter(
      (e) =>
        (e.isEnemy || e.isEnemyProjectile) &&
        ((!e.isHarmless && !e.grassHarmless) ||
          e.switchedHarmless === true ||
          e.entityType === 217 ||
          e.entityType === 207 ||
          e.entityType === 242 ||
          e.entityType === 78) &&
        !e.removed &&
        Number.isFinite(e.x) &&
        Number.isFinite(e.y),
    )
    .map((e) => ({
      id: e.id,
      x: e.x,
      y: e.y,
      radius: e.radius ?? 0,
      ...motionFor(e),
      entityType: e.entityType,
      square: Boolean(e.square),
      // Switch bodies must remain visible before they become lethal. Missing
      // countdown data grants no safe crossing; other harmless filtering stays.
      harmlessUntilMs:
        e.switchedHarmless && Number.isFinite(e.switchTime)
          ? Math.max(0, e.switchTime)
          : undefined,
      switchState:
        e.switchedHarmless !== undefined ||
        e.entityType === 217 ||
        e.entityType === 207 ||
        e.entityType === 242
          ? {
              harmless: Boolean(e.switchedHarmless),
              remainingMs: Number.isFinite(e.switchTime)
                ? e.switchTime
                : undefined,
            }
          : undefined,
    }));
  const area = game.area;
  return {
    ready: true,
    time: performance.now(),
    packet: game.packetNumber,
    tickRate,
    area: {
      ...rectangle(area),
      id: `${area.regionName}:${area.index}:${area.x}:${area.y}`,
      number: area.number,
      zones: zones.map((z) => ({
        ...rectangle(z),
        type: z.type,
        minimumSpeed: z.minimumSpeed,
        maximumSpeed: z.maximumSpeed,
        friction: z.friction,
      })),
      // The client uses textureless 2000-unit rectangles as enemy-only area
      // boundaries. Treating those as solid traps the player in safe zones.
      walls: entities
        .filter(
          (e) =>
            e.wall &&
            e.width > 0 &&
            e.height > 0 &&
            !(e.texture == null && (e.width === 2000 || e.height === 2000)),
        )
        .map(rectangle),
    },
    player: {
      id: player.id,
      heroType: player.heroType,
      x: player.x,
      y: player.y,
      radius: player.radius,
      speed: player.totalSpeed ?? player.speed,
      // Keyboard directions override this. With no directions held, the game
      // resumes analog steering instead of stopping, including gamepad input.
      mouseInput,
      baseSpeed: player.speed,
      slideAngle: Number.isFinite(player.shieldAngle) ? player.shieldAngle : undefined,
      auraImmune: Boolean(player.isInvulnerable),
      untargetable: Boolean(player.nightActivated || player.isDeparted || player.voidTime > 0),
      speedMultiplier:
        (player.inStreamPath
          ? 1
          : (player.isBurning ? 0.05 : 1) *
            (player.underDabotEffect ? 0.5 : 1) *
            (player.isBandaging ? 0.5 : 1) *
            (player.isUmbreled ? 0.2 : 1)) * (player.isPoisoned ? 3 : 1),
      speedBonus:
        Math.max(
          otherSpeedBonus,
          player.sweetToothConsumed ? (player.sweetToothStatBoost ?? 0) : 0,
        ) - sourPenalty,
      speedBonusWithoutCandy: otherSpeedBonus - sourPenalty,
      ignoreAuras: Boolean(player.inStreamPath),
      immobilized:
        hasEffect(1) ||
        Boolean(
          player.isIced ||
          player.isSnowballed ||
          player.isFreezing ||
          player.isStone ||
          player.isClinging ||
          player.isOrbiting ||
          player.electrocuted ||
          player.mortarActivated,
        ),
      effectsMultiplier: Number.isFinite(player.effectsMultiplier)
        ? Math.max(0, player.effectsMultiplier)
        : 1,
      // The local player's _pred velocities stay zero in live play. Derive
      // momentum from acknowledged packet positions in MotionTracker instead.
      upgradePoints: player.upgradePoints,
      downed: Number.isFinite(player.deathTimer) && player.deathTimer !== -1,
      level: player.level,
      energy: player.energy,
      maxEnergy: player.maxEnergy,
      candy: sweetTooth
        ? {
            level: sweetTooth.level,
            locked: Boolean(sweetTooth.locked),
            disabled: Boolean(sweetTooth.disabled),
            cooldownMs: sweetTooth.cooldown,
            energyCost: sweetTooth.energyCost ?? 5,
            active: Boolean(player.sweetToothConsumed),
            remainingMs: player.sweetToothConsumedTime,
            boost: player.sweetToothStatBoost ?? 0,
          }
        : undefined,
    },
    hazards,
    auras,
    // Homing can retarget another player. Preserve nearby player positions in
    // death traces so a target change can be distinguished from a bad turn rate.
    otherPlayers: entities
      .filter(
        (e) =>
          e.isPlayer &&
          !e.removed &&
          e.id !== player.id &&
          Number.isFinite(e.x) &&
          Number.isFinite(e.y),
      )
      .map((e) => ({
        id: e.id,
        x: e.x,
        y: e.y,
        radius: e.radius,
        downed: Number.isFinite(e.deathTimer) && e.deathTimer !== -1,
        untargetable: Boolean(e.nightActivated || e.isDeparted || e.voidTime > 0),
        rescueable: e.rescueable !== false,
        // game.entities is the current area roster, not the world-map list.
        areaId: `${area.regionName}:${area.index}:${area.x}:${area.y}`,
      })),
    input: {
      heldKeys: [...(game.keys?.get?.() ?? [])],
      // Native submission is not server acknowledgement or confirmed movement.
      sentSequence: Number.isFinite(game.sequence) ? game.sequence : undefined,
      sentKeys: game.previousKeys?.get
        ? [...game.previousKeys.get()]
        : undefined,
      manualDirectionHeld: [...(game.keys?.get?.() ?? [])].some((key) =>
        [5, 7, 11, 20].includes(key),
      ),
      controllerKeys: [...(game.keys?.get?.() ?? [])].flatMap((key) => {
        const name = {
          6: "ArrowDown",
          8: "Shift",
          9: "ArrowLeft",
          10: "ArrowRight",
          19: "ArrowUp",
          3: "x",
        }[key];
        return name ? [name] : [];
      }),
      usingGamepad: Boolean(game.usingGamepad),
    },
  };
}

// Estimate velocities only when the server supplies a new packet. Never infer
// velocity across an area transition or from repeated reads of one packet.
export class MotionTracker {
  previous;
  velocities = new Map();
  spirals = new Map();
  zoning = new Map();

  zoningFor(h, packet, tickRate) {
    if (h.entityType !== 249) return;
    let track = this.zoning.get(h.id);
    if (track?.samples.at(-1).packet === packet) return track.model;
    const sample = { packet, x: h.x, y: h.y, vx: h.vx, vy: h.vy };
    const reset = () => {
      this.zoning.set(h.id, { samples: [sample], tickRate });
      return undefined;
    };
    const before = track?.samples.at(-1), ticks = packet - before?.packet;
    if (!before || track.tickRate !== tickRate || ticks < 1 || ticks > 6 ||
      !Number.isFinite(h.vx) || !Number.isFinite(h.vy) || h.motionEffects?.length ||
      Math.hypot(h.vx, h.vy) < 1 || Math.min(Math.abs(h.vx), Math.abs(h.vy)) > 0.01)
      return reset();
    const ax = (h.vx - before.vx) * tickRate / ticks;
    const ay = (h.vy - before.vy) * tickRate / ticks;
    // Validate the velocity slope against actual displacement. This rejects
    // wall bounces, 90-degree turns, stops and non-constant phase changes.
    const endX = before.x + before.vx * ticks / tickRate + ax * ticks * (ticks + 1) / (2 * tickRate ** 2);
    const endY = before.y + before.vy * ticks / tickRate + ay * ticks * (ticks + 1) / (2 * tickRate ** 2);
    const acceleration = Math.hypot(ax, ay);
    if (!(acceleration > 1 && acceleration < 10000) || ax * h.vx + ay * h.vy >= 0 ||
      Math.abs(ax * h.vy - ay * h.vx) > 0.01 || Math.hypot(endX - h.x, endY - h.y) > 0.12)
      return reset();
    track.samples.push(sample);
    if (track.samples.length > 3) track.samples.shift();
    const previousSlope = track.slope;
    track.slope = { ax, ay };
    track.model = undefined;
    if (previousSlope && Math.hypot(ax - previousSlope.ax, ay - previousSlope.ay) < Math.max(1, acceleration * 0.01))
      track.model = { deceleration: acceleration };
    return track.model;
  }

  spiralFor(hazard, packet, tickRate) {
    if (hazard.entityType !== 206 && hazard.entityType !== 207) return;
    if (
      !Number.isFinite(hazard.vx) ||
      !Number.isFinite(hazard.vy) ||
      !Number.isFinite(packet) ||
      hazard.motionEffects?.length ||
      Math.hypot(hazard.vx, hazard.vy) < 1
    ) {
      this.spirals.delete(hazard.id);
      return;
    }
    let track = this.spirals.get(hazard.id);
    const previous = track?.samples.at(-1);
    if (previous?.packet === packet) return track.model;
    if (
      !previous ||
      packet < previous.packet ||
      packet - previous.packet > 3 ||
      track.tickRate !== tickRate ||
      track.type !== hazard.entityType
    )
      track = { samples: [], tickRate, type: hazard.entityType };
    track.samples.push({
      packet,
      angle: Math.atan2(hazard.vy, hazard.vx),
      speed: Math.hypot(hazard.vx, hazard.vy),
    });
    if (track.samples.length > 9) track.samples.shift();
    track.model = undefined;
    this.spirals.set(hazard.id, track);
    if (track.samples.length < 7) return;
    const speed = track.samples.at(-1).speed;
    if (
      track.samples.some(
        (s) => Math.abs(s.speed - speed) > Math.max(1, speed * 0.01),
      )
    )
      return;
    const rates = [];
    for (let i = 1; i < track.samples.length; i++) {
      const a = track.samples[i - 1],
        b = track.samples[i];
      const turn = Math.atan2(
        Math.sin(b.angle - a.angle),
        Math.cos(b.angle - a.angle),
      );
      // Large ambiguous turns, bounces and phase changes must not keep a stale fit.
      if (Math.abs(turn) > 2.5) return;
      rates.push({
        x: ((a.packet + b.packet) / 2 - packet) / tickRate,
        y: (turn * tickRate) / (b.packet - a.packet),
      });
    }
    const fit = (points) => {
      let sx = 0,
        sy = 0,
        sxx = 0,
        sxy = 0;
      for (const { x, y } of points) {
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
      }
      const n = points.length;
      const acceleration = (sxy - (sx * sy) / n) / (sxx - (sx * sx) / n);
      const rate = (sy - acceleration * sx) / n;
      return { rate, acceleration };
    };
    const residual = (model, points) =>
      Math.max(
        ...points.map(({ x, y }) =>
          Math.abs(y - model.rate - model.acceleration * x),
        ),
      );
    // Fit older intervals, then validate two newer intervals before using it.
    // Nine observations per Spiral; no period search or work for other families.
    const training = fit(rates.slice(0, -2));
    if (
      !Number.isFinite(training.rate) ||
      !Number.isFinite(training.acceleration) ||
      residual(training, rates) > 0.05
    )
      return;
    const model = fit(rates);
    if (Math.abs(model.rate) > 60 || Math.abs(model.acceleration) > 60) return;
    track.model = {
      turnRate: model.rate,
      turnAcceleration: model.acceleration,
      speed,
      padding: 3,
    };
    return track.model;
  }

  update(state) {
    const previous = this.previous;
    if (
      !previous ||
      previous.area.id !== state.area.id ||
      state.packet < previous.packet
    ) {
      this.velocities.clear();
      this.spirals.clear();
      this.zoning.clear();
    }
    if (
      previous?.area.id === state.area.id &&
      previous.packet !== state.packet
    ) {
      const packetDelta = state.packet - previous.packet;
      // Browser sampling is not synchronized with the server: elapsed wall
      // time alone turns a 1/2-packet alternation into oscillating velocities.
      const dt =
        state.tickRate > 0 && packetDelta > 0
          ? packetDelta / state.tickRate
          : (state.time - previous.time) / 1000;
      if (dt > 0.005 && dt < 0.5) {
        const old = new Map(previous.hazards.map((h) => [h.id, h]));
        for (const hazard of state.hazards) {
          const before = old.get(hazard.id);
          if (before)
            this.velocities.set(hazard.id, {
              vx: (hazard.x - before.x) / dt,
              vy: (hazard.y - before.y) / dt,
            });
        }
        this.velocities.set("player", {
          vx: (state.player.x - previous.player.x) / dt,
          vy: (state.player.y - previous.player.y) / dt,
        });
      } else this.velocities.clear();
    }
    if (
      !previous ||
      previous.packet !== state.packet ||
      previous.area.id !== state.area.id
    ) {
      this.previous = state;
      const ids = new Set(["player", ...state.hazards.map((h) => h.id)]);
      for (const id of this.velocities.keys())
        if (!ids.has(id)) this.velocities.delete(id);
      for (const id of this.spirals.keys())
        if (!ids.has(id)) this.spirals.delete(id);
      for (const id of this.zoning.keys())
        if (!ids.has(id)) this.zoning.delete(id);
    }
    return {
      ...state,
      player: {
        ...state.player,
        vx: state.player.vx ?? this.velocities.get("player")?.vx ?? 0,
        vy: state.player.vy ?? this.velocities.get("player")?.vy ?? 0,
      },
      hazards: state.hazards.map((h) => ({
        ...h,
        vx: Number.isFinite(h.vx) ? h.vx : (this.velocities.get(h.id)?.vx ?? 0),
        vy: Number.isFinite(h.vy) ? h.vy : (this.velocities.get(h.id)?.vy ?? 0),
        ...(h.entityType === 206 || h.entityType === 207
          ? {
              spiral: this.spiralFor(
                h,
                state.packet,
                state.tickRate > 0 ? state.tickRate : 60,
              ),
            }
          : {}),
        ...(h.entityType === 249 ? { zoning: this.zoningFor(h, state.packet, state.tickRate ?? 60) } : {}),
      })),
    };
  }
}
