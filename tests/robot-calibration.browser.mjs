// Isolated robot-module interaction fixture. No live HA or device access.
// Run npm run test:browser (install Playwright Chromium, or use Edge on Windows).
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv.includes("--baseline");
const sourcePath = "custom_components/ha3d_lab/frontend/ha3d-robot-trackers.js";
const source = baseline ? execFileSync("git", ["show", `9659b17:${sourcePath}`], { cwd: root, encoding: "utf8" }) : readFileSync(path.join(root, sourcePath), "utf8");
const hash = createHash("sha256").update(source).digest("hex");
const output = path.join(root, "test-results", baseline ? "baseline" : "candidate"); mkdirSync(output, { recursive: true });
const threeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("three"))));
const resources = new Map([
  ["/robots.js", source],
  ["/three/three.module.js", readFileSync(path.join(threeRoot, "build/three.module.js"), "utf8")],
  ["/three/three.core.js", readFileSync(path.join(threeRoot, "build/three.core.js"), "utf8")],
  ["/OrbitControls.js", readFileSync(path.join(threeRoot, "examples/jsm/controls/OrbitControls.js"), "utf8")],
]);
const fixture = `<!doctype html><html><head><meta charset="utf-8"><script type="importmap">{"imports":{"three":"/three/three.module.js"}}</script></head><body style="margin:0;background:#111;color:#eee;font:14px Arial"><script type="module">
import * as THREE from 'three'; import { OrbitControls } from '/OrbitControls.js';
class Panel extends HTMLElement {
  constructor(){ super(); this.attachShadow({mode:'open'}); }
  _renderShell(){ this.shadowRoot.innerHTML='<style>:host{display:block}#root{position:relative;height:100vh;overflow:hidden}#actions{position:absolute;top:12px;right:12px;z-index:50}.glass{background:#222;color:#eee}button{background:#007b9d;color:white;border:0;border-radius:8px;padding:8px;cursor:pointer}button:disabled{opacity:.4}input,select{font:inherit}#status{position:absolute;left:10px;top:10px}</style><div id="root"><div id="actions"></div><div id="status"></div></div>'; }
  _loadModel(){} _loadConfig(){} _updateLightMarkers(){} _persistSelectedTransform(){}
  _setStatus(text){ this.shadowRoot.querySelector('#status').textContent=text; }
  async _saveConfigPatch(patch){ this._config=await this._hass.callApi('POST','ha3d_lab/config',patch); }
}
Panel.HA3D_THREE=THREE; customElements.define('ha3d-lab-panel',Panel); await import('/robots.js');
const app=new Panel(); document.body.append(app); window.app=app; app._renderShell();
app._scene=new THREE.Scene(); app._camera=new THREE.PerspectiveCamera(50,innerWidth/innerHeight,.01,1000); app._camera.position.set(4,12,12);
app._renderer=new THREE.WebGLRenderer({antialias:true}); app._renderer.setSize(innerWidth,innerHeight); app.shadowRoot.querySelector('#root').prepend(app._renderer.domElement);
app._controls=new OrbitControls(app._camera,app._renderer.domElement); app._controls.target.set(3,0,3); app._controls.update();
app._transformControls={detach(){this.object=null},enabled:false,visible:false};
app._model=new THREE.Mesh(new THREE.BoxGeometry(12,.05,12),new THREE.MeshBasicMaterial({color:0x333b43})); app._model.position.set(3,-.025,3); app._scene.add(app._model); app._scene.add(new THREE.AmbientLight(0xffffff,3));
window.bump=(x,y,state='paused',age=0)=>{app._hass.states={'sensor.xiaomi_robot_vacuum_h50_vacuum_position':{state:JSON.stringify({x,y,a:0}),attributes:{friendly_name:'Xiaomi H50 position'},last_updated:new Date(Date.now()-age).toISOString()},'vacuum.xiaomi_us_1213069013_ov43gb':{state,attributes:{friendly_name:'Xiaomi H50'}}};app._updateRobots();};
app._hass={states:{},async callApi(method,url,data){if(method!=='POST'||url!=='ha3d_lab/config')throw Error('Unsupported API');const res=await fetch('/api/ha3d_lab/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const body=await res.json();if(!res.ok)throw body;return body;},async callService(domain,service,data,target){window.serviceIntents.push({domain,service,data,target});}};
app._config=await (await fetch('/seed')).json(); bump(1000,2000); app._rebuildRobots();
app.shadowRoot.querySelector('#robotsButton').click(); window.ready=true;
function frame(){app._updateLightMarkers();app._renderer.render(app._scene,app._camera);requestAnimationFrame(frame)} frame();
</script></body></html>`;
const seed = () => ({ robots: [{ id: "r1", name: "Test robot", vacuum_entity: "vacuum.test", position_entity: "sensor.test_vacuum_position", display: "icon", floor_y: 0.25, smoothing_ms: 0, stale_after_s: 45, remote_pulse_ms: 500, remote_settle_ms: 1000, calibration: {} }] });
let store = seed(); let failNext = false; let delayNext = false; let releaseSave; const intents = []; const blocked = []; const errors = []; const records = [];
const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
await context.addInitScript(() => {
  window.blockedTransports=[];
  window.serviceIntents=[];
  for(const key of ['WebSocket','EventSource','Worker','SharedWorker']) window[key]=class{constructor(){window.blockedTransports.push(key);throw Error('Blocked transport '+key)}};
  navigator.sendBeacon=()=>{window.blockedTransports.push('beacon');return false};
});
await context.route("**/*", async (route) => {
  const request=route.request(); const url=new URL(request.url());
  if(url.origin!=="http://ha3d-fixture.test"){blocked.push(request.url());return route.abort();}
  if(request.method()==="GET"&&url.pathname==="/")return route.fulfill({contentType:"text/html",body:fixture,headers:{"Content-Security-Policy":"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; worker-src 'none'; frame-src 'none'; form-action 'none'"}});
  if(request.method()==="GET"&&resources.has(url.pathname))return route.fulfill({contentType:"text/javascript",body:resources.get(url.pathname)});
  if(request.method()==="GET"&&url.pathname==="/seed")return route.fulfill({json:store});
  if(request.method()==="POST"&&url.pathname==="/api/ha3d_lab/config"){
    const body=request.postDataJSON();intents.push(structuredClone(body));
    if(delayNext){delayNext=false;await new Promise(resolve=>{releaseSave=resolve});}
    if(failNext){failNext=false;return route.fulfill({status:500,json:{error:"simulated_failure"}});}
    store={...store,...structuredClone(body)};return route.fulfill({json:store});
  }
  blocked.push(request.url());return route.abort();
});
const page=await context.newPage(); page.on("pageerror",e=>errors.push(String(e)));
const check=async(id,fn)=>{const started=Date.now();try{await fn();records.push({id,status:"passed",duration_ms:Date.now()-started});}catch(e){records.push({id,status:"failed",error:String(e)});await page.screenshot({path:path.join(output,`${id}.png`)});throw e;}};
const click=async(action)=>page.locator(`[data-action="${action}"]`).click();
const number=async(axis,value)=>page.locator(`[data-cal-number="${axis}"]`).fill(String(value));
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-6,`${actual} != ${expected}`);
const boot=async()=>{await page.goto("http://ha3d-fixture.test");await page.waitForFunction(()=>window.ready);};
try {
  await boot();
  if(baseline){
    await page.locator('[data-action="start-a"]').click();failNext=true;
    await page.locator('[data-action="save-a"]').click();await page.waitForFunction(()=>app.shadowRoot.querySelector('[data-status]').textContent.includes('Erro'));
    const lost=await page.evaluate(()=>!app._robotCalibration&&!app._robotCalibrationMarker);assert.equal(lost,true);
    records.push({id:"baseline.failed_save_discards_point",status:"reproduced",source:hash});
  }else{
    await check("isolation",async()=>{
      const responses=await page.evaluate(async()=>{const result=[];for(const method of ['GET','POST']){try{await fetch('/unmatched-probe',{method});result.push(false)}catch{result.push(true)}}try{new WebSocket('ws://ha3d-fixture.test/probe')}catch{}result.push(navigator.sendBeacon('/probe','x')===false);return result});
      assert.deepEqual(responses,[true,true,true]);assert.equal(blocked.length,2);blocked.length=0;
    });
    await check("sensor_preview_grid_fixed_height",async()=>{
      await click('position');const s=await page.evaluate(()=>({p:app._robotCalibrationMarker.position.toArray(),grid:app._robotCalibrationGrid.visible,height:app._robotCalibrationGrid.position.y}));
      assert.deepEqual(s.p,[1,.25,2]);assert.equal(s.grid,true);near(s.height,.25);assert.equal(await page.locator('[data-cal-number="y"]').isDisabled(),true);
      await page.locator('[data-show-grid]').uncheck();assert.equal(await page.evaluate(()=>app._robotCalibrationGrid.visible),false);await page.locator('[data-show-grid]').check();
    });
    // Correspondence deliberately swaps axes and flips handedness: X=4+y/1000, Z=3+x/1000.
    await check("draft_and_duplicate_guard",async()=>{
      await number('x',6);await number('z',4);await click('confirm');assert.equal(intents.length,0);
      await click('next');assert.match(await page.locator('[data-status]').innerText(),/mesma posição/);assert.equal(await page.evaluate(()=>app._robotCalibration.points.length),1);
    });
    await check("paced_updates_and_menu_preserve_reference",async()=>{
      const original=await page.evaluate(()=>JSON.stringify(app._robotCalibration.current));
      for(let i=0;i<5;i++){
        await new Promise(resolve=>setTimeout(resolve,100));
        await page.evaluate(()=>bump(1000,2000));
        assert.equal(await page.evaluate(()=>JSON.stringify(app._robotCalibration.current)),original);
      }
      await page.locator('#robotsButton').click();await page.locator('#robotsButton').click();
      assert.equal(await page.evaluate(()=>JSON.stringify(app._robotCalibration.current)),original);
      assert.match(await page.locator('[data-status]').innerText(),/mesma posição/);
    });
    await check("height_calibrated_once_for_all_points",async()=>{
      await page.locator('[data-robot-settings] summary').click();
      await page.locator('[data-field="floor_y"]').fill('0.6');
      let p=await page.evaluate(()=>({marker:app._robotCalibrationMarker.position.y,grid:app._robotCalibrationGrid.position.y}));near(p.marker,.6);near(p.grid,.6);
      await page.locator('[data-field="floor_y"]').fill('0.25');await page.locator('[data-robot-settings] summary').click();
    });
    await check("progressive_points_and_save",async()=>{
      await page.evaluate(()=>bump(2000,2000));await click('next');await number('x',6);await number('z',5);await click('confirm');
      await click('apply');assert.equal(intents.length,0);assert.match(await page.locator('[data-status]').innerText(),/triângulo/);
      await page.evaluate(()=>bump(1000,3000));await click('next');await number('x',7);await number('z',4);await click('confirm');
      await click('apply');await page.waitForFunction(()=>!app._robotCalibration);assert.equal(store.robots[0].calibration.points.length,3);assert.equal(intents.length,1);
      assert.equal(await page.evaluate(()=>app._robotCalibrationGrid===null),true);
    });
    await check("live_fit_height_and_old_position",async()=>{
      await page.evaluate(()=>{bump(1500,2500);app._updateRobots(true)});let s=await page.evaluate(()=>{const e=app._robotEntries.get('r1');return{p:e.icon.position.toArray(),visible:e.icon.visible}});
      near(s.p[0],6.5);near(s.p[1],.25);near(s.p[2],4.5);assert.equal(s.visible,true);
      await page.evaluate(()=>{bump(-2000,9999,'paused',120000);app._updateRobots(true)});s=await page.evaluate(()=>{const e=app._robotEntries.get('r1');return{p:e.icon.position.toArray(),visible:e.icon.visible}});near(s.p[1],.25);assert.equal(s.visible,true);assert.match(await page.locator('[data-live]').innerText(),/antiga/);
    });
    await check("reload_and_add_daily_point",async()=>{
      await boot();assert.match(await page.locator('.ha3dRobotMeta').first().innerText(),/3 pontos salvos/);
      await page.evaluate(()=>bump(2000,3000));await click('position');await number('x',7);await number('z',5);await click('confirm');await click('apply');await page.waitForFunction(()=>!app._robotCalibration);assert.equal(store.robots[0].calibration.points.length,4);
    });
    await check("edit_offline_cancel_preserves_store",async()=>{
      const before=JSON.stringify(store);await page.evaluate(()=>{app._hass.states['sensor.xiaomi_robot_vacuum_h50_vacuum_position'].state='unavailable'});await click('position');await page.locator('[data-edit-point="0"]').click();await number('x',5.8);await click('confirm');await click('cancel');assert.equal(JSON.stringify(store),before);assert.equal(await page.evaluate(()=>app._robotCalibrationMarker===null&&app._robotCalibrationGrid===null),true);
    });
    await check("failed_save_retains_draft_then_retry",async()=>{
      await click('position');await page.locator('[data-edit-point="0"]').click();await number('x',6.1);failNext=true;const before=JSON.stringify(store);await click('save');
      await page.waitForFunction(()=>app.shadowRoot.querySelector('[data-status]').textContent.includes('simulated_failure'));
      assert.equal(JSON.stringify(store),before);assert.equal(await page.evaluate(()=>Boolean(app._robotCalibrationMarker)),true);assert.equal(await page.locator('[data-cal-number="x"]').inputValue(),'6.1');
      await click('apply');await page.waitForFunction(()=>!app._robotCalibration);near(store.robots[0].calibration.points[0].model[0],6.1);
    });
    await check("slow_save_single_intent",async()=>{
      await click('position');await page.locator('[data-edit-point="0"]').click();await number('x',6);delayNext=true;const count=intents.length;await click('apply');
      await page.waitForFunction(()=>app._robotSaving);assert.equal(await page.locator('[data-action="save"]').isDisabled(),true);
      assert.equal(intents.length,count+1);releaseSave();await page.waitForFunction(()=>!app._robotCalibration);assert.equal(intents.length,count+1);
    });
    await check("remove_reference_reopen",async()=>{
      await click('position');await page.locator('[data-remove-point="3"]').click();assert.equal(store.robots[0].calibration.points.length,4);await click('apply');await page.waitForFunction(()=>!app._robotCalibration);assert.equal(store.robots[0].calibration.points.length,3);await boot();assert.match(await page.locator('.ha3dRobotMeta').first().innerText(),/3 pontos salvos/);
    });
    await check("phone_controls_and_slider",async()=>{
      await page.setViewportSize({width:390,height:844});await page.evaluate(()=>bump(2500,3500));await click('position');
      const slider=page.locator('[data-cal-axis="x"]');await slider.scrollIntoViewIfNeeded();const box=await slider.boundingBox();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.5,{steps:5});await page.mouse.up();
      const marker=await page.evaluate(()=>app._robotCalibrationMarker.position.x);assert.notEqual(marker,7.5);
      const rect=await page.locator('#ha3dRobots').boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=390);
      await page.screenshot({path:path.join(output,'phone.png')});await click('cancel');
    });
    await check("h50_remote_control_pulse_releases_and_exits",async()=>{
      await page.evaluate(()=>{window.serviceIntents.length=0;bump(2500,3500)});
      await click('position');await click('confirm');
      await page.locator('[data-remote-pulse="forward"]').click();
      await page.waitForFunction(()=>!app._robotRemoteBusy);
      const calls=await page.evaluate(()=>window.serviceIntents.map((item)=>[item.domain,item.service,item.data?.message,item.target?.entity_id]));
      assert.deepEqual(calls,[
        ["button","press",undefined,"button.xiaomi_us_1213069013_ov43gb_enter_remote_a_2_28"],
        ["notify","send_message","1","notify.xiaomi_us_1213069013_ov43gb_remote_control_a_2_26"],
        ["notify","send_message","2","notify.xiaomi_us_1213069013_ov43gb_remote_control_a_2_26"],
        ["button","press",undefined,"button.xiaomi_us_1213069013_ov43gb_exit_remote_a_2_29"],
      ]);
      await click('cancel');
    });
    await check("alternate_floor_plane_fixed_height",async()=>{
      await page.locator('[data-robot-settings] summary').click();await page.locator('[data-field="floor_plane"]').selectOption('xy');await click('position');const s=await page.evaluate(()=>({p:app._robotCalibrationMarker.position.toArray(),z:app._robotCalibrationGrid.position.z}));near(s.p[2],.25);near(s.z,.25);assert.equal(await page.locator('[data-cal-number="z"]').isDisabled(),true);await click('cancel');
    });
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  }
}finally{
  writeFileSync(path.join(output,'results.json'),JSON.stringify({source:hash,mode:baseline?'baseline':'candidate',scope:'Robot module + actual Three.js and OrbitControls; mocked HA store/base panel; not full live HA',records,mock_mutation_intents:intents.length,blocked_unexpected:blocked,errors},null,2));
  await browser.close();
}
console.log(JSON.stringify({mode:baseline?'baseline':'candidate',records,mock_mutation_intents:intents.length},null,2));
