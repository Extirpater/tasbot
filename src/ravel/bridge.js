// Installed in an isolated VM beside the pinned, unmodified Ravel scripts.
// This adapter exposes current observations; it never exposes future engine state.
export function installRavelBridge(createObserver) {
  Object.assign(globalThis, {
    settings: {
      tiles: "tiles", pellets: true, cooldown: true, max_abilities: true,
      max_stats: false, cheats: false, dev: false, diff: "Easy",
      death_cooldown: false, no_points: false, convert_to_legacy_speed: false,
      speedrun_mode: false, tournament_mode: false, seeded_area_resets: false,
      fps_limit: "60", effect_blending: true, fading_effects: true, scale: 1,
    },
    images: {}, width: 1280, height: 720, tilesCanvas: undefined,
    isKeyAction: (keys, id) => ({
      up: [87, 38], down: [83, 40], left: [65, 37], right: [68, 39],
      slow: [16], ability1: [90, 74], ability2: [88, 75], ability3: [67, 76],
      upgrade_speed: [49],
    }[id] ?? []).some((key) => keys[key]),
    game: new Game(),
  });
  let tick = 0, ids = new WeakMap(), nextId = 1, fatalState;
  const idFor = (entity) => {
    if (!ids.has(entity)) ids.set(entity, nextId++);
    return ids.get(entity);
  };
  // IDs belong to spawn events, not observation calls. Otherwise a replay that
  // samples less often renumbers transient projectiles and cannot match a trace.
  for (const method of ["addEntity", "addEntitiesBehind"]) {
    const original = Area.prototype[method];
    Area.prototype[method] = function (name, entity, ...rest) {
      idFor(entity);
      return original.call(this, name, entity, ...rest);
    };
  }
  const observe = createObserver({ game, idFor, getTick: () => tick });
  const originalKill = kill;
  kill = function (player) {
    // Capture contact before Easy mode teleports the player back to shelter.
    if (!fatalState) { fatalState = observe(); fatalState.player.downed = true; }
    return originalKill(player);
  };
  globalThis.ravelBridge = {
    reset(options) {
      tick = 0; ids = new WeakMap(); nextId = 1; fatalState = undefined;
      settings.seed = options.seed;
      game.worlds = [new World(new Vector(0,0),0,monumentalMigration)];
      const area = game.worlds[0].areas[options.area-1];
      area.loadCount = 0; area.load();
      const safe = area.zones.filter(z=>z.type===1 || z.type===4).sort((a,b)=>a.pos.x-b.pos.x)[0];
      if (!safe) throw Error("MM area has no entry shelter");
      const entryX=safe.type===4?Math.min(4,safe.size.x/2):safe.size.x/2;
      const pos = new Vector(area.pos.x+safe.pos.x+entryX,
        area.pos.y+safe.pos.y+15/32+(safe.size.y-30/32)*options.entryY);
      const Hero = options.hero === "Candy" ? Candy : Basic;
      const p = new Hero(pos, options.speed);
      p.area = options.area-1; p.dyingPos = new Vector(pos.x,pos.y);
      if (options.maxStats) p.upgradeToMaxStats();
      p.speed = options.speed;
      p.god = false; p.ghost = false; p.invincible = false;
      game.players = [p];
      return observe();
    },
    observe,
    advance(keys) {
      if (fatalState) return {dead:true, area:game.players[0].area+1};
      tick++;
      game.inputPlayer(0,{keys, isMouse:false, mouse:new Vector(0,0)});
      game.update(1000/60);
      const p = game.players[0];
      return {dead:!!fatalState || p.deathCounter>0 || !!p.isDead, area:p.area+1, world:p.world};
    },
    finalObservation: () => fatalState ?? observe(),
  };
}
