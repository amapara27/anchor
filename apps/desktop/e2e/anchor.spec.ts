import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
const catalog = JSON.parse(fs.readFileSync(new URL('../../../crates/anchor-core/profiles/models.json', import.meta.url), 'utf8')).slice(0, 3);

// Browser-side Tauri transport double: the real React app and real Channel reducer
// run unchanged. Backend HTTP/SQLite behavior is checked by cargo tests separately.
async function boot(page: Page, options: {empty?: boolean; offline?: boolean; failDownload?: boolean; measurements?: boolean; variants?: boolean} = {}) {
  await page.addInitScript(({catalog, options}) => {
    const w = window as any;
    let sequence = 0;
    const callbacks = new Map<number, Function>();
    const counters = new Map<number, number>();
    const emit = (channel: any, message: any) => {
      const id = channel.id;
      const index = counters.get(id) ?? 0;
      counters.set(id, index + 1);
      callbacks.get(id)?.({index, message});
    };
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const models = catalog.slice(0, 2).map((p: any, i: number) => ({
      id:p.id,name:p.name,family:p.family,size_bytes:options.measurements ? (i===0 ? 16e9 : 4.9e9) : (i+1)*1024**3,status:'installed',parameter_size:options.measurements?'8B':'1.2B',
      quantization:options.measurements?'F16':'Q8_0',context_tokens:131072,modified_at:new Date().toISOString(),publisher:p.publisher,arch:options.measurements?{architecture:"llama",block_count:16,head_count_kv:8,key_length:64,value_length:64}:null,
    }));
    const hardware = {chip:'Apple M4',arch:'aarch64',memory_bytes:16*1024**3,total_cores:10,performance_cores:4,
      efficiency_cores:6,gpu_cores:10,os_version:'26.0',apple_silicon:true,model_name:'Mac'};
    const stats = options.measurements ? {eval_count:42,eval_duration_ns:2e9,prompt_eval_count:100,prompt_eval_cached_count:90,prompt_eval_duration_ns:1e7,ttft_ms:80,total_duration_ns:3e9,load_duration_ns:2e9} : {eval_count:32,eval_duration_ns:1e9,prompt_eval_count:20,prompt_eval_duration_ns:1e8,total_duration_ns:2e9,load_duration_ns:0};
    const state = w.__e2e = {models:options.empty?[]:models,calls:[] as any[],conversations:[] as any[],messages:{} as any,
      runs:[] as any[],version:'0.12',chatStop:false,compareStop:false,benchStop:false,offline:options.offline??false,presets:[{id:'default',name:'Default',system:null,num_ctx:null,temperature:null,top_p:null,model:null,created_ms:0}]};
    const runFor = (model: string) => ({id:'run-'+Date.now(),model_name:model,model_digest:model,hw:{...hardware,key:'test'},
      quant:'Q8_0',suite_id:'anchor-scenarios',suite_version:3,prompt_id:'balanced',prompt_version:1,prompt_tokens:896,
      gen_tokens:1024,num_ctx:2048,repeats:1,decode_tps_median:options.measurements?21:32,prefill_tps_median:options.measurements?1000:200,ttft_ms_median:options.measurements?80:100,
      source:'local',updated_at:Date.now(),match_quality:'exact',thermal_label:'sustained',env_start:null,env_end:null,
      rating:null,review:null,notes:null,resident_bytes:options.variants?1.2*1024**3:null,kv_cache_type:"unknown",flash_attn:null,synced_at:null,
      ollama_version:state.version,prev_decode_tps_median:null,prev_ollama_version:null});
    w.__TAURI_INTERNALS__ = {
      transformCallback: (fn: Function) => {callbacks.set(++sequence,fn); return sequence;},
      unregisterCallback: (id: number) => callbacks.delete(id),
      convertFileSrc: (p: string) => p,
      invoke: async (cmd: string, args: any = {}) => {
        state.calls.push({cmd,args});
        switch(cmd) {
          case 'list_catalog': return catalog;
          case 'list_library': return [{name:'fixture-library',description:'Public download-size fixture',capabilities:[],sizes:['8b'],pulls:1,tag_count:1,updated:'today'}];
          case 'library_tags': return options.variants ? [['8b','q4','4.9GB'],['8b-instruct-q4_K_M','q4','4.9GB'],['8b-instruct-q8_0','q8','8.5GB'],['8b-instruct-fp16','f16','16GB'],['8b-instruct-q3_K_S','q3','3.7GB'],['8b-text-q4_K_M','t4','4.9GB'],['70b','70','43GB']]
            .map(([tag,digest,size])=>({tag:args.name+':'+tag,digest,size,context:'128K',modality:'text'})) : [{tag:'fixture-library:8b',digest:'build',size:'4.9GB',context:'128K',modality:'text'}];
          case 'tag_arch': return models[0].arch;
          case 'list_models': if(state.offline) throw 'Ollama is not reachable'; return state.models;
          case 'get_hardware_profile': case 'refresh_hardware_profile': return hardware;
          case 'get_server_status': return {reachable:!state.offline,version:state.version,host:'http://localhost:11434',local:true,managed:true};
          case 'running_models': return [];
          case 'list_presets': return structuredClone(state.presets);
          case 'save_preset': state.presets=state.presets.filter((p:any)=>p.id!==args.preset.id).concat(args.preset); return;
          case 'set_conversation_preset': { const c=state.conversations.find((c:any)=>c.id===args.id); if(c)c.preset_id=args.presetId; return; }
          case 'list_conversations': return structuredClone(state.conversations);
          case 'create_conversation': {const c={id:'chat-'+(++sequence),title:'New chat',model:args.model,preset_id:args.presetId,created_ms:Date.now(),updated_ms:Date.now()};state.conversations.unshift(c);state.messages[c.id]=[];return c;}
          case 'conversation_messages': return structuredClone(state.messages[args.id] ?? []);
          case 'run_chat': {
            state.chatStop=false;
            const id=args.conversationId;
            state.messages[id].push({id:'user',role:'user',content:args.content,thinking:null,stats_json:null,created_ms:Date.now()});
            emit(args.onEvent,{kind:'loading',model:args.model}); await sleep(150);
            emit(args.onEvent,{kind:'token',text:'A useful local answer.'}); await sleep(350);
            state.messages[id].push({id:'answer',role:'assistant',content:'A useful local answer.',thinking:null,stats_json:JSON.stringify(stats),created_ms:Date.now()});
            emit(args.onEvent,{kind:'result',response:'A useful local answer.',thinking:'',stats});return;
          }
          case 'stop_chat': state.chatStop=true;return;
          case 'download_model': {
            emit(args.onEvent,{status:'downloading',total:100,completed:10});await sleep(400);
            if(options.failDownload) throw 'Download failed: connection lost';
            if(state.calls.some((c:any)=>c.cmd==='cancel_download'&&c.args.id===args.id)) throw 'cancelled';
            const p=catalog.find((p:any)=>p.id===args.id);state.models.push({...models[0],id:p.id,name:p.name});return;
          }
          case 'cancel_download': return;
          case 'remove_model': state.models=state.models.filter((m:any)=>m.id!==args.id);return;
          case 'compare_models': {
            state.compareStop=false;
            for(const [slot,model] of [['a',args.modelA],['b',args.modelB]]) {
              emit(args.onEvent,{kind:'status',slot,phase:'generating'});await sleep(400);
              if(state.compareStop) {emit(args.onEvent,{kind:'failed',slot,message:'Comparison stopped'});continue;}
              emit(args.onEvent,{kind:'token',slot,text:'Answer from '+model});
              emit(args.onEvent,{kind:'result',slot,response:'Answer from '+model,stats});
            }return;
          }
          case 'stop_comparison':state.compareStop=true;return;
          case 'bench_runs_for_model': return state.runs.filter((r:any)=>!args.model||r.model_name===args.model);
          case 'bench_history': return state.runs;
          case 'latest_measurements': return Object.values(Object.fromEntries(state.runs.map((r:any)=>[r.model_name,r])));
          case 'run_benchmark': {
            state.benchStop=false;emit(args.onEvent,{kind:'status',message:'Warming up'});
            if(options.measurements) {emit(args.onEvent,{kind:'sample',chunks_per_sec:12});await sleep(500);}
            await sleep(700);
            const runs=state.benchStop?[]:[runFor(args.model)];state.runs.push(...runs);
            if(options.measurements && runs.length) {emit(args.onEvent,{kind:"scenario_started",scenario_id:"balanced",num_ctx:2048,index:1,total:9});emit(args.onEvent,{kind:"scenario_done",run:runs[0],index:1,total:9});}
            emit(args.onEvent,{kind:'done',runs});return runs;
          }
          case 'stop_benchmark':state.benchStop=true;return;
          case 'scan_storage':return {root:'/test/models',blobs_bytes:3*1024**3,manifests_bytes:100,orphaned_bytes:0,dedup_savings_bytes:0,orphaned_blobs:[],unreadable_manifests:0};
          case 'unload_model': return;
          case 'plugin:updater|check': return null;
          default: throw new Error('Unhandled E2E command: '+cmd);
        }
      },
    };
  }, {catalog,options});
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Models',exact:true})).toBeVisible();
}
const nav = (page: Page, name: string) => ({click: async () => { await page.getByRole('navigation',{name:'Tools'}).getByRole('button',{name,exact:true}).click(); }});
async function selectModel(page: Page, label: string, name: string) {
  await page.getByRole('combobox',{name:label}).click();
  await page.getByRole('option').filter({hasText:name}).first().click();
}

test('models → inspect → context → try → navigation preserves conversation and draft',async ({page})=>{
  await boot(page);
  await expect(page.getByRole('navigation',{name:'Tools'}).getByRole('button',{name:'Models',exact:true})).toHaveAttribute('aria-current','page');
  await expect(page.getByText('Select a model to see its details.')).toHaveCount(0);
  await page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true}).click();
  const inspector=page.getByRole('region',{name:'Model inspector'});
  await expect(inspector).toContainText('Q8_0');
  const headroom=await inspector.innerText();
  await page.getByLabel('Fit context').selectOption('32768');
  expect(await inspector.innerText()).not.toBe(headroom);
  await page.getByRole('button',{name:'Try model'}).click();
  await expect(page.getByRole('combobox',{name:'Chat model'})).toContainText(catalog[0].name);
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Explain a local model');
  await page.getByRole('button',{name:'Send message'}).click();
  await nav(page,'Models').click();
  await expect(page.getByRole('status',{name:'Activity'})).toContainText('Trying');
  await nav(page,'Try').click();
  await expect(page.getByText('A useful local answer.',{exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('A draft worth keeping');
  await nav(page,'Models').click();await nav(page,'Try').click();
  await expect(page.getByRole('textbox',{name:'Message',exact:true})).toHaveValue('A draft worth keeping');
  expect(await page.evaluate(()=> (window as any).__e2e.conversations.length)).toBe(1);
  expect(await page.evaluate(()=> (window as any).__e2e.presets.find((p:any)=>p.id==='trial-context-32768').num_ctx)).toBe(32768);
});

test('Find suggestions use installed metadata, filter and keyboard selection',async({page})=>{
  await boot(page);await page.getByRole('tab',{name:'Find',exact:true}).click();
  await page.getByLabel('Filter suggested models').fill(catalog[0].name);
  await expect(page.getByRole('button',{name:'Inspect '+catalog[2].name,exact:true})).toHaveCount(0);
  const result=page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true});
  await expect(result).toContainText('Q8_0');await result.focus();await page.keyboard.press('Enter');
  await expect(page.getByRole('region',{name:'Model inspector'})).toBeVisible();
});

test('empty installation → find → download → installed; removal requires confirmation',async({page})=>{
  await boot(page,{empty:true});await page.getByRole('button',{name:'Find a model',exact:true}).click();
  await page.getByLabel('Filter suggested models').fill(catalog[0].name);
  await page.getByRole('button',{name:'Download '+catalog[0].name,exact:true}).click();
  await expect(page.getByRole('status',{name:'Activity'})).toContainText('downloading');
  await page.getByRole('tab',{name:'Installed',exact:true}).click();
  await page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true}).click();
  await page.getByRole('button',{name:'Remove model',exact:true}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Remove model',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'Remove',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Choose your first local model'})).toBeVisible();
});

test('comparison survives navigation and can be stopped elsewhere',async({page})=>{
  await boot(page);await page.getByRole('tab',{name:'Compare',exact:true}).click();
  await selectModel(page,'Model A model',catalog[0].name);await selectModel(page,'Model B model',catalog[1].name);
  await page.getByLabel('Prompt',{exact:true}).fill('Compare explanations');
  await page.getByRole('button',{name:'Run comparison'}).click();await nav(page,'Settings').click();
  await page.getByRole('status',{name:'Activity'}).getByRole('button',{name:'Stop comparison'}).click();
  await nav(page,'Compare').click();
  await expect(page.getByText('Comparison stopped').first()).toBeVisible();
  await expect(page.getByLabel('Prompt',{exact:true})).toHaveValue('Compare explanations');
  await page.getByRole('button',{name:'Run comparison'}).click();
  await expect(page.getByText('Answer from '+catalog[0].id,{exact:true})).toBeVisible();
  await expect(page.getByText('Answer from '+catalog[1].id,{exact:true})).toBeVisible();
});

test('model → benchmark handoff, cancellation, completion and stored results',async({page})=>{
  await boot(page);await page.getByRole('button',{name:'Inspect '+catalog[1].name,exact:true}).click();
  await page.getByRole('button',{name:'Benchmark',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Benchmark model'})).toContainText(catalog[1].name);
  await page.getByRole('button',{name:'Run suite',exact:true}).click();await nav(page,'Models').click();
  await page.getByRole('status',{name:'Activity'}).getByRole('button',{name:'Stop benchmark'}).click();
  await nav(page,'Benchmarks').click();await expect(page.getByRole('button',{name:'Run suite',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Run suite',exact:true}).click();
  await expect(page.getByText('32.0',{exact:true}).first()).toBeVisible();
  await expect(page.getByRole('tab',{name:'Community',exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=> (window as any).__e2e.runs.length)).toBe(1);
});

test('offline recovery and failed download are visible',async({page})=>{
  await boot(page,{offline:true,failDownload:true});await expect(page.getByRole('alert')).toContainText('not reachable');
  await page.evaluate(()=>{(window as any).__e2e.offline=false;});await page.getByRole('button',{name:'Retry',exact:true}).click();
  await expect(page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'Find',exact:true}).click();
  await page.getByRole('button',{name:'Download '+catalog[2].name,exact:true}).click();
  await expect(page.getByRole('status',{name:'Activity'})).toContainText('Download failed');
});

for(const width of [800,1000]) test('minimum/default window fits core controls at '+width,async({page})=>{
  await page.setViewportSize({width,height:600});await boot(page);
  const row=page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true});await expect(row).toBeVisible();
  const rect=await row.boundingBox();expect(rect!.x+rect!.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await row.click();await expect(page.getByRole('button',{name:'Try model'})).toBeVisible();
  await page.screenshot({path:'test-results/models-'+width+'.png',fullPage:true});
});

test('selected inspector brings actions into view and New chat starts an empty thread by keyboard', async({page})=>{
  await page.setViewportSize({width:800,height:600});
  await boot(page);
  await page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true}).click();
  const inspector=page.getByRole('region',{name:'Model inspector'});
  await expect(inspector).toBeFocused();
  const action=page.getByRole('button',{name:'Try model'});
  const rect=await action.boundingBox();
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.y+rect!.height).toBeLessThanOrEqual(600);
  await action.click();
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('First trial');
  await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.getByText('A useful local answer.',{exact:true})).toBeVisible();
  const fresh=page.getByRole('button',{name:'New chat',exact:true});
  await expect(fresh).toBeEnabled();
  await fresh.focus();await page.keyboard.press('Enter');
  await expect(page.getByText('A useful local answer.',{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=> (window as any).__e2e.conversations.length)).toBe(2);
});

// One bounded visual matrix for the native window sizes; transport data is synthetic.
for (const [width,height,theme] of [[1440,900,'dark'],[1000,700,'light'],[800,600,'dark']] as const) {
  test('tool workspace, keyboard and layout at '+width+' '+theme,async({page})=>{
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.setViewportSize({width,height});
    await page.addInitScript(theme=>localStorage.setItem('anchor.theme',theme),theme);
    await boot(page);
    const palette=await page.evaluate(()=>{const css=getComputedStyle(document.documentElement);return {canvas:css.getPropertyValue('--canvas').trim(),accent:css.getPropertyValue('--accent').trim()};});
    expect(palette).toEqual(theme==='dark'?{canvas:'#0a0a0b',accent:'#7a67de'}:{canvas:'#f7f4ed',accent:'#9a7317'});
    const capture=async(name:string)=>{
      const main=page.locator('main:visible');
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect(await main.evaluate(el=>el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({path:'test-results/revamp-'+width+'-'+theme+'-'+name+'.png'});
    };
    await capture('models');
    const modelRow=page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true});
    await modelRow.click();await expect(page.getByRole('region',{name:'Model inspector'})).toBeFocused();
    await capture('inspector');
    await page.getByRole('button',{name:'Close model details'}).click();await expect(modelRow).toBeFocused();
    const toggle=page.getByRole('button',{name:'Toggle tool sidebar'});
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded',width<980?'true':'false');
    await nav(page,'Settings').click();
    await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();
    await toggle.click();
    await capture('settings');
    await nav(page,'Manage storage').click();
    const checkbox=page.getByRole('checkbox',{name:'Select '+catalog[0].name});
    await checkbox.focus();await page.keyboard.press('Space');
    await expect(checkbox).toBeChecked();
    await capture('storage');
    await nav(page,'Benchmarks').click();await expect(page.getByRole('region',{name:'Benchmark status'})).toHaveCount(0);await capture('benchmarks');
    await page.getByRole('tab',{name:'Leaderboard',exact:true}).click();
    const scenario=page.getByRole('combobox',{name:'Leaderboard scenario'});
    await expect(scenario.locator('option')).toHaveCount(9);
    await scenario.selectOption('reasoning');
    await expect(page.getByLabel('Scenario token counts')).toHaveText('1536 in / 2560 out · 8K context');
    await expect.poll(()=>page.evaluate(()=> (window as any).__e2e.calls.filter((c:any)=>c.cmd==='bench_runs_for_model'&&c.args.model===null).at(-1)?.args.promptId)).toBe('reasoning');
    await capture('leaderboard');
    await nav(page,'Compare').click();
    await expect(page.getByRole('tab',{name:'Compare',exact:true})).toHaveAttribute('aria-selected','true');
    await capture('compare');
    const tab=page.getByRole('tab',{name:'Compare',exact:true});
    await tab.focus();await page.keyboard.press('Home');
    await expect(page.getByRole('tab',{name:'Installed',exact:true})).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab',{name:'Find',exact:true})).toBeFocused();
    await expect(page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true})).toBeVisible();
    await capture('find');
    await nav(page,'Try').click();await capture('try');
  });
}

for (const width of [800, 1440]) {
  test('measurement values, provenance and public download units at '+width,async({page})=>{
    await page.setViewportSize({width,height:900});
    await page.addInitScript(id=>localStorage.setItem('anchor.measured',JSON.stringify([{modelId:id,chip:'Apple M4',quant:'F16',tokPerSec:999,prompt:'old build',ts:1}])),catalog[0].id);
    await boot(page,{measurements:true});
    const row=page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true});
    await expect(row).toContainText('14.9 GiB');
    await expect(row).toContainText('~6.4 tok/s');
    await expect(row).not.toContainText('999');
    await row.click();
    const inspector=page.getByRole('region',{name:'Model inspector'});
    await page.getByLabel('Fit context').selectOption('32768');
    await inspector.getByText('Memory breakdown & model details',{exact:true}).click();
    const detail = (label:string) => inspector.locator('dt').filter({hasText:label}).locator('+ dd');
    await expect(detail('Weights')).toHaveText('14.9 GiB');
    await expect(detail('KV cache at')).toHaveText('1.0 GiB');
    await expect(detail('Compute buffer')).toHaveText('0.13 GiB');
    await expect(detail('OS reserve')).toHaveText('2.4 GiB');
    await expect(inspector).toContainText('18.4 GiB estimated RAM');
    await expect(inspector).toContainText('f16 KV cache, one sequence, Flash Attention');
    await page.getByRole('button',{name:'Close model details'}).click();
    await page.getByRole('tab',{name:'Find',exact:true}).click();
    await page.getByRole('button',{name:'Ollama library',exact:true}).click();
    await page.getByRole('button').filter({hasText:'fixture-library'}).click();
    await page.getByText('fixture-library:8b',{exact:true}).click();
    const download=page.getByRole('region',{name:'Model inspector'});
    await expect(download.getByRole('button',{name:'Download · 4.6 GiB'})).toBeVisible();
    await download.getByText('Memory breakdown & model details',{exact:true}).click();
    await expect(download.locator('dt').filter({hasText:'Weights'}).locator('+ dd')).toHaveText('4.6 GiB');
  });
}

test('comparison shows observed TTFT and benchmark distinguishes chunk rate from decode',async({page})=>{
  await boot(page,{measurements:true});
  await nav(page,'Compare').click();
  await selectModel(page,'Model A model',catalog[0].name);
  await selectModel(page,'Model B model',catalog[1].name);
  await page.getByLabel('Prompt',{exact:true}).fill('Compare measurement values');
  await page.getByRole('button',{name:'Run comparison',exact:true}).click();
  await expect(page.getByText('80 ms',{exact:true})).toHaveCount(2);
  await expect(page.getByText('TTFT',{exact:true})).toHaveCount(2);
  await expect(page.getByText('21.0 tok/s',{exact:true}).first()).toBeVisible();
  await expect(page.getByText('Load + prompt',{exact:true})).toHaveCount(0);
  await nav(page,'Benchmarks').click();
  await selectModel(page,'Benchmark model',catalog[0].name);
  await page.getByRole('button',{name:'Run suite',exact:true}).click();
  await expect(page.getByRole('region',{name:'Benchmark status'})).toContainText('12.0 chunks/s');
  await expect(page.getByLabel('Received response chunks per second')).toBeVisible();
  await expect(page.getByRole('button',{name:'Run suite',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Benchmark status'})).toContainText('21.0 tok/s');
  const balanced=page.getByRole('button').filter({hasText:'balanced'}).filter({hasText:'1000'});
  await expect(balanced).toContainText('21.0');
  await page.getByText('Method',{exact:true}).click();
  await expect(page.getByText(/Prefill counts uncached tokens/)).toBeVisible();
  await expect(page.getByText(/Thermal status comes from boundary snapshots/)).toBeVisible();
  await expect(page.getByText('In target',{exact:true})).toBeVisible();
  await expect(page.getByText('Out cap',{exact:true})).toBeVisible();
});

test('global fit context, per-quant table, quick measure, version flags and copyable commands',async({page})=>{
  await boot(page,{variants:true});
  await expect(page.getByRole('button',{name:'Fits at 4K',exact:true})).toBeVisible();
  await page.getByLabel('Fit context').selectOption('32768');
  await expect(page.getByRole('button',{name:'Fits at 32K',exact:true})).toBeVisible();
  await expect(page.getByText('fit @ 32K',{exact:true})).toBeVisible();

  await page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true}).click();
  const inspector=page.getByRole('region',{name:'Model inspector'});
  await expect(inspector).toContainText('at 32K');
  const quants=inspector.getByRole('region',{name:'Quantizations'});
  // Aliases of one build collapse to a row; other sizes (70b) and the text variant are not this model's quants.
  const quantRows=quants.getByRole('button',{name:/^Inspect /});
  await expect(quantRows).toHaveCount(3);
  await quants.getByRole('button',{name:'Show all 4',exact:true}).click();
  await expect(quantRows).toHaveCount(4);
  await expect(quants).toContainText('Q3_K_S');
  await expect(quants).not.toContainText('text');
  await expect(quants.getByRole('button',{name:'Inspect llama3.1:8b',exact:true})).toHaveAttribute('aria-current','true');
  await expect(quants).toContainText('Q8_0');
  await expect(quants).toContainText('F16');
  await expect(quants).not.toContainText('43GB');
  await quants.getByRole('button',{name:'Inspect llama3.1:8b-instruct-fp16',exact:true}).click();
  await expect(inspector).toContainText('llama3.1:8b-instruct-fp16');
  await expect(inspector.getByRole('button',{name:/^Download · /})).toBeVisible();

  await page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true}).click();
  await expect(inspector.getByText('measured',{exact:false})).toHaveCount(0);
  await inspector.getByRole('button',{name:'Measure',exact:true}).click();
  await expect(page.getByRole('status',{name:'Activity'})).toContainText('Measuring '+catalog[0].id);
  const row=page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true});
  await expect(row).toContainText('32.0 tok/s');
  await expect(row).toContainText('measured');
  const call=await page.evaluate(()=>(window as any).__e2e.calls.find((c:any)=>c.cmd==='run_benchmark').args);
  expect([call.scenario,call.repeats]).toEqual(['balanced','fast']);
  await expect(inspector).toContainText('GiB predicted');
  await expect(inspector).toContainText('1.2 GiB observed');

  // A run from an older Ollama is flagged, with the speed change across the last upgrade.
  await page.evaluate(()=>{const r=(window as any).__e2e.runs.at(-1);Object.assign(r,{ollama_version:'0.11',prev_decode_tps_median:40,prev_ollama_version:'0.10'});window.dispatchEvent(new Event('anchor:measurements'));});
  await expect(row).toContainText('stale');
  await expect(inspector).toContainText('Measured on Ollama 0.11 (now 0.12)');
  await expect(inspector).toContainText('-20% vs Ollama 0.10');
  await page.screenshot({path:'test-results/features-inspector.png',fullPage:true});

  await inspector.getByRole('button',{name:'Re-measure',exact:true}).click();
  await inspector.getByRole('button',{name:'Stop',exact:true}).click();
  await expect(inspector.getByRole('button',{name:'Re-measure',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__e2e.runs.length)).toBe(1);

  await inspector.getByText('Use from other apps',{exact:true}).click();
  await expect(inspector).toContainText('ollama run '+catalog[0].id);
  await expect(inspector).toContainText('http://localhost:11434/v1/chat/completions');
});
