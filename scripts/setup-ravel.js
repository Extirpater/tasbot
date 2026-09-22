import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const manifest=JSON.parse(readFileSync(new URL("../data/ravel-source.json",import.meta.url)));
const target=resolve("artifacts/ravel-source");
if(!existsSync(target)) {
  mkdirSync(dirname(target),{recursive:true});
  const temp=mkdtempSync(join(dirname(target),"ravel-download-"));
  try {
    execFileSync("git",["init",temp],{stdio:"ignore"});
    execFileSync("git",["-C",temp,"remote","add","origin",manifest.repository]);
    execFileSync("git",["-C",temp,"fetch","--depth=1","origin",manifest.commit],{stdio:"inherit"});
    execFileSync("git",["-C",temp,"checkout","--detach","FETCH_HEAD"],{stdio:"inherit"});
    renameSync(temp,target);
  } finally { if(existsSync(temp))rmSync(temp,{recursive:true}); }
}
const {RavelEnvironment}=await import("../src/ravel/environment.js");
const env=new RavelEnvironment({source:target});
env.reset();
console.log(`Ravel ${manifest.commit} verified at ${target}.`);
