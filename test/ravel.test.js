import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { advancePlayer, planActions, predictHazardPath } from "../src/planner.js";
import { withRavelModels } from "../src/ravel/models.js";
import { RavelEnvironment } from "../src/ravel/environment.js";
import { aggregate, compareScores, validationGate, runTrial, replayTrial, planningState, planningHorizon } from "../src/ravel/training.js";

const available=existsSync(new URL("../artifacts/ravel-source/entities.js",import.meta.url));
const integration={skip:available?false:"Run npm run ravel:setup for pinned Ravel integration tests"};

test("Ravel rejects a Slippery escape whose follow-up turn misses the decision interval",()=>{
  const f=JSON.parse(readFileSync(new URL("./fixtures/ravel-slip84.json",import.meta.url)));
  const state=planningState(f.state,{avoidBackExit:true});
  const old=planActions(state,f.options).find(c=>c.action==="up_right");
  assert.ok(old.continuedPlan && old.physicalClearance>30);
  assert.ok(old.firstDuration<3/60,"old escape requires another turn before the next decision");
  const candidates=planActions(state,{...f.options,inputIntervalTicks:3});
  assert.ok(candidates.find(c=>c.action==="up_right").physicalClearance<0);
  assert.ok(candidates.some(c=>!c.collision && c.action!=="up_right"));
  for(const c of candidates)for(const input of c.plan.inputs)
    assert.equal((input.tick-10)%3,0,"every scheduled turn can be submitted on a decision update");
});

test("Ravel looks past the giant Dasher corridor trap before committing to it",()=>{
  const f=JSON.parse(readFileSync(new URL("./fixtures/ravel-dasher360.json",import.meta.url)));
  const state=planningState(f.state,{avoidBackExit:true});
  const options={...f.options,maxPlanMs:Infinity};
  const short=planActions(state,options).find(c=>c.action==="focus_down_right");
  assert.ok(!short.collision && short.physicalClearance>30);
  const longer=planActions(state,{...options,horizon:planningHorizon(state,options)});
  assert.ok(longer.find(c=>c.action==="focus_down_right").physicalClearance<0);
  assert.ok(longer.some(c=>!c.collision && c.action!=="focus_down_right"));
});

test("Ravel repeats seeded trajectories and resets inputs, player and enemy state",integration,()=>{
  const env=new RavelEnvironment();
  const rollout=()=>{
    const start=env.reset({area:6,seed:77,hero:"Basic"});
    env.command("right");env.step(60);env.command("down_right");env.step(20);
    return {start,end:env.observe()};
  };
  const a=rollout(),b=rollout();
  assert.deepEqual(a,b);
  assert.equal(b.start.player.x,b.start.area.x+192);
  const different=env.reset({area:6,seed:78,hero:"Basic"});
  assert.notDeepEqual(different.hazards,b.start.hazards);
  different.player.x=-999;
  assert.notEqual(env.observe().player.x,-999);
  assert.equal(env.reset({area:1}).player.x,160,"preserve the wider initial shelter's center");
  const checkpoint=env.reset({area:361});
  assert.equal(checkpoint.player.x-checkpoint.area.x,192);
});

test("Ravel delays commands before movement and uses legacy speed 17 as 510 units/s",integration,()=>{
  const env=new RavelEnvironment();
  const initial=env.reset({hero:"Basic",delayMs:125});
  env.command("right",false,25);
  env.step(8);
  assert.equal(env.observe().player.x,initial.player.x);
  env.step(1);
  assert.equal(env.observe().player.x-initial.player.x,510/60);
  env.step(1);
  assert.equal(env.observe().player.x-initial.player.x,2*510/60);
});

test("Ravel stops on the first death and preserves contact rather than scoring a respawn",integration,()=>{
  const env=new RavelEnvironment();
  env.reset({hero:"Basic"});
  const contact=vm.runInContext(`(() => {
    const a=game.worlds[0].areas[0], e=Object.values(a.entities).flat().find(e=>e.isEnemy);
    game.players[0].pos = new Vector(e.pos.x+a.pos.x,e.pos.y+a.pos.y);
    return {x:game.players[0].pos.x*32,y:game.players[0].pos.y*32};
  })()`,env.context);
  env.step(100);
  assert.equal(env.outcome,"died");assert.equal(env.tick,1);
  assert.equal(env.observe().player.x,contact.x);
  assert.equal(env.observe().player.downed,true);
  env.step(100);assert.equal(env.tick,1);
});

test("Ravel retains inactive Switches and dynamically generated Radiating bullets",integration,()=>{
  const env=new RavelEnvironment();
  const state=env.reset({area:42,hero:"Basic"});
  const switches=state.hazards.filter(e=>e.family==="switch");
  assert.ok(switches.length>0);
  assert.ok(switches.some(e=>e.harmlessUntilMs===3000));
  env.reset({area:106,hero:"Basic"});
  let projectile;
  for(let tick=0;tick<240&&!projectile;tick++){
    env.step();projectile=env.observe().hazards.find(e=>e.family==="radiating_bullet");
  }
  assert.ok(projectile);assert.equal(projectile.bounce,false);
  assert.equal(projectile.radius,8);assert.equal(Math.hypot(projectile.vx,projectile.vy),240);
  assert.ok(Number.isFinite(projectile.entityType));
});

test("Ravel Candy is actually cast and collected before speed reaches 660",integration,()=>{
  const env=new RavelEnvironment();
  const start=env.reset({hero:"Candy",delayMs:0});
  assert.equal(start.player.speed,510);assert.equal(start.player.candy.active,false);
  env.command("right",true);env.step(45);
  const after=env.observe();
  assert.equal(after.player.candy.active,true);assert.equal(after.player.speed,660);
  assert.ok(after.player.candy.remainingMs<15000);
  assert.ok(after.player.candy.cooldownMs>0);
});

test("Ravel restores speed using delayed native upgrades and consumes the refunded points",integration,()=>{
  const env=new RavelEnvironment();env.reset({hero:"Basic",delayMs:125});env.step();
  const points=env.observe().player.upgradePoints;
  vm.runInContext(`(()=>{
    const p=game.players[0];
    new SpeedSniperBullet(new Vector(p.pos.x,p.pos.y),0,10/32,16,4).interact(p,new Vector(0,0));
  })()`,env.context);
  assert.equal(env.observe().player.baseSpeed,390);assert.equal(env.observe().player.upgradePoints,points+8);
  env.command("stay",false,25,true);env.step(8);
  assert.equal(env.observe().player.baseSpeed,390);
  env.step();assert.equal(env.observe().player.baseSpeed,405);
  env.step(7);assert.equal(env.observe().player.baseSpeed,510);
  assert.equal(env.observe().player.upgradePoints,points);
  env.step(10);assert.equal(env.observe().player.baseSpeed,510);
});

test("Ravel Icicles resume after their observed wall pause instead of staying parked forever",integration,()=>{
  const env=new RavelEnvironment();
  env.reset({area:76,hero:"Basic"});
  let state,hazard;
  for(let tick=0;tick<400&&!hazard;tick++){
    env.step();state=env.observe();
    hazard=state.hazards.find(h=>h.family==="icicle" &&
      h.motionEffects?.some(e=>e.name==="icicle wall pause" && e.remainingMs<150));
  }
  assert.ok(hazard);
  assert.equal(Math.hypot(hazard.vx,hazard.vy),0);
  const stopped=hazard.motionEffects.find(e=>e.name==="icicle wall pause");
  const steps=Math.round(stopped.remainingMs*60/1000)+8;
  const forecast=predictHazardPath(hazard,state.area,steps,1/60);
  let maximumError=0,actual;
  for(let i=1;i<=steps;i++){
    env.step();actual=env.observe().hazards.find(h=>h.id===hazard.id);
    maximumError=Math.max(maximumError,Math.hypot(actual.x-forecast[i].x,actual.y-forecast[i].y));
  }
  assert.ok(maximumError<1e-6,`pause/resume error ${maximumError}`);
  assert.ok(Math.hypot(actual.x-hazard.x,actual.y-hazard.y)>20,"old static forecast misses the launch");
});

test("Ravel Icicle forecasts include future wall pauses and discard bounce overshoot",integration,()=>{
  const env=new RavelEnvironment();
  for(const area of [76,80,320,440]) {
    const raw=env.reset({area,hero:"Basic",seed:30001});
    const state=withRavelModels(raw), hazard=state.hazards.find(h=>h.family==="icicle");
    assert.ok(hazard);
    assert.equal(raw.hazards.find(h=>h.id===hazard.id).predictPath,undefined);
    const fine=predictHazardPath(hazard,state.area,180,1/60);
    const coarse=predictHazardPath(hazard,state.area,60,1/20);
    let error=0,parked=0;
    for(let tick=1;tick<=180;tick++){
      env.step();const actual=env.observe().hazards.find(h=>h.id===hazard.id);
      error=Math.max(error,Math.hypot(actual.x-fine[tick].x,actual.y-fine[tick].y));
      if(actual.vx===0&&actual.vy===0)parked++;
      if(tick%3===0)assert.ok(Math.hypot(coarse[tick/3].x-fine[tick].x,coarse[tick/3].y-fine[tick].y)<1e-6);
    }
    assert.ok(parked>0);
    assert.ok(error<1e-6,`area ${area}: forecast error ${error}`);
  }
});

test("Ravel Slippery forecasts match entry, locked turns, ignored Shift, exit and wall steering",integration,()=>{
  for(const wallCase of [false,true]) {
    const env=new RavelEnvironment();env.reset({area:82,hero:"Basic",delayMs:0});env.step();
    vm.runInContext(`(()=>{
      const a=game.worlds[0].areas[81],p=game.players[0];
      const e=Object.values(a.entities).flat().find(e=>e instanceof Slippery);
      a.entities={slippery:[e]};e.pos=new Vector(18.75,${wallCase?3.125:7.5});
      e.vel=new Vector(0,0);e.speed=0;
      p.pos=new Vector(a.pos.x+${wallCase?18.75:10.9375},${wallCase?0.46875:10});
      p.distance_moved_previously=[0,0];
    })()`,env.context);
    const state=withRavelModels(env.observe());let position={...state.player,time:0},slipping=0;
    for(let tick=0;tick<110;tick++) {
      const action=wallCase?(tick<4?"up":"right"):(tick<24?"right":tick<43?"focus_up":"up_right");
      position={...advancePlayer(position,action,state.player,state.area),time:(tick+1)/60};
      env.command(action);env.step();const actual=env.observe().player;
      assert.ok(Math.hypot(actual.x-position.x,actual.y-position.y)<1e-6,`wall=${wallCase}, tick=${tick}`);
      assert.deepEqual(position.motionState,actual.slip);
      if(actual.slip.active)slipping++;
    }
    assert.ok(slipping>10);assert.equal(env.outcome,undefined);
  }
});

test("Ravel Liquid forecasts follow each player path through proximity acceleration and bounces",integration,()=>{
  for(const wallCase of [false,true]) {
    const env=new RavelEnvironment();env.reset({area:71,hero:"Basic",delayMs:0});env.step();
    vm.runInContext(`(()=>{
      const a=game.worlds[0].areas[70],p=game.players[0];
      const e=Object.values(a.entities).flat().find(e=>e instanceof Liquid);
      a.entities={liquid:[e]};e.pos=new Vector(${wallCase?2800:700}/32,240/32);
      e.vel=new Vector(3,0);e.speed=3;e.speedMultiplier=1;
      p.pos=new Vector(a.pos.x+${wallCase?2670:560}/32,130/32);
      p.distance_moved_previously=[0,0];
    })()`,env.context);
    const state=withRavelModels(env.observe()),hazard=state.hazards[0];
    const players=[state.player],actual=[hazard];
    for(let tick=0;tick<120;tick++) {
      env.command(tick<20?"right":tick<45?"left":"stay");env.step();
      const s=env.observe();players.push(s.player);actual.push(s.hazards[0]);
    }
    const path=predictHazardPath(hazard,state.area,120,1/60,t=>players[Math.round(t*60)]);
    let error=0;
    for(let tick=0;tick<=120;tick++)error=Math.max(error,Math.hypot(path[tick].x-actual[tick].x,path[tick].y-actual[tick].y));
    assert.ok(error<1e-6,`wall=${wallCase}: ${error}`);
    assert.ok(actual.some(h=>Math.abs(h.vx)>400));
    assert.ok(actual.at(-1).liquid.multiplier===1);
    if(wallCase)assert.ok(actual.some(h=>h.vx<0));
    assert.equal(env.outcome,undefined);
  }
});

test("Ravel Wavy forecasts preserve curvature, timed reversals and wall reversals",integration,()=>{
  const env=new RavelEnvironment();
  for(const area of [26,30,146,266,386]) {
    const s=withRavelModels(env.reset({area,hero:"Basic",seed:34001}));
    const hazards=s.hazards.filter(h=>h.family==="wavy");assert.ok(hazards.length);
    const paths=hazards.map(h=>predictHazardPath(h,s.area,180,1/60));
    let error=0;
    for(let tick=1;tick<=180;tick++) {
      env.step();const actual=new Map(env.observe().hazards.map(h=>[h.id,h]));
      for(const [i,h] of hazards.entries()) {
        const a=actual.get(h.id),p=paths[i][tick];error=Math.max(error,Math.hypot(a.x-p.x,a.y-p.y));
      }
    }
    assert.ok(error<1e-6,`area ${area}: ${error}`);
  }
});

test("Ravel Turning and Spiral forecasts preserve angular phases and collision reversals",integration,()=>{
  const env=new RavelEnvironment();
  for(const area of [31,35,51,55,151,171,271,291,391,411]) {
    const s=withRavelModels(env.reset({area,hero:"Basic",seed:35001}));
    const hazards=s.hazards.filter(h=>h.turningCurve || h.spiralPhase);assert.ok(hazards.length);
    const paths=hazards.map(h=>predictHazardPath(h,s.area,180,1/60));let error=0;
    for(let tick=1;tick<=180;tick++) {
      env.step();const actual=new Map(env.observe().hazards.map(h=>[h.id,h]));
      for(const [i,h] of hazards.entries()) {
        const a=actual.get(h.id),p=paths[i][tick];error=Math.max(error,Math.hypot(a.x-p.x,a.y-p.y));
      }
    }
    assert.ok(error<1e-6,`area ${area}: ${error}`);
  }
});

test("Ravel Dasher forecasts match native movement order, phase transitions and clamped walls",integration,()=>{
  const env=new RavelEnvironment();
  for(const area of [6,10,120,240,360,480]) {
    const s=withRavelModels(env.reset({area,hero:"Basic",seed:20001}));
    const hazards=s.hazards.filter(h=>h.dash);assert.ok(hazards.length);
    const paths=hazards.map(h=>predictHazardPath(h,s.area,360,1/60));let error=0;
    for(let tick=1;tick<=360;tick++) {
      env.step();const actual=new Map(env.observe().hazards.map(h=>[h.id,h]));
      for(const [i,h] of hazards.entries()) {
        const a=actual.get(h.id),p=paths[i][tick];error=Math.max(error,Math.hypot(a.x-p.x,a.y-p.y));
      }
    }
    assert.ok(error<1e-6,`area ${area}: ${error}`);
  }
});

test("Ravel predicts Ice Sniper shots from current clocks and covers both spawn schedules",integration,()=>{
  const env=new RavelEnvironment();
  for(const existingGroup of [false,true])for(const nearWall of [false,true]) {
    env.reset({area:450,hero:"Basic",seed:42,delayMs:0});env.step();
    vm.runInContext(`(()=>{
      const a=game.worlds[0].areas[449],p=game.players[0];a.entities={};
      p.pos=new Vector(a.pos.x+${nearWall?27:35},7.5);
      const gun=new IceSniper(new Vector(${nearWall?347/32:20},7.5),27/32,5,${nearWall?Math.PI:0});
      gun.clock=2800;a.addEntity('probe',gun);
      ${existingGroup?"a.addSniperBullet(1,new Vector(-100,0),0,10/32,16);":""}
    })()`,env.context);
    const s=env.observe(),model=withRavelModels(s).hazards.find(h=>h.family==="forecast_ice_bullet");
    assert.ok(model);const predicted={...model.reactive.initial};let checked=0;
    for(let tick=0;tick<45;tick++) {
      const before=env.observe().player;env.step();const after=env.observe();
      model.reactive.step(predicted,{},before,1/60,1,tick*1000/60,after.player);
      const bullet=after.hazards.find(h=>h.bounce===false);
      if(bullet) {
        assert.equal(predicted.born,true);
        const error=Math.hypot(predicted.x-bullet.x,predicted.y-bullet.y);
        assert.ok(error<=model.radius-bullet.radius+1e-6,`spawn error ${error}`);checked++;
      } else assert.equal(predicted.born,false);
    }
    assert.ok(checked>20);
    const away={...model.reactive.initial};
    for(let tick=0;tick<180;tick++)model.reactive.step(away,{},undefined,1/60,1,tick*1000/60);
    assert.equal(away.born,false,"a ready shooter waits for a detectable target");
  }
});

test("Ravel distinguishes forward exits from deaths and supports later MM blocks",integration,()=>{
  const env=new RavelEnvironment();
  for(const area of [1,41,120,240,360,361,480]){
    const start=env.reset({area,hero:"Basic",delayMs:0});
    assert.equal(start.area.number,area);
    vm.runInContext(`(() => {
      const a=game.worlds[0].areas[${area-1}];
      const exit=a.zones.filter(z=>z.type===2).sort((a,b)=>b.pos.x-a.pos.x)[0];
      game.players[0].pos=new Vector(a.pos.x+exit.pos.x+exit.size.x/2,a.pos.y+exit.pos.y+exit.size.y/2);
    })()`,env.context);
    env.step();assert.equal(env.outcome,"cleared");
    assert.equal(env.observe().area.number,area+1);
  }
});

test("Ravel action replay reproduces the final state with jitter independently of planner timing",integration,()=>{
  const env=new RavelEnvironment();
  const trial=runTrial(env,{area:1,seed:17,maxSeconds:0.25,jitterMs:20});
  assert.equal(trial.summary.outcome,"timeout");
  assert.equal(replayTrial(env,trial.trace).matches,true);
  const older=structuredClone(trial.trace);
  delete older.finalPhysicsDigest;
  older.finalDigest="old forecast annotations";
  assert.equal(replayTrial(env,older).matches,true);
  assert.equal(replayTrial(env,older).fullObservationMatches,false);
  older.finalState.player.x+=1;
  assert.equal(replayTrial(env,older).matches,false);
  const corrupted=structuredClone(trial.trace);corrupted.config.seed++;
  assert.throws(()=>replayTrial(env,corrupted),/reset differs/);
});

test("Ravel replay preserves projectile identity when observations are skipped",integration,()=>{
  const env=new RavelEnvironment();
  const trial=runTrial(env,{area:106,seed:1,maxSeconds:3,computeMs:50});
  assert.ok(trial.trace.frames.some(f=>f.state.hazards.some(h=>h.family==="radiating_bullet")));
  assert.equal(replayTrial(env,trial.trace).matches,true);
});

test("Ravel recorded prefixes reproduce native state before resuming decisions",integration,()=>{
  const env=new RavelEnvironment();
  const options={area:1,endArea:2,seed:42,maxSeconds:20,computeMs:50};
  const policy={avoidBackExit:true};
  const original=runTrial(env,options,policy);
  assert.equal(original.summary.outcome,"cleared");
  const prefix={trace:original.trace,area:2};
  const resumed=runTrial(env,options,policy,{prefix});
  assert.equal(resumed.summary.outcome,"cleared");
  assert.ok(resumed.summary.replayedDecisions>0);
  assert.ok(resumed.summary.replayedDecisions<resumed.summary.decisions);
  assert.equal(resumed.trace.prefix.area,2);
  assert.deepEqual(resumed.trace.decisions,original.trace.decisions);
  assert.equal(resumed.trace.finalPhysicsDigest,original.trace.finalPhysicsDigest);
  assert.equal(replayTrial(env,resumed.trace).matches,true);
  assert.throws(()=>runTrial(env,{...options,seed:43},policy,{prefix}),/prefix\/reset/);
  assert.throws(()=>runTrial(env,{...options,computeMs:25},policy,{prefix}),/configuration differs/);
});

const row=(area,seed,outcome,seconds)=>({area,seed,outcome,seconds,progress:1,computeBudgetMisses:0});
test("Ravel training ranks survival ahead of fast deaths and rejects held-out regressions",()=>{
  const baseline=[row(1,1001,"cleared",6),row(2,1001,"died",0.1)];
  const slowerSurvivor=[row(1,1001,"cleared",7),row(2,1001,"cleared",10)];
  assert.ok(compareScores(aggregate(slowerSurvivor,25),aggregate(baseline,25))<0);
  assert.equal(validationGate(baseline,slowerSurvivor,25).accepted,true);
  const regression=[row(1,1001,"died",0.1),row(2,1001,"cleared",2)];
  assert.equal(validationGate(baseline,regression,25).accepted,false);
  assert.equal(validationGate(baseline,baseline,25).accepted,false);
  assert.throws(()=>validationGate(baseline,regression.slice(1),25),/cases differ/);
});

test("Ravel forward-clear policy avoids the backward exit while preserving the real observation",()=>{
  const left={type:2,x:0,y:0,width:64,height:480};
  const right={type:2,x:3136,y:0,width:64,height:480};
  const state={area:{x:0,width:3200,zones:[left,right],walls:[]}};
  const guarded=planningState(state,{avoidBackExit:true});
  assert.deepEqual(guarded.area.walls,[left]);
  assert.deepEqual(state.area.walls,[]);
  assert.equal(planningState(state,{avoidBackExit:false}),state);
});
