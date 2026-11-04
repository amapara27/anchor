// Native UI → actual Tauri IPC → Rust registry/SQLite → disposable Ollama HTTP fixture.
// Node stdlib only. Build first with the native-e2e feature and tauri.native.json.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,readdir,realpath,stat,writeFile,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const scratch=await mkdtemp(path.join(tmpdir(),'anchor-native-e2e-'));
const freshMlx=process.env.ANCHOR_MLX_DOWNLOAD_E2E==='1';
const hubCache=path.join(await realpath(scratch),'hf','hub');
const downloadEvidence={startedAt:new Date().toISOString(),progress:[]};
let modelPath=freshMlx?null:process.env.ANCHOR_MLX_E2E_MODEL;
if(freshMlx){await mkdir(hubCache,{recursive:true});assert.deepEqual(await readdir(hubCache),[]);}
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
  if(req.url==='/api/pull'){
    res.setHeader('content-type','application/x-ndjson');res.write(JSON.stringify({status:'downloading',total:100,completed:10})+'\n');
    await new Promise(r=>setTimeout(r,1000));
    if(!res.destroyed){models.push({...models[0],name:body.name,model:body.name});res.end(JSON.stringify({status:'success'})+'\n');}return;
  }
  if(req.url==='/api/delete'){const index=models.findIndex(m=>m.name===body.name);if(index>=0)models.splice(index,1);return json({});}
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
let log='',step='startup';
const launch=()=>{
  const app=spawn(binary,[],{cwd:root,env:{...process.env,...(freshMlx?{HF_HOME:path.dirname(hubCache),HF_HUB_CACHE:hubCache,HF_XET_CACHE:path.join(scratch,'xet')}:{}),OLLAMA_HOST:'http://127.0.0.1:'+port,OLLAMA_MODELS:path.join(scratch,'models'),ANCHOR_E2E_DATA_DIR:scratch,TAURI_WEBDRIVER_PORT:'4445'},stdio:['ignore','pipe','pipe']});
  app.stdout.on('data',d=>log+=d);app.stderr.on('data',d=>log+=d);app.on('error',e=>log+=e.message);return app;
};
let child=launch();
const checkpoint=name=>{step=name;console.log('STEP native.'+name);};
const base='http://127.0.0.1:4445';let session;
const request=async(method,route,body)=>{
  const response=await fetch(base+route,{method,headers:{'content-type':'application/json'},body:body==null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const result=await response.json();if(!response.ok||result.value?.error)throw new Error(JSON.stringify(result));return result.value;
};
const wait=async(check,message,ms=20000)=>{
  let lastError;const deadline=Date.now()+ms;while(Date.now()<deadline){try{const value=await check();if(value)return value;}catch(e){lastError=e;} await new Promise(r=>setTimeout(r,100));}
  throw new Error('Timed out: '+message+'\n'+(lastError?.stack??'')+'\n'+log.slice(-3000));
};
const execute=script=>request('POST','/session/'+session+'/execute/sync',{script,args:[]});
const visibleText=()=>execute("return Array.from(document.querySelectorAll('main')).filter(e=>e.getClientRects().length).map(e=>e.innerText).join('\\n')");
const click=async(text,selector='button')=>{
  await wait(()=>execute(`const el=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>(e.textContent.trim()===${JSON.stringify(text)} || (${JSON.stringify(selector)}==='[role=\"option\"]' && e.textContent.includes(${JSON.stringify(text)}))) && e.getClientRects().length && !e.disabled);if(!el)return false;el.click();return true;`),'click '+text);
};
const attrClick=async(label)=>wait(()=>execute(`const el=Array.from(document.querySelectorAll('[aria-label]')).find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}&&e.getClientRects().length&&!e.disabled);if(!el)return false;el.click();return true;`),'click '+label);
const fill=async(label,value)=>wait(()=>execute(`const el=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!el)return false;Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;`),'fill '+label);
const nav=async(text)=>{await click(text,'nav[aria-label="Tools"] button');};
const cliCommands=[];
const cli=async(args,code=0,during=null)=>{
  const command=spawn(path.join(root,'target/debug/anchor'),args,{cwd:root,env:{...process.env,OLLAMA_HOST:'http://127.0.0.1:'+port,OLLAMA_MODELS:path.join(scratch,'models'),ANCHOR_E2E_DATA_DIR:scratch},stdio:['ignore','pipe','pipe']});
  let out='',err='',concurrent=null;command.stdout.on('data',b=>out+=b);command.stderr.on('data',b=>{err+=b;if(during&&!concurrent&&err.includes('Runtime ')){concurrent=during();concurrent.catch(()=>command.kill('SIGTERM'));}});
  const timer=setTimeout(()=>command.kill('SIGKILL'),30000);
  const result=await new Promise((resolve,reject)=>{command.once('error',reject);command.once('close',resolve);}).finally(()=>clearTimeout(timer));
  cliCommands.push({args,code:result,stdout:out,stderr:err});
  if(during){assert(concurrent,'CLI must acquire the work lock');await concurrent;}
  assert.equal(result,code,args.join(' ')+'\n'+err);return out?JSON.parse(out):null;
};
let success=false;
try{
  checkpoint('startup-permissions-and-catalog');
  await wait(()=>request('GET','/status'),'native WebDriver startup',45000);
  const created=await request('POST','/session',{capabilities:{alwaysMatch:{browserName:'tauri'}}});session=created.sessionId;
  // Cold WKWebView startup has its own budget; normal controls retain the 20s bound.
  await wait(()=>execute(`return !!document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify('Inspect '+catalog[0].name))}+']')`),'real installed model sync',45000);
  const mlxCatalog=await execute('return window.__TAURI_INTERNALS__.invoke("mlx_catalog");');
  const expectedMlx=JSON.parse(await readFile(path.join(root,'workers/mlx/models.json'),'utf8'));
  assert.deepEqual(mlxCatalog.map(m=>m.id),expectedMlx.map(m=>m.id));assert(mlxCatalog.every(m=>m.revision.length===40&&m.files.length>0));
  const rejected=await execute('return window.__TAURI_INTERNALS__.invoke("download_mlx_model",{id:"unlisted/model",onEvent:"__CHANNEL__:123456"}).then(()=>"ALLOWED",e=>String(e));');
  assert.match(rejected,/Choose a supported MLX model/);
  await execute('return window.__TAURI_INTERNALS__.invoke("cancel_mlx_download");');
  if(freshMlx) await execute('localStorage.removeItem("anchor.mlx-models");return true;');
  if(modelPath) await execute('localStorage.setItem("anchor.mlx-models",'+JSON.stringify(JSON.stringify([modelPath]))+');return true;');
  await execute(`window.__permissionProbe='pending';window.__TAURI_INTERNALS__.invoke('plugin:fs|read_text_file',{path:${JSON.stringify(path.join(scratch,'registry.db'))}}).then(()=>window.__permissionProbe='ALLOWED',e=>window.__permissionProbe=String(e));return true;`);
  const denied=await wait(()=>execute("return window.__permissionProbe!=='pending' && window.__permissionProbe"),'filesystem permission denial');
  assert.match(denied,/not allowed|forbidden|denied|not permitted/i,'the webview cannot read the app database directly');
  checkpoint('chat-context-and-navigation');
  await attrClick('Inspect '+catalog[0].name);
  await wait(()=>execute("return !!document.querySelector('select[aria-label=\"Fit context\"]')"),'inspector mounted');
  await execute("const s=document.querySelector('select[aria-label=\"Fit context\"]');s.value='32768';s.dispatchEvent(new Event('change',{bubbles:true}));return true;");
  await click('Try model');
  await fill('Message','Native E2E prompt');
  await attrClick('Send message');
  await nav('Explore');await nav('Try');
  await wait(async()=> (await visibleText()).includes('Native fixture answer'),'actual Rust chat stream and persistence');
  assert(requests.some(r=>r.url==='/api/chat'&&r.body.options?.num_ctx===32768),'selected fit context reaches Ollama');
  const beforeRegenerate=requests.filter(r=>r.url==='/api/chat').length;
  await click('Regenerate');
  await wait(()=>requests.filter(r=>r.url==='/api/chat').length>beforeRegenerate,'regenerate dispatch');
  await wait(()=>execute('return window.__TAURI_INTERNALS__.invoke("list_conversations").then(async c=>(await window.__TAURI_INTERNALS__.invoke("conversation_messages",{id:c[0].id})).length===2);'),'regenerated turn replaces its predecessor');
  checkpoint('comparison-cancellation-and-completion');
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
  checkpoint('benchmark-stop-complete-and-sqlite');
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
  assert.equal(complete.recorded_attempts,complete.planned_attempts,'completed suite attempts remain persisted');
  const visible=await visibleText();assert(!visible.includes('Export JSON')&&!visible.includes('Include prompts and output in exports'));
  checkpoint('cli-gui-shared-workflows');
  const shared=await cli(['chat','ls','--json']);assert.equal(shared.length,1);
  const guiMessages=await execute('return window.__TAURI_INTERNALS__.invoke("conversation_messages",{id:'+JSON.stringify(shared[0].id)+'});');
  assert.deepEqual(await cli(['chat','show',shared[0].id,'--json']),guiMessages);
  await cli(['settings','presets','save','interop','--name','CLI shared preset','--system','Shared system prompt','--num-ctx','16384','--json']);
  assert((await execute('return window.__TAURI_INTERNALS__.invoke("list_presets");')).some(p=>p.id==='interop'&&p.num_ctx===16384));
  await cli(['chat','--conversation',shared[0].id,'--preset','interop','CLI continuation','--json']);
  const continued=await execute('return window.__TAURI_INTERNALS__.invoke("conversation_messages",{id:'+JSON.stringify(shared[0].id)+'});');
  assert.equal(continued.length,4);assert.equal(continued[2].content,'CLI continuation');
  const cliRuns=await cli(['bench','run',catalog[0].id,'--scenario','classify','--repeats','fast','--json']);
  assert.equal(cliRuns.length,1);
  const allSessions=await execute('return window.__TAURI_INTERNALS__.invoke("bench_sessions",{limit:20});');
  const exported=await cli(['bench','export',cliRuns[0].id,'--include-content']);
  assert(allSessions.some(s=>s.id===exported.session.id));
  slow=true;
  const requestCount=requests.length;
  await execute('window.__interopRun=window.__TAURI_INTERNALS__.invoke("run_benchmark",{model:'+JSON.stringify(catalog[0].id)+',repeats:"fast",scenario:"classify",onEvent:"__CHANNEL__:98765"}).then(()=>"done",e=>String(e));return true;');
  await wait(()=>requests.slice(requestCount).some(r=>r.url==='/api/generate'&&r.body.prompt),'GUI owns inference lock');
  await cli(['bench','run',catalog[0].id,'--scenario','classify','--json'],1);
  await cli(['models','unload',catalog[0].id,'--json'],1);
  await cli(['chat','ls','--json']);
  await execute('return window.__TAURI_INTERNALS__.invoke("stop_benchmark");');
  await execute('return window.__interopRun;');
  await cli(['bench','run',catalog[0].id,'--scenario','classify','--repeats','fast','--json'],0,async()=>{
    const refused=await execute('return window.__TAURI_INTERNALS__.invoke("run_benchmark",{model:'+JSON.stringify(catalog[0].id)+',repeats:"fast",scenario:"classify",onEvent:"__CHANNEL__:98765"}).then(()=>"ALLOWED",e=>String(e));');
    assert.match(refused,/busy in another Anchor operation/);
  });slow=false;
  // Calibration is usable from the GUI and shares real cancellation/persistence.
  checkpoint('measurement-validation');
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
  assert.equal(calibrated.report.probes.length,10);assert.equal(calibrated.config,undefined);
  const recalled=await execute(`return window.__TAURI_INTERNALS__.invoke('calibration_report',{id:${JSON.stringify(calibrated.session_id)}});`);
  assert.equal(recalled.session_id,calibrated.session_id);
  assert.equal(calibrated.report.probes.length,10,'calibration evidence remains inspectable in-app');
  await nav('Explore');await nav('Benchmark');
  assert.match(await visibleText(),/Checks recorded/,'calibration survives navigation');
  checkpoint('download-cancel-retry-and-remove');
  const extra=JSON.parse(await readFile(path.join(root,'crates/anchor-core/profiles/models.json'),'utf8'))[2];
  await attrClick('Benchmark model');await click(extra.name,'[role="option"]');await click('Download model');
  await nav('Explore');await click('Cancel download');await nav('Benchmark');
  await click('Download model');
  await wait(()=>execute(`return window.__TAURI_INTERNALS__.invoke('list_models').then(m=>m.some(x=>x.id===${JSON.stringify(extra.id)}));`),'native download completion');
  await nav('Explore');await attrClick('Installed');await attrClick('Inspect '+extra.name);await attrClick('Remove model');
  await click('Cancel','[role="alertdialog"] button');assert(models.some(m=>m.name===extra.id),'dismissed confirmation preserves the model');
  await attrClick('Remove model');await click('Remove','[role="alertdialog"] button');
  await wait(()=>!models.some(m=>m.name===extra.id),'native confirmed removal');
  checkpoint('storage-and-presets');
  const store=path.join(scratch,'models');await mkdir(path.join(store,'blobs'),{recursive:true});await mkdir(path.join(store,'manifests'),{recursive:true});
  const digest='a'.repeat(64),blob=path.join(store,'blobs','sha256-'+digest);await writeFile(blob,'orphan');
  const scan=await execute('return window.__TAURI_INTERNALS__.invoke("scan_storage");');assert.equal(scan.orphaned_bytes,6);
  const forged={...scan,root:'/forged',orphaned_blobs:[{digest:'sha256:../../outside',size_bytes:999}]};
  assert.equal(await execute('return window.__TAURI_INTERNALS__.invoke("clean_orphaned_blobs",{scan:'+JSON.stringify(forged)+'});'),0);
  await nav('Storage');
  await wait(()=>execute('const b=Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("Clean up · frees"));if(!b)return false;b.click();return true;'),'native storage confirmation');
  await click('Cancel','[role="alertdialog"] button');assert.equal(await readFile(blob,'utf8'),'orphan');
  await execute('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("Clean up · frees")).click();return true;');
  await click('Clean up','[role="alertdialog"] button');await wait(async()=>!(await stat(blob).catch(()=>null)),'native orphan removal');
  const preset={id:'e2e-preset',name:'E2E preserved preset',system:'Keep answers brief.',temperature:0.2,top_p:0.8,num_ctx:8192,model:null,created_ms:1};
  await execute('return window.__TAURI_INTERNALS__.invoke("save_preset",{preset:'+JSON.stringify(preset)+'});');
  assert((await execute('return window.__TAURI_INTERNALS__.invoke("list_presets");')).some(p=>p.id===preset.id));
  await nav('Benchmark');await attrClick('Benchmark model');await click(catalog[1].name,'[role="option"]');
  if(freshMlx){
    checkpoint('fresh-mlx-download');
    const model=mlxCatalog.find(m=>m.ollama_id==='gemma3:270m');assert(model);
    assert(mlxCatalog.every(m=>m.path===null),'the app must see an empty model cache');
    Object.assign(downloadEvidence,{model:model.id,revision:model.revision,emptyCache:true});
    const modelCache=path.join(hubCache,'models--'+model.id.replaceAll('/','--'));
    const snapshot=path.join(modelCache,'snapshots',model.revision);
    const weights=model.files.find(f=>f.name==='model.safetensors');assert(weights);
    let partial;
    await attrClick('Benchmark runtime');await click('MLX','[role="option"]');
    await attrClick('Benchmark model');await click(model.name,'[role="option"]');
    await click('Download model');
    await wait(async()=>{
      const p=await execute('const e=document.querySelector("[aria-label=\\"MLX download\\"]");const b=e?.querySelector("[role=progressbar]");return e&&{status:e.innerText,completed:Number(b.getAttribute("aria-valuenow")),total:Number(b.getAttribute("aria-valuemax"))};');
      if(p&&downloadEvidence.progress.at(-1)?.status!==p.status){downloadEvidence.progress.push(p);console.log('MLX download: '+p.status.replaceAll('\n',' '));}
      const blobs=path.join(modelCache,'blobs');
      const name=(await readdir(blobs).catch(()=>[])).find(n=>n.startsWith(weights.sha256+'.')&&n.endsWith('.incomplete'));
      partial=name?path.join(blobs,name):null;
      const bytes=partial?(await stat(partial).catch(()=>null))?.size??0:0;
      if(bytes>0&&bytes<weights.bytes){downloadEvidence.bytesBeforeCancel=bytes;return true;}
    },'fresh weight bytes received before cancellation',300000);
    await nav('Explore');await click('Cancel MLX download');await nav('Benchmark');
    await wait(async()=> (await visibleText()).includes('Download cancelled. Retry to reuse cached files.'),'download cancelled in native app');
    const interrupted=await execute('return window.__TAURI_INTERNALS__.invoke("mlx_catalog");');
    assert.equal(interrupted.find(m=>m.id===model.id).path,null,'partial downloads cannot be ready');
    downloadEvidence.bytesAfterCancel=(await stat(partial)).size;
    assert(downloadEvidence.bytesAfterCancel>0&&downloadEvidence.bytesAfterCancel<weights.bytes,'cancel retains a partial transfer');
    const metadata=await stat(path.join(snapshot,'config.json'));
    await click('Download model');
    await wait(async()=>{
      const text=await visibleText();
      assert(!text.includes('Download could not finish'),text);
      return text.includes('Model ready. Run the suite when you’re ready.');
    },'fresh model download and checksum completion',300000);
    assert.equal((await stat(path.join(snapshot,'config.json'))).mtimeMs,metadata.mtimeMs,'retry reuses completed metadata');
    const ready=await execute('return window.__TAURI_INTERNALS__.invoke("mlx_catalog");');
    modelPath=ready.find(m=>m.id===model.id).path;assert.equal(modelPath,snapshot);
    downloadEvidence.files=[];
    for(const f of model.files){
      const file=path.join(snapshot,f.name),info=await stat(file);assert.equal(info.size,f.bytes);
      const target=await realpath(file);assert(target.startsWith(modelCache+path.sep),'files must belong to the isolated cache');
      const hash=createHash(f.sha256?'sha256':'sha1');if(!f.sha256)hash.update(`blob ${f.bytes}\0`);
      for await(const chunk of createReadStream(file))hash.update(chunk);
      const digest=hash.digest('hex');assert.equal(digest,f.sha256??f.git_sha1,f.name+' checksum');
      downloadEvidence.files.push({name:f.name,bytes:info.size,digest});
    }
    const beforeRun=await execute('return window.__TAURI_INTERNALS__.invoke("bench_sessions",{limit:20});');
    assert(!beforeRun.some(s=>s.protocol==='mlx_worker_text_v1'),'download must not auto-run inference');
    console.log('Fresh MLX download passed: partial weight transfer → Activity cancellation → retry → all pinned checksums.');
  }
  if(modelPath) {
    const beforeNative=execFileSync('sqlite3',[path.join(scratch,'registry.db'),"SELECT COUNT(*) FROM bench_runs WHERE suite_id='anchor-scenarios';"],{encoding:'utf8'}).trim();
    assert.equal(beforeNative,String(counts[2]+2),'two CLI interoperability workloads add exactly two Ollama rows');
    checkpoint('mlx-suite-and-stop');
    await nav('Benchmark');await attrClick('Benchmark runtime');await click('MLX','[role="option"]');
    const cached=await execute('return window.__TAURI_INTERNALS__.invoke("mlx_models",{paths:'+JSON.stringify([modelPath])+'});');
    const model=cached.find(m=>m.path===modelPath);assert(model,'local checkpoint appears in the model picker');
    const refreshedCatalog=await execute('return window.__TAURI_INTERNALS__.invoke("mlx_catalog");');
    const curated=refreshedCatalog.find(m=>m.path===model.path);
    await attrClick('Benchmark model');await click(curated?.name??model.name.replace(/^.*\//,'').replaceAll('-',' '),'[role="option"]');
    assert(!(await visibleText()).includes('Measure MLX'),'standalone synthetic panel is removed');
    await click('Run suite');
    await wait(()=>execute('return Array.from(document.querySelectorAll("button")).some(e=>e.textContent.trim()==="Run suite"&&e.getClientRects().length)'),'live nine-scenario MLX text suite',180000);
    const nativeSessions=await execute('return window.__TAURI_INTERNALS__.invoke("bench_sessions",{limit:20});');
    const native=nativeSessions.find(s=>s.protocol==='mlx_worker_text_v1'&&s.outcome==='completed');assert(native,await visibleText());
    const nativeSummary=await execute('return window.__TAURI_INTERNALS__.invoke("mlx_suite_report",{id:'+JSON.stringify(native.id)+'});');
    assert.equal(nativeSummary.report.boundaries_validated,true);assert.equal(nativeSummary.report.identity_unchanged,true);
    assert.equal(nativeSummary.report.comparison_eligible,false);assert.equal(nativeSummary.config,undefined);
    assert.equal(native.recorded_attempts,native.planned_attempts,'MLX attempts remain persisted');
    if(freshMlx){
      const evidenceDir=path.join(root,'.internal/benchmarking/mlx-download-validation');await mkdir(evidenceDir,{recursive:true});
      const artifact=path.join(evidenceDir,native.id);
      const rows=await execute('return window.__TAURI_INTERNALS__.invoke("mlx_suite_runs",{modelPath:'+JSON.stringify(modelPath)+',history:true});');
      assert.equal(rows.length,9,'downloaded model completes every workload');
      Object.assign(downloadEvidence,{completedAt:new Date().toISOString(),session:native,summary:nativeSummary,scenarios:rows});
      await writeFile(artifact+'.json',JSON.stringify(downloadEvidence,null,2));
      await writeFile(artifact+'.png',Buffer.from(await request('GET','/session/'+session+'/screenshot'),'base64'));
      console.log('Fresh-download native evidence: '+artifact+'.json');
    }
    await wait(()=>execute('const s=Array.from(document.querySelectorAll("summary")).find(e=>e.textContent.trim()==="Measurement checks"&&e.getClientRects().length);if(!s)return false;if(!s.parentElement.open)s.click();return s.parentElement.open;'),'open MLX measurement checks');
    await wait(async()=> (await visibleText()).includes('Timing and allocator checks passed'),'MLX measurement report rendered');
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
    assert.equal(afterNative,beforeNative,'MLX does not alter Ollama ranking rows');
    await attrClick('Benchmark runtime');await click('Ollama','[role="option"]');
    await attrClick('Benchmark model');await click(catalog[1].name,'[role="option"]');
    await wait(async()=> (await visibleText()).includes('Checks recorded'),'recalled Ollama validation');
    assert.match(await visibleText(),/Checks recorded/,'Ollama validation remains separate');
    console.log('Live MLX suite E2E passed: shared GUI → uv → GPU → SQLite → checks; Stop and runtime separation.');
    if(freshMlx){
      checkpoint('mlx-export-replay-and-invalid-evidence');
      execFileSync('cargo',['test','--locked','-p','anchor-hub','--test','mlx_suite_e2e','--','--ignored','--nocapture'],{cwd:root,env:{...process.env,OLLAMA_HOST:'http://127.0.0.1:'+port,OLLAMA_MODELS:path.join(scratch,'models'),HF_HOME:path.dirname(hubCache),HF_HUB_CACHE:hubCache,HF_XET_CACHE:path.join(scratch,'xet'),ANCHOR_MLX_E2E_MODEL:modelPath,ANCHOR_MLX_E2E_SCENARIO:'classify'},stdio:'inherit',timeout:180000});
    }
  }
  checkpoint('restart-and-recall');
  await request('DELETE','/session/'+session);session=null;
  child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);});
  child=launch();
  await wait(()=>request('GET','/status'),'native restart',45000);
  session=(await request('POST','/session',{capabilities:{alwaysMatch:{browserName:'tauri'}}})).sessionId;
  await wait(()=>execute('return !!document.querySelector("nav[aria-label=Tools]");'),'restarted UI');
  const restored=await execute('return window.__TAURI_INTERNALS__.invoke("bench_sessions",{limit:20});');
  assert(restored.some(s=>s.id===complete.id&&s.outcome==='completed'));
  assert((await execute('return window.__TAURI_INTERNALS__.invoke("list_presets");')).some(p=>p.id===preset.id));
  assert.equal((await execute('return window.__TAURI_INTERNALS__.invoke("list_conversations");')).length,1);
  if(process.env.ANCHOR_E2E_ARTIFACT_DIR){
    await writeFile(path.join(process.env.ANCHOR_E2E_ARTIFACT_DIR,freshMlx?'mlx-native.json':'native.json'),JSON.stringify({step,cliCommands,sessions:restored,download:freshMlx?downloadEvidence:undefined},null,2));
  }
  // SQLite queries above verify persisted data beyond the component state.
  await request('DELETE','/session/'+session);session=null;child.kill('SIGTERM');
  success=true;console.log('Native E2E passed: UI → IPC → Rust → HTTP; filesystem permission denial, chat/context, navigation, comparison cancellation/completion, benchmark cancellation/full suite, calibration cancellation/report, SQLite persistence.');
}catch(error){
  const state=JSON.stringify({step,error:error.stack,requests,download:freshMlx?downloadEvidence:undefined,page:session?await execute('return {url:location.href,text:document.body.innerText,disclosures:Array.from(document.querySelectorAll("details")).map(e=>({summary:e.querySelector("summary")?.textContent,open:e.open}))}').catch(String):null},null,2);
  await writeFile(path.join(scratch,'state.json'),state);await writeFile(path.join(scratch,'native.log'),log);
  if(process.env.ANCHOR_E2E_ARTIFACT_DIR){
    const prefix=path.join(process.env.ANCHOR_E2E_ARTIFACT_DIR,freshMlx?'mlx-native-failure':'native-failure');
    await writeFile(prefix+'.json',state);await writeFile(prefix+'.log',log);
    if(session){const screenshot=await request('GET','/session/'+session+'/screenshot').catch(()=>null);if(screenshot)await writeFile(prefix+'.png',Buffer.from(screenshot,'base64'));}
  }
  console.error('Native E2E evidence: '+scratch);throw error;
}
finally{
  if(session)await request('DELETE','/session/'+session).catch(()=>{});
  child.kill('SIGTERM');server.closeAllConnections();await new Promise(r=>server.close(r));
  if(success)await rm(scratch,{recursive:true,force:true});
}
