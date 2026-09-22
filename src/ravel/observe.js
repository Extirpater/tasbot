// Shared observation conversion for the pinned VM and the browser game.
// Serialized into the engine realm; all data comes from present native state.
export function createRavelObserver({
  game, idFor, getTick, getTime = () => getTick() * 1000 / 60,
  areaId = p => `ravel-mm:${p.area + 1}`,
  downed = p => p.deathCounter > 0 || Boolean(p.isDead),
}) {
  const knownTypes = { spiral: 206, switch: 217 };
  const motion = (entity, family, ox, oy) => {
    const scale = entity.frozenTimeLeft > 0 ? 0 :
      (entity.speedMultiplier ?? 1) * (entity.speedRecovery ?? 1);
    const hazard = {
      id: idFor(entity), family, entityType: knownTypes[family] ?? 10000 + (entity.type ?? 9999),
      x: ox + entity.pos.x * 32, y: oy + entity.pos.y * 32,
      radius: entity.radius * 32,
      vx: entity.vel.x * 30 * scale, vy: entity.vel.y * 30 * scale,
      bounce: !entity.weak, motion: entity.wall ? "perimeter" : "bounce",
    };
    if (entity.frozenTimeLeft > 0) {
      hazard.baseVx = entity.vel.x * 30;
      hazard.baseVy = entity.vel.y * 30;
      hazard.motionEffects = [{scale:0, remainingMs:entity.frozenTimeLeft}];
    }
    if (family === "icicle" && entity.wallHit) {
      // Icicle.behavior pauses at a wall until its clock exceeds 1000 ms.
      // A zero observed velocity is temporary: preserve the inward velocity
      // and count the stopped updates before movement resumes. Repeating the
      // engine's clock additions also preserves its strict floating-point >.
      let clock=entity.clock, stoppedTicks=0;
      do { clock+=1000/60; stoppedTicks++; } while(clock<=1000 && stoppedTicks<62);
      hazard.baseVx=entity.vel.x*30;
      hazard.baseVy=entity.vel.y*30;
      (hazard.motionEffects??=[]).push({
        name:"icicle wall pause",scale:0,remainingMs:stoppedTicks*1000/60,
      });
    }
    if (entity.homing) hazard.homing = {
      heading: Math.atan2(entity.vel.y, entity.vel.x),
      speed: Math.hypot(entity.vel.x, entity.vel.y) * 30,
      turnRate: entity.increment * 1000 / 30, range: entity.home_range * 32,
    };
    if (entity.dasher) hazard.dash = {
      preparing: entity.time_preparing, dashing: entity.time_dashing,
      resting: entity.time_since_last_dash, peak: entity.dash_speed * 30,
      dx: Math.cos(entity.angle), dy: Math.sin(entity.angle), scale,
    };
    if (entity.switching && entity.disabled)
      hazard.harmlessUntilMs = Math.max(0, entity.switch_total_time - entity.switch_clock);
    if (family === "slippery") hazard.auraRadius = entity.auraSize * 32;
    if (family === "liquid") hazard.liquid = {
      vx:entity.vel.x*30,vy:entity.vel.y*30,
      multiplier:entity.speedMultiplier,range:entity.player_detection_radius*32,
    };
    if (family === "wavy") hazard.wavy = {
      increment:entity.angle_increment,remainingMs:entity.switch_time,
      intervalMs:entity.switch_interval,direction:entity.dir,
    };
    if (family === "turning") hazard.turningCurve = {rate:entity.dir*1000/30};
    if (family === "spiral") hazard.spiralPhase = {
      increment:entity.angleIncrement,increasing:entity.angleAdd,direction:entity.dir,
    };
    if (entity instanceof Sniper && entity.bulletType === 1) hazard.sniper = {
      clock:entity.clock,interval:entity.releaseTime,range:entity.detectionDistance*32,
      bulletSpeed:entity.bulletSpeed*30,bulletRadius:entity.bulletRadius*32,
    };
    return hazard;
  };
  return function observe() {
    const p = game.players[0], world = game.worlds[p.world], area = world.areas[p.area];
    const ox = (world.pos.x + area.pos.x) * 32, oy = (world.pos.y + area.pos.y) * 32;
    const bounds = area.getBoundary();
    const zones = area.zones.map((zone) => ({
      x: ox + zone.pos.x * 32, y: oy + zone.pos.y * 32,
      width: zone.size.x * 32, height: zone.size.y * 32,
      type: ({0:0, 1:4, 2:2, 3:3, 4:6, 5:3})[zone.type] ?? 3,
      friction: world.friction, minimumSpeed: zone.minimum_speed ? zone.minimum_speed * 30 : undefined,
    }));
    const hazards = [], auras = [];
    for (const [name, entities] of Object.entries(area.entities)) for (const e of entities) {
      if (e.toRemove || !(e.isEnemy || e instanceof RadiatingBullet)) continue;
      const family = e.isEnemy ? entityTypes[e.type] : "radiating_bullet";
      const h = motion(e, family, ox, oy);
      // Keep disabled switches so activation is predicted before they turn lethal.
      if (!e.isHarmless() || e.switching) hazards.push(h);
      if (family === "slowing" || family === "freezing") auras.push({
        ...h, type: family === "slowing" ? 48 : 52,
        reduction: family === "slowing" ? e.slow : 0.85, auraRadius: e.auraSize * 32,
      });
    }
    const bonus = p.sweetToothEffect ? p.sweetToothPower * 30 : 0;
    return {
      ready: true, packet: getTick(), time: getTime(), tickRate: 60,
      area: {id:areaId(p), number:p.area + 1,
        x:ox + bounds.x * 32, y:oy + bounds.y * 32,
        width:bounds.w * 32, height:bounds.h * 32, zones,
        walls:area.assets.filter(a=>a.type===1).map(a=>({
          x:ox+a.pos.x*32,y:oy+a.pos.y*32,width:a.size.x*32,height:a.size.y*32,
        })),
      },
      player: {id:"self", x:p.pos.x*32, y:p.pos.y*32, radius:p.radius*32,
        speed:p.speed*30+bonus, baseSpeed:p.speed*30, speedBonus:bonus,
        speedBonusWithoutCandy:0, speedMultiplier:1,
        immobilized:Boolean(p.frozen || p.isDead), downed:downed(p),
        effectsMultiplier:p.effectImmune ?? 1, energy:p.energy, maxEnergy:p.maxEnergy,
        upgradePoints:p.points,
        slip: p.slippery || p.isSlipping || hazards.some(h=>h.family==="slippery") ? {
          active:Boolean(p.slippery), locked:Boolean(p.isSlipping && !p.no_slip),
          angle:p.input_angle ?? 0, dx:p.dirX ?? 0, dy:p.dirY ?? 0,
          carryVx:p.distance_moved_previously[0]*30, carryVy:p.distance_moved_previously[1]*30,
          wallBoost:p.no_slip && p.isSlipping ? 2 : 1,
        } : undefined,
        candy:p.className === "Candy" ? {level:p.ab2L, locked:!p.secondAbilityUnlocked,
          disabled:Boolean(p.disabling), cooldownMs:p.secondAbilityCooldown, energyCost:5,
          active:Boolean(p.sweetToothEffect), remainingMs:p.sweetToothTimer, boost:bonus} : undefined,
      },
      hazards, auras, otherPlayers:[],
    };
  };
}
