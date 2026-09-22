import vm from "node:vm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ACTIONS } from "../planner.js";
import { installRavelBridge } from "./bridge.js";
import { createRavelObserver } from "./observe.js";

export const RAVEL_COMMIT = "563f5434f68d07b2d70ede3f307f857157d42107";
const manifest = JSON.parse(readFileSync(new URL("../../data/ravel-source.json", import.meta.url)));
const cache = new Map();
const clone = (value) => JSON.parse(JSON.stringify(value));

export class RavelEnvironment {
  constructor({source = fileURLToPath(new URL("../../artifacts/ravel-source/", import.meta.url))} = {}) {
    const root = resolve(source);
    let scripts = cache.get(root);
    if (!scripts) {
      scripts = Object.entries(manifest.files).map(([file, expected]) => {
        const code = readFileSync(resolve(root,file),"utf8");
        const actual = createHash("sha256").update(code).digest("hex");
        if (actual !== expected) throw Error(`Ravel ${file} differs from pinned source. Run npm run ravel:setup in a fresh checkout.`);
        return new vm.Script(code,{filename:`ravel/${file}`});
      });
      cache.set(root,scripts);
    }
    this.context = vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
    for (const script of scripts) script.runInContext(this.context,{timeout:5000});
    vm.runInContext(`(${installRavelBridge.toString()})(${createRavelObserver.toString()})`,this.context,{timeout:5000});
    this.api = this.context.ravelBridge;
  }

  reset(options = {}) {
    this.options = {area:1,endArea:options.area??1,seed:1,hero:"Candy",speed:17,
      maxStats:true,entryY:0.5,delayMs:125,jitterMs:0,...options};
    const o = this.options;
    if (!Number.isInteger(o.area) || o.area<1 || o.area>480 ||
        !Number.isInteger(o.endArea) || o.endArea<o.area || o.endArea>480 ||
        !Number.isInteger(o.seed) || o.seed<0 || o.seed>0xffffffff ||
        !["Basic","Candy"].includes(o.hero) || !Number.isFinite(o.speed) || o.speed<1 || o.speed>17 ||
        !Number.isFinite(o.entryY) || o.entryY<0 || o.entryY>1 ||
        !Number.isFinite(o.delayMs) || o.delayMs<0 || o.delayMs>1000 ||
        !Number.isFinite(o.jitterMs) || o.jitterMs<0 || o.jitterMs>o.delayMs)
      throw Error("Invalid Ravel trial configuration");
    this.tick=0; this.queue=[]; this.input={action:"stay",candy:false,upgrade:false}; this.lastSubmitted=undefined;
    this.sequence=0; this.outcome=undefined;
    this.api.reset(o);
    return this.observe();
  }

  observe() { return clone(this.api.finalObservation()); }

  command(action, candy = false, computeMs = 0, upgrade = false) {
    if (!ACTIONS[action] || !Number.isFinite(computeMs) || computeMs<0) throw Error("Invalid Ravel input");
    const signature = `${action}:${!!candy}:${!!upgrade}`;
    if (signature === this.lastSubmitted) return;
    this.lastSubmitted=signature;
    // Counter-based jitter is independent of the engine's RNG stream.
    const hash = Math.imul((this.options.seed ^ ++this.sequence)>>>0,2654435761)>>>0;
    const jitter = (hash/0xffffffff*2-1)*this.options.jitterMs;
    const delay = this.options.delayMs + computeMs;
    const due = this.tick + Math.max(1,Math.ceil((delay+jitter)*60/1000-1e-9));
    const prior = this.queue.at(-1)?.tick ?? 0;
    // A reliable ordered connection cannot deliver a newer key state first.
    this.queue.push({tick:Math.max(prior,due),expectedTick:this.tick+Math.max(1,Math.ceil(delay*60/1000-1e-9)),action,candy:!!candy,upgrade:!!upgrade});
  }

  pendingInputs() {
    return [{time:0,action:this.input.action},...this.queue.map(c=>({
      time:Math.max(0,(c.expectedTick-this.tick)/60),action:c.action,
    }))];
  }

  step(ticks = 1) {
    if (!Number.isInteger(ticks) || ticks<0 || ticks>36000) throw Error("Invalid step count");
    for(let i=0;i<ticks && !this.outcome;i++) {
      this.tick++;
      while(this.queue.length && this.queue[0].tick<=this.tick) this.input=this.queue.shift();
      const direction=ACTIONS[this.input.action], keys=[];
      if(direction.dx<0)keys[37]=true; if(direction.dx>0)keys[39]=true;
      if(direction.dy<0)keys[38]=true; if(direction.dy>0)keys[40]=true;
      if(direction.scale===0.5)keys[16]=true;
      if(this.input.candy)keys[88]=true;
      if(this.input.upgrade)keys[49]=true;
      const status=this.api.advance(keys);
      if(status.dead)this.outcome="died";
      else if(status.world!==0 || status.area<this.options.area)this.outcome="wrong-exit";
      else if(status.area>this.options.endArea)this.outcome="cleared";
    }
    return this.outcome;
  }
}
