import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";
import { PageController } from "../src/controller.js";
import { ravelControlScript, prepareRavelPlanning } from "../src/ravel/browser.js";
import { RavelEnvironment } from "../src/ravel/environment.js";
import { planningState, planningHorizon } from "../src/ravel/training.js";
import { predictHazardPath, advancePlayer } from "../src/planner.js";

const source = resolve("artifacts/ravel-source");
const available = existsSync(`${source}/index.html`);
const policy = JSON.parse(await readFile(new URL("../data/ravel-policy.json", import.meta.url))).policy;

test("browser preparation retains the tested Ravel physics and long horizons", {skip:!available}, () => {
  const env = new RavelEnvironment();
  for (const area of [6, 16, 26, 36, 76, 84, 360, 420]) {
    const raw = env.reset({area,hero:"Candy"}), trained = planningState(raw,policy);
    const browser = prepareRavelPlanning(raw,{policy,decisionMs:50});
    assert.equal(browser.options.horizon,planningHorizon(raw,policy));
    assert.equal(browser.options.inputIntervalTicks,3);
    assert.deepEqual(browser.state.area,trained.area);
    assert.deepEqual(advancePlayer(browser.state.player,"up_right",browser.state.player,browser.state.area),
      advancePlayer(trained.player,"up_right",trained.player,trained.area));
    for (let i=0;i<trained.hazards.length;i++)
      assert.deepEqual(predictHazardPath(browser.state.hazards[i],browser.state.area,30,1/60),
        predictHazardPath(trained.hazards[i],trained.area,30,1/60));
  }
});

test("Ravel browser assist uses native keys, preserves manual control and pauses after Easy respawn", {skip:!available,timeout:30000}, async t => {
  const browser = await chromium.launch({channel:"chrome",headless:true});
  t.after(()=>browser.close());
  const page = await browser.newPage({viewport:{width:1280,height:720}});
  await page.route("**/*",async route=>{
    const url = new URL(route.request().url());
    if (url.origin!=="https://pifary-dev.github.io") return route.abort();
    const relative = decodeURIComponent(url.pathname).replace(/^\/ravel\//,"") || "index.html";
    const file = resolve(source,relative);
    if (!file.startsWith(`${source}/`)) return route.abort();
    const types={".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml"};
    try { await stat(file); await route.fulfill({body:await readFile(file),contentType:types[extname(file)]??"application/octet-stream"}); }
    catch { await route.fulfill({status:404,body:""}); }
  });
  await page.goto("https://pifary-dev.github.io/ravel/");
  const controls = new PageController(page,{installScript:ravelControlScript()});
  t.after(()=>controls.dispose());
  assert.equal((await controls.read()).raw.ready,false);
  await page.selectOption("#hero",{label:"Candy"},{force:true});
  await page.locator("#max_stats").evaluate(el=>{el.checked=true;});
  await page.click("#connect");
  await page.waitForFunction(()=>game.players.length===1);
  // Isolated native-engine setup: roomy entry shelter and no active mouse input.
  await page.evaluate(()=>{
    const p=game.players[0];p.pos=new Vector(5,7);p.previousPos=new Vector(5,7);
    p.dyingPos=new Vector(5,7);mouse=false;
  });
  const initial = await controls.read();
  assert.ok(initial.raw.ready);
  assert.equal(initial.control.enabled,false);
  assert.equal(initial.raw.player.baseSpeed,510);
  assert.ok(initial.raw.physicsAt<=initial.raw.time);
  await page.keyboard.press("p");
  let snapshot = await controls.read();
  assert.equal(snapshot.control.enabled,true);
  await controls.apply(snapshot.control,true,"right",[],snapshot.raw.input.controllerKeys);
  await page.waitForFunction(()=>game.players[0].pos.x>5.5);
  assert.equal(await page.evaluate(()=>Boolean(keys[39])),true,"document-level native key handler received movement");
  // Candy uses the same native X handler and spends actual ability energy/cooldown.
  snapshot = await controls.read();
  await controls.apply(snapshot.control,true,"right",["x"],snapshot.raw.input.controllerKeys);
  await page.waitForFunction(()=>game.players[0].secondAbilityCooldown>0);
  assert.ok((await controls.read()).raw.player.candy.cooldownMs>0);
  await page.keyboard.down("a");
  const manual=await controls.read();
  assert.equal(manual.control.enabled,false);
  assert.equal(await page.evaluate(()=>Boolean(keys[39]||keys[16]||keys[88])),false);
  assert.equal((await controls.apply(snapshot.control,true,"right")).active,false,"stale pre-takeover action is rejected");
  await page.keyboard.up("a");
  await page.keyboard.press("p");
  snapshot=await controls.read();assert.equal(snapshot.control.enabled,true);
  await page.keyboard.press("Escape");
  assert.equal((await controls.read()).control.enabled,false);
  await page.keyboard.press("p");await controls.read();
  const before = await page.evaluate(()=>game.players[0].area);
  await page.keyboard.press("r");
  assert.equal((await controls.read()).control.enabled,false);
  assert.equal(await page.evaluate(()=>game.players[0].area),before+10,"R keeps native teleport behavior");
  await page.keyboard.press("p");await controls.read();
  await page.evaluate(()=>kill(game.players[0]));
  const death=await controls.read();
  assert.equal(death.raw.player.downed,true);
  assert.equal(death.control.enabled,false);
  assert.equal((await controls.read()).raw.player.downed,true,"death remains observable after immediate native respawn");
  await page.keyboard.press("p");
  const retry=await controls.read();
  assert.equal(retry.raw.player.downed,false);
  assert.equal(retry.control.enabled,true);
  await page.evaluate(()=>{settings.tick_delay=1;});
  const unsupported=await controls.read();
  assert.equal(unsupported.raw.ready,false);
  assert.match(unsupported.raw.reason,/Tick Delay 0/);
  assert.equal(unsupported.control.enabled,false);
  assert.equal(await page.evaluate(()=>settings.tick_delay),1,"assistance does not rewrite game settings");
  await page.evaluate(()=>{settings.tick_delay=0;});
  await page.keyboard.press("p");await controls.read();
  const failedCapture = await page.evaluate(()=>{
    const p=game.players[0],a=game.worlds[p.world].areas[p.area],getBoundary=a.getBoundary;
    const before=p.deathCounter;
    a.getBoundary=()=>{throw Error("unavailable geometry");};
    try { kill(p); } finally { a.getBoundary=getBoundary; }
    return p.deathCounter-before;
  });
  assert.equal(failedCapture,1,"an observation failure must not suppress the native death");
  assert.match((await controls.read()).raw.reason,/observation failed/);
  await page.keyboard.press("p");await controls.read();
  const second = new PageController(page,{installScript:ravelControlScript()});
  await assert.rejects(second.read(),/already attached/);
  await second.dispose();
  assert.equal((await controls.read()).control.enabled,true);
  await controls.dispose();
  assert.equal(await page.evaluate(()=>Boolean(keys[37]||keys[38]||keys[39]||keys[40]||keys[16]||keys[88])),false);
  assert.equal(await page.locator("[data-ravel-assist-owner]").count(),0);
  const again = new PageController(page,{installScript:ravelControlScript()});
  assert.equal((await again.read()).control.enabled,false);
  await page.reload();
  const reloaded=await again.read();
  assert.equal(reloaded.control.enabled,false);
  assert.equal(reloaded.raw.ready,false);
  assert.equal(await page.locator("[data-ravel-assist-owner]").count(),1);
  await again.dispose();
});
