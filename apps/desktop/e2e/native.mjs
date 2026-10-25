// Native UI → actual Tauri IPC → Rust registry/SQLite → disposable Ollama HTTP fixture.
// Node stdlib only. Build first with the native-e2e feature and tauri.native.json.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const scratch=await mkdtemp(path.join(tmpdir(),'anchor-native-e2e-'));
const catalog=JSON.parse(await readFile(path.join(root,'crates/anchor-core/profiles/models.json'),'utf8')).slice(0,2);
const models=catalog.map(p=>({name:p.id,model:p.id,digest:'sha256:'+p.id,size:1024**3,modified_at:new Date().toISOString(),details:{family:'llama',parameter_size:'1.2B',quantization_level:'Q8_0'}}));
const requests=[];
let slow=false,offline=false,resident=null;
const server=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  const body=raw?JSON.parse(raw):{};
  requests.push({url:req.url,body});
  const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
  if(offline){res.writeHead(503);return res.end('offline fixture');}
  if(req.url==='/api/version')return json({version:'0.12.0'});
  if(req.url==='/api/tags')return json({models});
  if(req.url==='/api/ps')return json({models:resident?[resident]:[]});
  if(req.url==='/api/show')return json({details:{family:'llama',parameter_size:'1.2B',quantization_level:'Q8_0'},model_info:{'llama.context_length':131072,'llama.block_count':16,'llama.attention.head_count':32,'llama.attention.head_count_kv':8,'llama.embedding_length':2048,'general.architecture':'llama'}});
  if(req.url==='/api/delete'){const index=models.findIndex(m=>m.name===body.model);if(index>=0)models.splice(index,1);return json({});}
  if(req.url==='/api/generate'||req.url==='/api/chat'){
    res.setHeader('content-type','application/x-ndjson');
    const chat=req.url==='/api/chat';
    if(!chat && body.keep_alive===0 && body.prompt===''){resident=null;return json({done:true});}
    resident={name:body.model,digest:models.find(m=>m.name===body.model)?.digest,size:2*1024**3,context_length:body.options?.num_ctx??4096};
    const text='Native fixture answer for '+body.model;
    res.write(JSON.stringify(chat?{message:{role:'assistant',content:text},done:false}:{response:text,done:false})+'\n');
    // Delayed completion is necessary to exercise actual cancellation/navigation.
    await new Promise(r=>setTimeout(r,slow?1500:35));
    if(!res.destroyed)res.end(JSON.stringify({done:true,message:{content:''},response:'',total_duration:1e9,load_duration:1e7,prompt_eval_count:100,prompt_eval_cached_count:90,prompt_eval_duration:1e8,eval_count:body.options?.num_predict??32,eval_duration:5e8})+'\n');
    return;
  }
  res.writeHead(404);res.end(JSON.stringify({error:'unsupported fixture route '+req.url}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const binary=process.env.ANCHOR_E2E_BINARY??path.join(root,'target/debug/anchor-desktop');
const child=spawn(binary,[],{cwd:root,env:{...process.env,OLLAMA_HOST:'http://127.0.0.1:'+port,OLLAMA_MODELS:path.join(scratch,'models'),ANCHOR_E2E_DATA_DIR:scratch,TAURI_WEBDRIVER_PORT:'4445'},stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
const base='http://127.0.0.1:4445';let session;
const request=async(method,route,body)=>{
  const response=await fetch(base+route,{method,headers:{'content-type':'application/json'},body:body==null?undefined:JSON.stringify(body)});
  const result=await response.json();if(!response.ok||result.value?.error)throw new Error(JSON.stringify(result));return result.value;
};
const wait=async(check,message,ms=20000)=>{
  const deadline=Date.now()+ms;while(Date.now()<deadline){try{const value=await check();if(value)return value;}catch{} await new Promise(r=>setTimeout(r,100));}
  throw new Error('Timed out: '+message+'\n'+log.slice(-3000));
};
const execute=script=>request('POST','/session/'+session+'/execute/sync',{script,args:[]});
const visibleText=()=>execute("return Array.from(document.querySelectorAll('main')).filter(e=>e.getClientRects().length).map(e=>e.innerText).join('\\n')");
const click=async(text,selector='button')=>{
  await wait(()=>execute(`const el=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>(e.textContent.trim()===${JSON.stringify(text)} || (${JSON.stringify(selector)}==='[role=\"option\"]' && e.textContent.includes(${JSON.stringify(text)}))) && e.getClientRects().length && !e.disabled);if(!el)return false;el.click();return true;`),'click '+text);
};
const attrClick=async(label)=>wait(()=>execute(`const el=Array.from(document.querySelectorAll('[aria-label]')).find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}&&e.getClientRects().length&&!e.disabled);if(!el)return false;el.click();return true;`),'click '+label);
const fill=async(label,value)=>wait(()=>execute(`const el=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!el)return false;Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;`),'fill '+label);
const nav=async(text)=>{await click(text,'nav[aria-label="Tools"] button');};
let success=false;
try{
  await wait(()=>request('GET','/status'),'native WebDriver startup',45000);
  const created=await request('POST','/session',{capabilities:{alwaysMatch:{browserName:'tauri'}}});session=created.sessionId;
  await wait(()=>execute(`return !!document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify('Inspect '+catalog[0].name))}+']')`),'real installed model sync');
  if(process.env.ANCHOR_MLX_E2E_MODEL) await execute('localStorage.setItem("anchor.mlx-models",'+JSON.stringify(JSON.stringify([process.env.ANCHOR_MLX_E2E_MODEL]))+');return true;');
  await execute(`window.__permissionProbe='pending';window.__TAURI_INTERNALS__.invoke('plugin:fs|read_text_file',{path:${JSON.stringify(path.join(scratch,'registry.db'))}}).then(()=>window.__permissionProbe='ALLOWED',e=>window.__permissionProbe=String(e));return true;`);
  const denied=await wait(()=>execute("return window.__permissionProbe!=='pending' && window.__permissionProbe"),'filesystem permission denial');
  assert.match(denied,/not allowed|forbidden|denied|not permitted/i,'the webview cannot read the app database directly');
  await attrClick('Inspect '+catalog[0].name);
  await wait(()=>execute("return !!document.querySelector('select[aria-label=\"Fit context\"]')"),'inspector mounted');
  await execute("const s=document.querySelector('select[aria-label=\"Fit context\"]');s.value='32768';s.dispatchEvent(new Event('change',{bubbles:true}));return true;");
  await click('Try model');
  await fill('Message','Native E2E prompt');
  await attrClick('Send message');
  await nav('Explore');await nav('Try');
  await wait(async()=> (await visibleText()).includes('Native fixture answer'),'actual Rust chat stream and persistence');
  assert(requests.some(r=>r.url==='/api/chat'&&r.body.options?.num_ctx===32768),'selected fit context reaches Ollama');
  await nav('Explore');await click('Compare','[role="tab"]');
  await attrClick('Model A model');await click(catalog[0].name,'[role="option"]');
  await attrClick('Model B model');await click(catalog[1].name,'[role="option"]');
  await execute("const e=document.querySelector('#comparison-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Native comparison');e.dispatchEvent(new Event('input',{bubbles:true}));return true;");
  slow=true;await click('Run comparison');await nav('Benchmark');
  await click('Stop comparison');await nav('Compare');
  await wait(async()=> /cancel|stopped/i.test(await visibleText()),'actual Rust comparison cancellation');
  slow=false;await click('Run comparison');
  await wait(async()=>{const t=await visibleText();return catalog.every(p=>t.includes('Native fixture answer for '+p.id));},'actual two-model comparison');
  await attrClick('Installed');await attrClick('Inspect '+catalog[1].name);await click('Benchmark','[aria-label="Model inspector"] button');
  await wait(()=>execute(`return document.querySelector('[aria-label=\"Benchmark model\"]')?.textContent.includes(${JSON.stringify(catalog[1].name)})`),'benchmark model handoff');
  slow=true;await click('Run suite');await nav('Explore');await click('Stop benchmark');await nav('Benchmark');
  await wait(()=>execute("return Array.from(document.querySelectorAll('button')).some(e=>e.textContent.trim()==='Run suite'&&e.getClientRects().length)"),'actual benchmark stop');
  slow=false;await click('Run suite');
  await wait(()=>execute("return Array.from(document.querySelectorAll('button')).some(e=>e.textContent.trim()==='Run suite'&&e.getClientRects().length)"),'full nine-scenario Rust suite',60000);
  const counts=execFileSync('sqlite3',[path.join(scratch,'registry.db'),"SELECT (SELECT COUNT(*) FROM conversations),(SELECT COUNT(*) FROM messages),(SELECT COUNT(*) FROM bench_runs WHERE suite_id='anchor-scenarios');"],{encoding:'utf8'}).trim().split('|').map(Number);
  assert.equal(counts[0],1);assert.equal(counts[1],2);assert.equal(counts[2],9);
  const sessions=await execute("return window.__TAURI_INTERNALS__.invoke('bench_sessions',{limit:10});");
  assert(sessions.some(s=>s.outcome==='cancelled'),'cancelled execution retains a session');
  const complete=sessions.find(s=>s.outcome==='completed');assert(complete);
  const consent=await execute(`return window.__TAURI_INTERNALS__.invoke('export_bench_evidence',{id:${JSON.stringify(complete.id)},includeContent:false}).then(()=>false,()=>true);`);
  assert.equal(consent,true,'content export requires explicit consent');
  const raw=await execute(`return window.__TAURI_INTERNALS__.invoke('export_bench_evidence',{id:${JSON.stringify(complete.id)},includeContent:true});`);
  assert.equal(typeof raw,'string','integer counters stay in Rust-serialized JSON');
  const evidence=JSON.parse(raw);assert.equal(evidence.results.length,9);
  assert(evidence.session.config.attempts.some(a=>a.is_warmup));
  assert(evidence.attempts.every(a=>a.events.some(e=>e.kind==='frame')));
  assert(evidence.derived.scenarios.every(s=>s.complete));
  // Calibration is usable from the GUI and shares real cancellation/persistence.
  const beforeCalibration=requests.length;
  slow=true;await click('Validate measurements');
  await wait(()=>requests.slice(beforeCalibration).some(r=>r.url==='/api/generate'&&r.body.prompt),'calibration request dispatch');
  await click('Stop validation');
  await wait(async()=> (await visibleText()).includes('Validation stopped'),'retained calibration cancellation');
  slow=false;await click('Validate measurements');
  await wait(async()=> (await visibleText()).includes('Checks recorded'),'GUI calibration completion',45000);
  assert.match(await visibleText(),/Input counts unverified/,'fixture runtime is never presented as calibrated');
  const calibrated=await execute(`return window.__TAURI_INTERNALS__.invoke('latest_calibration',{model:${JSON.stringify(catalog[1].id)}});`);
  assert.equal(calibrated.outcome,'completed');assert.equal(calibrated.report.engine_counters,'diagnostic');
  assert.equal(calibrated.report.probes.length,7);assert.equal(calibrated.config,undefined);
  const recalled=await execute(`return window.__TAURI_INTERNALS__.invoke('calibration_report',{id:${JSON.stringify(calibrated.session_id)}});`);
  assert.equal(recalled.session_id,calibrated.session_id);
  const rawCalibration=await execute(`return window.__TAURI_INTERNALS__.invoke('export_bench_evidence',{id:${JSON.stringify(calibrated.session_id)},includeContent:true});`);
  assert.equal(JSON.parse(rawCalibration).results.length,0,'calibration creates no ranking rows');
  assert.equal(JSON.parse(rawCalibration).derived.calibration.protocol_version,1);
  await nav('Explore');await nav('Benchmark');
  assert.match(await visibleText(),/Checks recorded/,'calibration survives navigation');
  if(process.env.ANCHOR_MLX_E2E_MODEL) {
    const modelPath=process.env.ANCHOR_MLX_E2E_MODEL;
    await nav('Benchmark');await attrClick('Benchmark runtime');await click('MLX','[role="option"]');
    const cached=await execute('return window.__TAURI_INTERNALS__.invoke("mlx_models",{paths:'+JSON.stringify([modelPath])+'});');
    const model=cached.find(m=>m.path===modelPath);assert(model,'local checkpoint appears in the model picker');
    await attrClick('Benchmark model');await click(model.name.replace(/^.*\//,'').replaceAll('-',' '),'[role="option"]');
    assert(!(await visibleText()).includes('Measure MLX'),'standalone synthetic panel is removed');
    await click('Run suite');
    await wait(()=>execute('return Array.from(document.querySelectorAll("button")).some(e=>e.textContent.trim()==="Run suite"&&e.getClientRects().length)'),'live nine-scenario MLX text suite',180000);
    const nativeSessions=await execute('return window.__TAURI_INTERNALS__.invoke("bench_sessions",{limit:20});');
    const native=nativeSessions.find(s=>s.protocol==='mlx_worker_text_v1'&&s.outcome==='completed');assert(native,await visibleText());
    const nativeSummary=await execute('return window.__TAURI_INTERNALS__.invoke("mlx_suite_report",{id:'+JSON.stringify(native.id)+'});');
    assert.equal(nativeSummary.report.boundaries_validated,true);assert.equal(nativeSummary.report.identity_unchanged,true);
    assert.equal(nativeSummary.report.comparison_eligible,false);assert.equal(nativeSummary.config,undefined);
    const nativeRaw=await execute('return window.__TAURI_INTERNALS__.invoke("export_bench_evidence",{id:'+JSON.stringify(native.id)+',includeContent:true});');
    const nativeExport=JSON.parse(nativeRaw);assert.equal(nativeExport.derived.scenarios.length,9);assert.equal(nativeExport.results.length,0);
    assert.match(nativeExport.session.config.mlx.identity.python,/^3\.11\./,'packaged worker uses the pinned Python minor');
    assert(nativeExport.derived.scenarios.every(s=>s.complete));assert(nativeExport.session.config.attempts.some(a=>a.is_warmup));
    assert(nativeExport.derived.attempts.every(a=>a.counter_status==='diagnostic'&&a.counters.eval_duration_ns==null));
    await writeFile(path.join(scratch,'mlx-suite-evidence.json'),nativeRaw);
    await click('Measurement checks','summary');
    assert.match(await visibleText(),/Timing and allocator checks passed/);
    await nav('Explore');await nav('Benchmark');
    assert.match(await visibleText(),/Timing and allocator checks passed/,'MLX checks survive navigation');
    await click('Run suite');
    await wait(async()=> (await visibleText()).includes('Warming MLX'),'MLX text-suite warmup',90000);
    await click('Stop');
    await wait(()=>execute('return Array.from(document.querySelectorAll("button")).some(e=>e.textContent.trim()==="Run suite"&&e.getClientRects().length)'),'MLX text-suite cancellation',20000);
    const stopped=await execute('return window.__TAURI_INTERNALS__.invoke("bench_sessions",{limit:20});');
    assert(stopped.some(s=>s.protocol==='mlx_worker_text_v1'&&s.outcome==='cancelled'));
    const afterNative=execFileSync('sqlite3',[path.join(scratch,'registry.db'),"SELECT COUNT(*) FROM bench_runs WHERE suite_id='anchor-scenarios';"],{encoding:'utf8'}).trim();
    assert.equal(afterNative,'9','MLX does not alter Ollama ranking rows');
    await attrClick('Benchmark runtime');await click('Ollama','[role="option"]');
    await attrClick('Benchmark model');await click(catalog[1].name,'[role="option"]');
    await wait(async()=> (await visibleText()).includes('Checks recorded'),'recalled Ollama validation');
    assert.match(await visibleText(),/Checks recorded/,'Ollama validation remains separate');
    console.log('Live MLX suite E2E passed: shared GUI → uv → GPU → SQLite → checks/export; Stop and runtime separation.');
  }
  // SQLite queries above verify persisted data beyond the component state.
  await request('DELETE','/session/'+session);session=null;child.kill('SIGTERM');
  success=true;console.log('Native E2E passed: UI → IPC → Rust → HTTP; filesystem permission denial, chat/context, navigation, comparison cancellation/completion, benchmark cancellation/full suite, calibration cancellation/report/export, SQLite persistence.');
}catch(error){await writeFile(path.join(scratch,'state.json'),JSON.stringify({requests,page: session ? await execute(`return {url:location.href,text:document.body.innerText,mains:Array.from(document.querySelectorAll('main')).map(e=>({hidden:e.hidden,attributes:e.outerHTML.slice(0,250),text:e.innerText}))}`).catch(String) : null},null,2));await writeFile(path.join(scratch,'native.log'),log);console.error('Native E2E evidence: '+scratch);throw error;}
finally{
  if(session)await request('DELETE','/session/'+session).catch(()=>{});
  child.kill('SIGTERM');server.closeAllConnections();await new Promise(r=>server.close(r));
  if(success)await rm(scratch,{recursive:true,force:true});
}
