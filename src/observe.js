import { EnemyMotionTracker } from "./enemy-motion.js";

// Runs in the page. Read only: no patching the client, packets, or game rules.
export function observeGame(enemyTypes = {}) {
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
    const type = enemyTypes[e.entityType];
    const teleportSpeed = Math.hypot(e.velocityX ?? 0, e.velocityY ?? 0);
    const pingPong = type?.name === "star_enemy";
    const teleport =
      Number.isFinite(e.pauseTime) &&
      e.pauseInterval > 0 &&
      (pingPong || type?.name === "teleporting_enemy")
        ? {
            remainingMs: Math.max(0, e.pauseTime),
            intervalMs: e.pauseInterval,
            distance:
              e.teleportDistance ?? e._pred?.teleportDist ?? teleportSpeed,
            dx:
              (pingPong ? -1 : 1) *
              (e._pred?.teleportDirX ??
                (teleportSpeed ? e.velocityX / teleportSpeed : 0)),
            dy:
              (pingPong ? -1 : 1) *
              (e._pred?.teleportDirY ??
                (teleportSpeed ? e.velocityY / teleportSpeed : 0)),
            pingPong,
          }
        : undefined;
    const pumpkin =
      type?.name === "pumpkin_enemy" || typeof e.pumpkinActivated === "boolean"
        ? {
            active: Boolean(e.pumpkinActivated),
            arming: e.imageName === "pumpkin_on",
            startsInMs: Math.max(0, e.pumpkinActivationTimer ?? 1000),
            remainingMs: Math.max(0, 1500 - (e.movementTime ?? 0)),
            vx: (e.velocityX ?? 0) * tickRate,
            vy: (e.velocityY ?? 0) * tickRate,
          }
        : undefined;
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
      vx:
        pumpkin && !pumpkin.active
          ? 0
          : Number.isFinite(e._pred?.vx ?? e.velocityX)
            ? (e._pred?.vx ?? e.velocityX) * tickRate
            : undefined,
      vy:
        pumpkin && !pumpkin.active
          ? 0
          : Number.isFinite(e._pred?.vy ?? e.velocityY)
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
      typeName: type?.name,
      pumpkin,
      teleport,
      uncertainMotion: (type?.uncertainMotion && !teleport) || undefined,
      uncertainSpeed: type?.uncertainMotion
        ? Math.hypot(e.velocityX ?? 0, e.velocityY ?? 0) * tickRate
        : undefined,
      turning:
        typeof e.trackTurningDirection === "function" &&
        Number.isFinite(e._pred?.turnMag)
          ? { rate: (e._pred.turnSign || 1) * e._pred.turnMag * tickRate }
          : undefined,
      sizing:
        Number.isFinite(e.sizingMultiplier) && e.sizingMultiplier > 0
          ? {
              baseRadius: e.radius / e.sizingMultiplier,
              multiplier: e.sizingMultiplier,
              growing: Boolean(e.growing),
            }
          : undefined,
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
    };
  };
  // These are effect IDs from the current public client configuration, not
  // the separate alphabetically sorted EffectType enum.
  const movementEffects = {
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
            movementEffects[effect.effectType] &&
            effect.radius > 0 &&
            !effect.removed &&
            !(
              (!player.abilityOne || !player.abilityOne.disabled) &&
              player.roboScannerId ===
                movementEffects[effect.effectType].scanner
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
          reduction: movementEffects[effect.effectType].reduction,
          kind: movementEffects[effect.effectType].kind,
        })),
    );
  const hazards = entities
    .filter(
      (e) =>
        (e.isEnemy || e.isEnemyProjectile) &&
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
      harmless: Boolean(e.isHarmless || e.grassHarmless || e.switchedHarmless),
      // Track the body even while harmless. Known remaining times allow a
      // harmless crossing; missing phase data is treated conservatively.
      harmlessUntilMs: Math.max(
        0,
        e.isHarmless && Number.isFinite(e.harmlessTime) ? e.harmlessTime : 0,
        e.switchedHarmless && Number.isFinite(e.switchTime) ? e.switchTime : 0,
        e.grassHarmless && Number.isFinite(e.grassTime) ? e.grassTime : 0,
      ),
      switchState: Number.isFinite(e.switchTime)
        ? { remainingMs: e.switchTime, harmless: Boolean(e.switchedHarmless) }
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
      // The client seeds its slippery direction from this shared movement
      // angle when available, otherwise from acknowledged displacement.
      slideAngle: Number.isFinite(player.shieldAngle)
        ? player.shieldAngle
        : undefined,
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
      })),
    input: {
      heldKeys: [...(game.keys?.get?.() ?? [])],
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
  peakSpeeds = new Map();
  enemyMotion = new EnemyMotionTracker();

  update(state) {
    const previous = this.previous;
    if (!previous || previous.area.id !== state.area.id) {
      this.velocities.clear();
      this.peakSpeeds.clear();
      this.enemyMotion.reset();
    }
    for (const h of state.hazards)
      if (h.uncertainMotion)
        this.peakSpeeds.set(
          h.id,
          Math.max(
            this.peakSpeeds.get(h.id) ?? 0,
            h.uncertainSpeed ?? 0,
            Math.hypot(h.vx ?? 0, h.vy ?? 0),
          ),
        );
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
          if (before) {
            const vx = (hazard.x - before.x) / dt,
              vy = (hazard.y - before.y) / dt;
            this.velocities.set(hazard.id, {
              vx,
              vy,
            });
            if (hazard.uncertainMotion)
              this.peakSpeeds.set(
                hazard.id,
                Math.max(
                  this.peakSpeeds.get(hazard.id) ?? 0,
                  Math.hypot(vx, vy),
                ),
              );
          }
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
      for (const id of this.peakSpeeds.keys())
        if (!ids.has(id)) this.peakSpeeds.delete(id);
      this.enemyMotion.prune(ids);
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
        ...(h.uncertainMotion
          ? {
              uncertainSpeed: this.peakSpeeds.get(h.id),
              learnedMotion: this.enemyMotion.update(
                { ...h, uncertainSpeed: this.peakSpeeds.get(h.id) },
                state.packet,
                state.tickRate ?? 60,
              ),
            }
          : {}),
      })),
    };
  }
}
