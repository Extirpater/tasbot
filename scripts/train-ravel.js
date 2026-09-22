import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { RavelEnvironment, RAVEL_COMMIT } from "../src/ravel/environment.js";
import { BASELINE_POLICY,FAMILY_AREAS,runTrial,replayTrial,aggregate,compareScores,
  candidatePolicies,validationGate,validatePolicy,policyRevision } from "../src/ravel/training.js";

const {values}=parseArgs({options:{
  train:{type:"boolean",default:false},areas:{type:"string",default:"families"},
  seeds:{type:"string",default:"1-2"},"validation-seeds":{type:"string",default:"10001-10002"},
  candidates:{type:"string",default:"4"},output:{type:"string"},
  hero:{type:"string",default:"Candy"},speed:{type:"string",default:"17"},
  "delay-ms":{type:"string",default:"125"},"jitter-ms":{type:"string",default:"0"},
  "compute-ms":{type:"string",default:"25"},"max-seconds":{type:"string",default:"25"},
  "warmup-ticks":{type:"string",default:"0"},"entry-y":{type:"string",default:"0.5"},
  "no-candy":{type:"boolean",default:false},continuous:{type:"boolean",default:false},
  "no-upgrades":{type:"boolean",default:false},
  policy:{type:"string"},replay:{type:"string"},help:{type:"boolean",default:false},
  prefix:{type:"string"},"resume-area":{type:"string"},
}});
if(values.help) {
  console.log(`npm run ravel:setup
npm run ravel:eval -- --areas families --seeds 1-3
npm run ravel:train -- --areas 26,31,42,46 --seeds 1-3 --validation-seeds 10001-10003
npm run ravel:eval -- --policy artifacts/ravel/<run>/checkpoint.json --areas 1-480 --seeds 20001
npm run ravel:eval -- --policy data/ravel-policy.json --continuous --areas 1-480 --max-seconds 3600 --compute-ms 50 --seeds 20001
npm run ravel:eval -- --replay artifacts/ravel/<run>/baseline/area-31-seed-1.json
npm run ravel:verify -- --trace artifacts/ravel/<run>/baseline/area-1-seed-20001.json --output artifacts/ravel/<run>/verification.json

Fixed 60 Hz simulation; defaults: Candy, speed 17, max stats/abilities, automatic
Sweet Tooth, 125 ms input delay + 25 ms simulated compute, 2-tick observations.
Lost speed is restored using available points while waiting in shelter;
--no-upgrades disables this. The actual decision interval includes compute time.
Parameter search trains on --seeds, then validates one winner on disjoint seeds.
This saves a Ravel-only checkpoint; it never modifies the live policy.`);
  process.exit(0);
}
function numbers(spec,max) {
  const result=[];
  for(const part of spec.split(",")) {
    if(!/^\d+(?:-\d+)?$/.test(part))throw Error(`Invalid range ${part}`);
    const [start,end=start]=part.split("-").map(Number);
    if(start<1||end<start||end>max||end-start>10000)throw Error(`Out of range ${part}`);
    for(let i=start;i<=end;i++)result.push(i);
  }
  return [...new Set(result)];
}
const env=new RavelEnvironment();
if(values.replay) {
  const result=replayTrial(env,JSON.parse(readFileSync(values.replay,"utf8")));
  console.log(JSON.stringify(result,null,2));
  process.exitCode=result.matches?0:1;
} else {
  const areas=values.areas==="families"?FAMILY_AREAS:numbers(values.areas,480);
  const seeds=numbers(values.seeds,0xffffffff),validationSeeds=numbers(values["validation-seeds"],0xffffffff);
  const candidateCount=Number(values.candidates);
  if(!Number.isInteger(candidateCount)||candidateCount<1||candidateCount>8)throw Error("--candidates must be 1–8");
  if(values.train&&seeds.some(s=>validationSeeds.includes(s)))throw Error("Training and validation seeds must be disjoint");
  if(values.continuous && areas.some((n,i)=>i&&n!==areas[i-1]+1))throw Error("Continuous areas must form an increasing range");
  const config={hero:values.hero,speed:Number(values.speed),delayMs:Number(values["delay-ms"]),
    jitterMs:Number(values["jitter-ms"]),computeMs:Number(values["compute-ms"]),maxSeconds:Number(values["max-seconds"]),
    warmupTicks:Number(values["warmup-ticks"]),entryY:Number(values["entry-y"]),autoCandy:!values["no-candy"],autoUpgrade:!values["no-upgrades"]};
  const startPolicy=validatePolicy(values.policy?JSON.parse(readFileSync(values.policy,"utf8")).policy:BASELINE_POLICY);
  if(Boolean(values.prefix)!==Boolean(values["resume-area"]))throw Error("Use --prefix with --resume-area");
  const prefix=values.prefix?{trace:JSON.parse(readFileSync(values.prefix,"utf8")),area:Number(values["resume-area"])}:undefined;
  if(prefix && (!values.continuous || values.train || seeds.length!==1))throw Error("Prefix debugging requires one continuous evaluation seed");
  const output=resolve(values.output??`artifacts/ravel/${new Date().toISOString().replaceAll(":","-")}`);
  mkdirSync(output,{recursive:true});
  const report={schema:1,ravelCommit:RAVEL_COMMIT,policyRevision:policyRevision(),
    runtime:{node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch},
    mode:prefix?"prefix-debug":values.train?"parameter-search":"evaluation",config,areas,seeds,validationSeeds:values.train?validationSeeds:[],
    prefix:prefix?{trace:resolve(values.prefix),area:prefix.area}:undefined,
    timingMode:"fixed compute allowance; measured overruns are reported, not simulated",
    continuous:values.continuous,status:"running",evaluations:[]};
  function writeJSON(file,value,pretty=false){
    const temp=`${file}.tmp`;
    writeFileSync(temp,JSON.stringify(value,null,pretty?2:undefined)+"\n");
    renameSync(temp,file);
  }
  function save(){writeJSON(join(output,"report.json"),report,true);}
  save();
  function evaluate(label,policy,caseSeeds) {
    const rows=[]; const dir=join(output,label);mkdirSync(dir,{recursive:true});
    const evaluatedAreas=values.continuous?[areas[0]]:areas;
    const total=evaluatedAreas.length*caseSeeds.length;
    for(const area of evaluatedAreas)for(const seed of caseSeeds) {
      const trial=runTrial(env,{...config,area,endArea:values.continuous?areas.at(-1):area,seed},policy,{
        prefix,
        onProgress:values.continuous?({area:reached,seconds,replayed})=>{
          if(!replayed)console.log(`${label} seed ${seed}: reached area ${reached} at ${seconds.toFixed(2)}s`);
        }:undefined,
      });
      rows.push(trial.summary);
      // Keep successful cases too: actions allow an exact replay without planning.
      const name=`area-${area}-seed-${seed}.json`;
      writeJSON(join(dir,name),trial.trace);
      writeJSON(join(dir,"results.json"),{policy,rows},true);
      console.log(`${label} ${rows.length}/${total} area ${area} seed ${seed}: ${trial.summary.outcome} ${trial.summary.seconds.toFixed(2)}s; p95 ${trial.summary.p95PlanMs.toFixed(1)}ms`);
    }
    const result={label,policy,score:aggregate(rows,config.maxSeconds),rows};
    report.evaluations.push(result);save();return result;
  }
  try {
    const baseline=evaluate("baseline",startPolicy,seeds);
    if(values.train) {
      let winner=baseline;
      for(const [i,policy]of candidatePolicies(startPolicy).slice(1,candidateCount).entries()) {
        const candidate=evaluate(`candidate-${i+1}`,policy,seeds);
        if(compareScores(candidate.score,winner.score)<0)winner=candidate;
      }
      // The held-out set is touched only after selecting a single training winner.
      const validationBaseline=evaluate("validation-baseline",startPolicy,validationSeeds);
      const validationCandidate=winner===baseline?validationBaseline:evaluate("validation-candidate",winner.policy,validationSeeds);
      const gate=validationGate(validationBaseline.rows,validationCandidate.rows,config.maxSeconds);
      report.selectedTrainingLabel=winner.label;report.validation=gate;
      const chosen=gate.accepted?winner.policy:startPolicy;
      const checkpoint={schema:1,environment:"ravel-only",ravelCommit:RAVEL_COMMIT,
        policyRevision:report.policyRevision,policy:chosen,trained:gate.accepted,validation:gate,
        trainingSeeds:seeds,validationSeeds,areas,config,report:"report.json",liveValidated:false};
      writeJSON(join(output,"checkpoint.json"),checkpoint,true);
      console.log(gate.accepted?"Held-out improvement accepted; Ravel checkpoint saved.":"No held-out improvement passed the gate; baseline retained.");
    }
    report.status="complete";save();console.log(`Report: ${join(output,"report.json")}`);
  } catch(error) {report.status="error";report.error=String(error.stack??error);save();throw error;}
}
