import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { planActions, ACTIONS } from "../planner.js";
import { MotionTracker } from "../observe.js";
import { MovementPolicy } from "../movement.js";
import { Navigation } from "../navigation.js";
import { CandyPolicy } from "../candy.js";
import { speedUpgradeKey } from "../upgrades.js";
import { RAVEL_COMMIT } from "./environment.js";
import { withRavelModels } from "./models.js";

export const BASELINE_POLICY = Object.freeze({margin:14,horizon:0.9,beamWidth:3,commitmentMs:100,avoidBackExit:false});
export const FAMILY_AREAS = [1,4,6,11,16,21,26,28,31,32,36,42,46,51,56,61,66,69,71,76,82,86,106,116];
export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Forecast annotations can improve without changing recorded game physics.
// Keep their full observation digest too, but compare physical observations
// independently so old actions remain replayable after an adapter improvement.
export function physicalDigest(state) {
  const pick=(value,keys)=>Object.fromEntries(keys.map(key=>[key,value[key]]));
  return digest({packet:state.packet,area:state.area,
    player:pick(state.player,["x","y","radius","speed","baseSpeed","energy","maxEnergy","downed","candy"]),
    hazards:state.hazards.map(h=>pick(h,["id","family","x","y","radius","vx","vy"])),
    auras:(state.auras??[]).map(a=>pick(a,["id","type","x","y","vx","vy","auraRadius","reduction"])),
  });
}
const sourceRevision = (() => {
  const files = ["planner","navigation","movement","observe","candy","upgrades","ravel/environment","ravel/bridge","ravel/observe","ravel/models","ravel/training"];
  return createHash("sha256").update(files.map(f=>readFileSync(new URL(`../${f}.js`,import.meta.url))).join("\n")).digest("hex").slice(0,12);
})();
export function policyRevision() { return sourceRevision; }
export function validatePolicy(value) {
  const p={...BASELINE_POLICY,...value};
  if(Object.keys(p).some(k=>!Object.hasOwn(BASELINE_POLICY,k)) ||
    !Number.isFinite(p.margin)||p.margin<0||p.margin>80 ||
    !Number.isFinite(p.horizon)||p.horizon<0.3||p.horizon>2 ||
    !Number.isInteger(p.beamWidth)||p.beamWidth<1||p.beamWidth>8 ||
    !Number.isFinite(p.commitmentMs)||p.commitmentMs<0||p.commitmentMs>300 ||
    typeof p.avoidBackExit!=="boolean")
    throw Error("Invalid Ravel planner policy");
  return p;
}

export function planningState(state,policy) {
  state=withRavelModels(state);
  if(!policy.avoidBackExit)return state;
  const backward=state.area.zones.filter(z=>z.type===2 && z.x+z.width/2<state.area.x+state.area.width/2);
  return {...state,area:{...state.area,walls:[...(state.area.walls??[]),...backward]}};
}

export function planningHorizon(state,policy) {
  // Large Dashers can close a corridor after the ordinary search ends.
  // Look through that commitment when a body spans at least 1/4 of the room.
  const largeDasher=state.hazards.some(h=>h.dash && h.radius*2>=state.area.height/4);
  return Math.max(policy.horizon,state.player.slip?2:largeDasher?1.5:0);
}

export function runTrial(env, options = {}, policy = BASELINE_POLICY, {onProgress,prefix} = {}) {
  policy=validatePolicy(policy);
  const config={maxSeconds:25,decisionTicks:2,computeMs:25,warmupTicks:0,autoCandy:true,autoUpgrade:true,...options};
  if(!Number.isFinite(config.maxSeconds)||config.maxSeconds<=0||config.maxSeconds>3600 ||
     !Number.isInteger(config.decisionTicks)||config.decisionTicks<1||config.decisionTicks>60 ||
     !Number.isFinite(config.computeMs)||config.computeMs<0||config.computeMs>1000 ||
     !Number.isInteger(config.warmupTicks)||config.warmupTicks<0||config.warmupTicks>36000)
    throw Error("Invalid Ravel trial timing");
  env.reset(config);
  env.step(config.warmupTicks);
  const tracker=new MotionTracker(), movement=new MovementPolicy(policy), navigation=new Navigation(), candy=new CandyPolicy();
  const initial=env.observe(), startedTick=env.tick;
  let replaying=Boolean(prefix),prefixIndex=0;
  if(prefix) {
    if(prefix.trace.schema!==1 || prefix.trace.ravelCommit!==RAVEL_COMMIT ||
      !Number.isInteger(prefix.area) || prefix.area<=env.options.area || prefix.area>env.options.endArea ||
      prefix.area>prefix.trace.summary.reachedArea ||
      physicalDigest(initial)!==prefix.trace.initialPhysicsDigest)
      throw Error("Invalid recorded prefix/reset");
    for(const key of ["area","seed","hero","speed","maxStats","entryY","delayMs","jitterMs","computeMs","decisionTicks","warmupTicks"])
      if((config[key]??env.options[key])!==prefix.trace.config[key])throw Error(`Prefix configuration differs: ${key}`);
  }
  const decisions=[], frames=[], timings=[];
  let changes=0, reversals=0, focus=0, pathLength=0, peakSpeed=initial.player.speed;
  let last=initial.player, lastAction="stay", lastArea=initial.area.id;
  const wallStart=performance.now();
  const maxTick=startedTick+Math.ceil(config.maxSeconds*60);
  const cycleTicks=Math.max(config.decisionTicks,Math.ceil(config.computeMs*60/1000-1e-9));
  while(!env.outcome && env.tick<maxTick) {
    const observation=tracker.update(env.observe()), state=planningState(observation,policy), at=env.tick*1000/60;
    if(state.area.id!==lastArea) {
      movement.reset(); movement.record(env.input.action,at); navigation.reset(); lastArea=state.area.id;
    }
    movement.observe(state,at,env.options.delayMs);
    if(prefix && state.area.number>=prefix.area)replaying=false;
    const recorded=replaying?prefix.trace.decisions[prefixIndex++]:undefined;
    let action,upgrade,selected;
    if(replaying) {
      if(!recorded || recorded.tick!==env.tick)throw Error("Recorded prefix ended before the requested area");
      action=recorded.action;upgrade=recorded.upgrade??false;movement.reason="recorded prefix";
    } else {
    const wantsUpgrade=config.autoUpgrade && Boolean(speedUpgradeKey(state,env.options.speed*30));
    const started=performance.now();
    const route=navigation.update(state,at);
    const candidates=planActions(state,{
      ...policy, ...movement.planOptions(at), navigation:route,
      ...(wantsUpgrade?{fastPath:false}:{}),
      // Entering an overlapping Slippery aura can commit motion for longer
      // than the ordinary dodge horizon. Check that commitment before entry.
      horizon:planningHorizon(state,policy),
      reactionTime:(env.options.delayMs+config.computeMs)/1000,
      inputIntervalTicks:cycleTicks,
      pendingInputs:env.pendingInputs(),
      // Fixed search effort keeps seed/action replays deterministic. Actual
      // compute times and budget misses are reported separately for transfer.
      maxPlanMs:Infinity,
    });
    action=movement.select(candidates,undefined,at);
    upgrade=wantsUpgrade && candidates.some(c=>c.action==="stay" && !c.collision);
    if(upgrade) {
      action="stay";movement.retarget();movement.reason="restore speed in shelter";
    }
    timings.push(performance.now()-started);
    selected=candidates.find(c=>c.action===action);
    }
    movement.record(action,at+config.computeMs);
    const requestedCandy=config.autoCandy && candy.keys(state,action,at).length>0;
    const useCandy=recorded?.candy??requestedCandy;
    env.command(action,useCandy,config.computeMs,upgrade);
    const command={tick:env.tick,action,candy:useCandy,computeMs:config.computeMs,upgrade};
    decisions.push(command);
    frames.push({state:observation,action,clearance:selected?.physicalClearance??null,reason:movement.reason});
    if(frames.length>90)frames.shift();
    if(action!==lastAction) {
      changes++;
      const a=ACTIONS[action],b=ACTIONS[lastAction];
      if(a.dx*b.dx<0||a.dy*b.dy<0)reversals++;
    }
    if(action.startsWith("focus_"))focus++;
    lastAction=action;
    env.step(Math.min(cycleTicks,maxTick-env.tick));
    const after=env.observe();
    if(after.area.id!==state.area.id)onProgress?.({area:after.area.number,seconds:(env.tick-startedTick)/60,replayed:Boolean(recorded)});
    if(after.area.id===state.area.id)pathLength+=Math.hypot(after.player.x-last.x,after.player.y-last.y);
    last=after.player; peakSpeed=Math.max(peakSpeed,after.player.speed);
  }
  const finalState=env.observe();
  const areaProgress=Math.max(0,Math.min(1,(finalState.player.x-finalState.area.x)/finalState.area.width));
  const courseProgress=(finalState.area.number-env.options.area+areaProgress)/(env.options.endArea-env.options.area+1);
  timings.sort((a,b)=>a-b);
  const summary={
    area:env.options.area,endArea:env.options.endArea,seed:env.options.seed,
    outcome:env.outcome??"timeout",seconds:(env.tick-startedTick)/60,
    reachedArea:finalState.area.number,decisions:decisions.length,changes,reversals,
    replayedDecisions:prefixIndex,
    focusFraction:focus/Math.max(1,decisions.length),pathLength,peakSpeed,
    progress:env.options.endArea>env.options.area
      ?Math.max(0,Math.min(1,courseProgress))
      :Math.max(0,Math.min(1,(finalState.player.x-initial.player.x)/(initial.area.width-160))),
    medianPlanMs:timings[Math.floor(timings.length*0.5)]??0,
    p95PlanMs:timings[Math.floor(timings.length*0.95)]??0,
    computeBudgetMisses:timings.filter(t=>t>config.computeMs).length,
    wallSeconds:(performance.now()-wallStart)/1000,
  };
  return {summary,trace:{schema:1,ravelCommit:RAVEL_COMMIT,policyRevision:policyRevision(),
    prefix:prefix?{area:prefix.area,policyRevision:prefix.trace.policyRevision,traceDigest:digest(prefix.trace),decisions:prefixIndex}:undefined,
    runtime:{node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch},
    config:{...env.options,...config},policy,initialDigest:digest(initial),finalDigest:digest(finalState),
    initialPhysicsDigest:physicalDigest(initial),finalPhysicsDigest:physicalDigest(finalState),
    summary,decisions,frames,finalState}};
}

export function replayTrial(env, trace) {
  if(trace.schema!==1 || trace.ravelCommit!==RAVEL_COMMIT)throw Error("Unsupported Ravel replay source/schema");
  env.reset(trace.config); env.step(trace.config.warmupTicks);
  const initialMatches=trace.initialPhysicsDigest
    ?physicalDigest(env.observe())===trace.initialPhysicsDigest
    :digest(env.observe())===trace.initialDigest;
  if(!initialMatches)throw Error("Replay reset differs from recording");
  for(const command of trace.decisions) {
    if(env.outcome)break;
    if(!Number.isInteger(command.tick)||command.tick<env.tick)throw Error("Invalid replay command order");
    env.step(command.tick-env.tick);
    env.command(command.action,command.candy,command.computeMs,command.upgrade);
  }
  const endTick=trace.config.warmupTicks+Math.round(trace.summary.seconds*60);
  env.step(Math.max(0,endTick-env.tick));
  const finalState=env.observe(), finalDigest=digest(finalState), outcome=env.outcome??"timeout";
  const finalPhysicsDigest=physicalDigest(finalState);
  return {outcome,matches:outcome===trace.summary.outcome &&
    finalPhysicsDigest===(trace.finalPhysicsDigest??physicalDigest(trace.finalState)),
    fullObservationMatches:finalDigest===trace.finalDigest,finalDigest,finalPhysicsDigest};
}

export function aggregate(rows,maxSeconds) {
  const cleared=rows.filter(r=>r.outcome==="cleared");
  return {trials:rows.length,cleared:cleared.length,clearRate:cleared.length/Math.max(1,rows.length),
    penalizedSeconds:rows.reduce((n,r)=>n+(r.outcome==="cleared"?r.seconds:maxSeconds+10),0),
    meanClearSeconds:cleared.length?cleared.reduce((n,r)=>n+r.seconds,0)/cleared.length:null,
    deaths:rows.filter(r=>r.outcome==="died").length,timeouts:rows.filter(r=>r.outcome==="timeout").length,
    wrongExits:rows.filter(r=>r.outcome==="wrong-exit").length,
    meanProgress:rows.reduce((n,r)=>n+r.progress,0)/Math.max(1,rows.length),
    computeBudgetMisses:rows.reduce((n,r)=>n+r.computeBudgetMisses,0)};
}
// Completion dominates speed; a quick death never improves the objective.
export function compareScores(a,b) {
  return b.cleared-a.cleared || a.penalizedSeconds-b.penalizedSeconds;
}
export function validationGate(baseline,candidate,maxSeconds) {
  const byCase=new Map(candidate.map(r=>[`${r.area}:${r.seed}`,r]));
  if(baseline.length!==candidate.length || baseline.some(r=>!byCase.has(`${r.area}:${r.seed}`)))
    throw Error("Validation cases differ");
  const regressions=baseline.filter(r=>r.outcome==="cleared" && byCase.get(`${r.area}:${r.seed}`).outcome!=="cleared");
  return {accepted:!regressions.length && compareScores(aggregate(candidate,maxSeconds),aggregate(baseline,maxSeconds))<0,
    regressions:regressions.map(r=>({area:r.area,seed:r.seed}))};
}
export function candidatePolicies(start = BASELINE_POLICY) {
  const p=validatePolicy(start);
  return [p,{...p,avoidBackExit:!p.avoidBackExit},{...p,margin:Math.min(80,p.margin+8)},
    {...p,horizon:Math.max(0.3,p.horizon-0.25)},
    {...p,horizon:Math.min(2,p.horizon+0.3)},
    {...p,margin:Math.max(0,p.margin-6)},
    {...p,beamWidth:Math.min(8,p.beamWidth+2)},
    {...p,commitmentMs:Math.min(300,p.commitmentMs+50)}]
    .filter((v,i,all)=>all.findIndex(x=>digest(x)===digest(v))===i);
}
