import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RavelEnvironment } from "../src/ravel/environment.js";
import { replayTrial, policyRevision } from "../src/ravel/training.js";

const {values}=parseArgs({options:{trace:{type:"string"},output:{type:"string"}}});
if(!values.trace || !values.output)throw Error("Usage: node scripts/verify-ravel-run.js --trace <trace.json> --output <verification.json>");
const trace=JSON.parse(readFileSync(values.trace,"utf8")),env=new RavelEnvironment();
let splits=[],deaths=0;
function record(state,tick) {
  splits.push({area:state.area.number,tick,seconds:tick/60,
    baseSpeed:state.player.baseSpeed/30,candyBoost:state.player.speedBonus/30,
    upgradePoints:state.player.upgradePoints});
}
// Observe native transitions during action replay. These wrappers never
// change input, engine state, physics, or the result of an engine call.
const reset=env.api.reset,advance=env.api.advance;
env.api.reset=options=>{
  const initial=reset(options);splits=[];deaths=0;record(initial,0);return initial;
};
env.api.advance=keys=>{
  const status=advance(keys);
  if(status.dead)deaths++;
  if(status.area!==splits.at(-1).area)record(env.observe(),env.tick);
  return status;
};
const replay=replayTrial(env,trace);
const firstArea=trace.config.area,lastArea=trace.config.endArea+1;
const consecutiveAreas=splits.length===lastArea-firstArea+1 && splits.every((s,i)=>s.area===i+firstArea);
const physicalRangeVerified=replay.matches && replay.outcome==="cleared" && consecutiveAreas && deaths===0;
// Prefix replay is useful for debugging, but cannot prove that one policy
// planned every action in a fresh full-course run.
const requestedRangeVerified=physicalRangeVerified && !trace.prefix;
const physicalCourseVerified=firstArea===1 && lastArea===481 && physicalRangeVerified;
const fullCourseVerified=physicalCourseVerified && !trace.prefix;
const result={schema:1,trace:resolve(values.trace),ravelCommit:trace.ravelCommit,
  recordedPolicyRevision:trace.policyRevision,currentPolicyRevision:policyRevision(),
  requestedRangeVerified,verifiedRange:[firstArea,lastArea-1],physicalRangeVerified,
  fullCourseVerified,physicalCourseVerified,prefix:trace.prefix??null,
  consecutiveAreas,deaths,replay,config:trace.config,summary:trace.summary,
  timingMode:"fixed simulated compute allowance; actual overruns were measured, not inserted",
  splits};
writeFileSync(values.output,JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({requestedRangeVerified,verifiedRange:[firstArea,lastArea-1],
  fullCourseVerified,physicalCourseVerified,visitedAreas:splits.length,deaths,replay,
  seconds:trace.summary.seconds,output:resolve(values.output)},null,2));
process.exitCode=requestedRangeVerified?0:1;
