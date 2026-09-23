// Full entrypoint, actual Three.js/GLTFLoader and synthetic GLB. No live HA.
import { chromium } from 'playwright';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.(); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then(value => { this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`; this.onloadend?.(); }); }
};
const root = resolve(import.meta.dirname, '..');
const frontend = resolve(root, 'custom_components/ha3d_lab/frontend');
const threeRoot = resolve(dirname(fileURLToPath(import.meta.resolve('three'))), '..');
const output = resolve(root, 'test-results/workspace'); mkdirSync(output, { recursive: true });
const sources = {}; const resources = new Map();
for (const file of readdirSync(frontend).filter(f => f.endsWith('.js'))) {
  const bytes = readFileSync(resolve(frontend, file), 'utf8');
  sources[file] = createHash('sha256').update(bytes).digest('hex');
  resources.set(`/frontend/${file}`, bytes.replaceAll('https://esm.sh/three@0.180.0/examples/', '/vendor/examples/').replaceAll('https://esm.sh/three@0.180.0', '/vendor/build/three.module.js'));
}
const scene = new THREE.Scene();
for (const [name, x] of [['light.test', -2], ['Chair', 2], ['Table', 0]]) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#8bc8bc' }));
  mesh.name = name; mesh.position.set(x, .5, 0); scene.add(mesh);
}
const light = new THREE.PointLight(0xffffff, 2); light.name = 'LightNode_light.test'; light.position.set(-2, 2, 0); scene.add(light);
const glb = Buffer.from(await new GLTFExporter().parseAsync(scene, { binary: true }));
const fixture = `<!doctype html><html><head><meta charset="utf-8"><script type="importmap">{"imports":{"three":"/vendor/build/three.module.js"}}</script></head><body style="margin:0"><script type="module">
await import('/frontend/ha3d-entry.js');
window.app = document.createElement('ha3d-lab-panel');
window.services=[]; window.requests=[];
const request=async(method,path,data)=>{requests.push({method,path,data});const r=await fetch('/api/'+path,{method,headers:{'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});if(!r.ok)throw Error('fixture HTTP '+r.status);return r.json()};
window.hass={user:{is_admin:true},language:'en',locale:{language:'en'},states:{'light.test':{entity_id:'light.test',state:'on',attributes:{friendly_name:'Test light',brightness:128,rgb_color:[255,0,0]}}},callApi:request,fetchWithAuth:(url,opts)=>fetch(url,opts),callService:async(...args)=>services.push(args)};
app.hass=hass;document.body.append(app); window.ready=true;
</script></body></html>`;
const seed = () => ({model_url:'/local/ha3d_lab/models/model.glb',model_revision:1,auto_bind:true,bindings:{},object_positions:{},area_bindings:{},advanced_bindings:{},robots:[],scene_assets:[],virtual_lights:[],floating_widgets:[],entity_aliases:{},marker_proximity:{}});
const browser = await chromium.launch({ headless:true, ...(process.platform === 'win32' ? {channel:'msedge'} : {}) });
const results=[];
for (const profile of [{name:'desktop',width:1440,height:900},{name:'phone',width:390,height:844}]) {
  let store=seed();const blocked=[],errors=[],consoleErrors=[],intents=[];
  const context=await browser.newContext({viewport:{width:profile.width,height:profile.height},serviceWorkers:'block'});
  await context.addInitScript(()=>{
    window.blockedTransports=[];
    for(const key of ['WebSocket','EventSource','Worker','SharedWorker'])window[key]=class{constructor(){blockedTransports.push(key);throw Error('blocked '+key)}};
    navigator.sendBeacon=()=>{blockedTransports.push('beacon');return false};
  });
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!=='http://lab-fixture.test'){blocked.push(req.url());return route.abort();}
    if(req.method()==='GET') {
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:fixture,headers:{'Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; worker-src 'none'; frame-src 'none'; form-action 'none'"}});
      if(resources.has(url.pathname))return route.fulfill({contentType:'text/javascript',body:resources.get(url.pathname)});
      if(url.pathname.startsWith('/vendor/')) {
        const path=resolve(threeRoot,url.pathname.slice('/vendor/'.length));
        if(path.startsWith(threeRoot+'\\')||path.startsWith(threeRoot+'/'))try{return route.fulfill({contentType:'text/javascript',body:readFileSync(path)})}catch{}
      }
      if(url.pathname==='/local/ha3d_lab/models/model.glb')return route.fulfill({contentType:'model/gltf-binary',body:glb});
      if(url.pathname==='/api/ha3d_lab/config')return route.fulfill({json:store});
      if(url.pathname==='/api/ha3d_lab/areas')return route.fulfill({json:{areas:[]}});
    }
    if(req.method()==='POST'&&url.pathname==='/api/ha3d_lab/config'){
      intents.push(req.postDataJSON());store={...store,...req.postDataJSON()};return route.fulfill({json:store});
    }
    blocked.push(req.url());return route.abort();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
  const records=[];
  const check=async(id,fn)=>{try{await fn();records.push({id,status:'passed'})}catch(error){records.push({id,status:'failed',error:String(error)});await page.screenshot({path:resolve(output,`${profile.name}-${id}.png`)});throw error}};
  try {
    await page.goto('http://lab-fixture.test');
    await page.waitForFunction(()=>window.app?._model&&app.shadowRoot.querySelector('#labModes'),null,{timeout:15000});
    await check('isolation',async()=>{
      const p=await page.evaluate(async()=>{const answers=[];for(const method of ['GET','POST'])try{await fetch('/forbidden',{method});answers.push(false)}catch{answers.push(true)};try{new WebSocket('ws://lab-fixture.test')}catch{}answers.push(navigator.sendBeacon('/probe','x')===false);return answers});
      assert.deepEqual(p,[true,true,true]);assert.equal(blocked.length,2);blocked.length=0;consoleErrors.length=0;
    });
    await check('glb_light_marker',async()=>{
      const r=await page.evaluate(()=>({children:app._model.children.length,markers:app._lightBindings.size,light:app._lightBindings.get('light.test')?.lights?.[0]?.color.toArray(),mode:app._labMode}));
      assert.ok(r.children>=4);assert.ok(r.markers>=1);assert.deepEqual(r.light,[1,0,0]);assert.equal(r.mode,'live');
    });
    await check('edit_and_numeric_transform',async()=>{
      await page.locator('[data-mode=edit]').click();
      // Setup selection; subsequent editing uses real controls.
      await page.evaluate(()=>app._selectForEditor(app._model.getObjectByName('Chair')));
      await page.locator('#ha3dCollapseEditor').click();
      await page.locator('[data-ha3d-transform=px]').fill('3');await page.locator('#ha3dApplyPreciseTransform').click();
      await page.waitForFunction(()=>app._config.object_positions.Chair?.position[0]===3);
      assert.equal(store.object_positions.Chair.position[0],3);assert.equal(intents.length,1);
    });
    await check('mode_navigation',async()=>{
      for(const mode of ['build','buy','views','system','live']){
        await page.locator(`[data-mode=${mode}]`).click();assert.equal(await page.evaluate(()=>app._labMode),mode);
        assert.equal(await page.locator(`[data-mode=${mode}]`).getAttribute('aria-pressed'),'true');
        if(mode==='build')assert.equal(await page.locator('#labBuild').isVisible(),true);
        if(mode==='buy')assert.equal(await page.locator('#ha3dSceneAssetToolbar').isVisible(),true);
        if(mode==='views')assert.equal(await page.locator('#cameraLensControl').isVisible(),true);
        if(mode==='system')assert.equal(await page.locator('#graphicsSection').isVisible(),true);
      }
      assert.equal(await page.evaluate(()=>Boolean(app._editorMode)),false);
      assert.equal(await page.locator('#ha3dEditor').isVisible(),false);
    });
    await check('navigation_geometry',async()=>{
      for(const mode of ['live','edit','build','buy','views','system']){
        const box=await page.locator(`[data-mode=${mode}]`).boundingBox();assert.ok(box.x>=0&&box.x+box.width<=profile.width&&box.height>=44);
      }
      await page.screenshot({path:resolve(output,`${profile.name}.png`)});
    });
    await check('paced_states_preserve_mode_and_editor',async()=>{
      await page.locator('[data-mode=edit]').click();
      for(let i=0;i<3;i++){
        await page.evaluate(()=>{hass={...hass,states:{...hass.states,'sensor.unrelated':{state:'1',attributes:{}}}};app.hass=hass});
        await new Promise(r=>setTimeout(r,100));assert.equal(await page.evaluate(()=>app._labMode),'edit');
      }
    });
    await check('non_admin_restriction',async()=>{
      await page.locator('[data-mode=live]').click();await page.evaluate(()=>{hass={...hass,user:{is_admin:false}};app.hass=hass});
      await page.locator('[data-mode=edit]').click();assert.equal(await page.evaluate(()=>app._labMode),'live');
      await page.locator('[data-mode=views]').click();assert.equal(await page.evaluate(()=>app._labMode),'views');
    });
    await check('no_runtime_errors_or_network_escape',async()=>{assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.deepEqual(consoleErrors,[])});
  } catch(error){console.error(profile.name,error.message, await page.evaluate(()=>({ready:window.ready,model:Boolean(window.app?._model),config:window.app?._config,status:window.app?.shadowRoot?.querySelector('#status')?.textContent,requests:window.requests,modes:Boolean(window.app?.shadowRoot?.querySelector('#labModes'))})).catch(()=>({})));} finally {
    results.push({profile:profile.name,records,errors,consoleErrors,blocked,mock_mutation_intents:intents.length});await context.close();
  }
}
await browser.close();
writeFileSync(resolve(output,'results.json'),JSON.stringify({scope:'Full Lab frontend + synthetic GLB and mock APIs; no live HA or native mobile testing',sources,results},null,2));
console.log(JSON.stringify(results,null,2));
if(results.some(r=>r.records.some(c=>c.status==='failed')||r.errors.length||r.blocked.length||!r.records.length))process.exitCode=1;
