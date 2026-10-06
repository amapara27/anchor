import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
const catalog = JSON.parse(fs.readFileSync(new URL('../../../crates/anchor-search/profiles/models.json', import.meta.url), 'utf8')).slice(0, 3);

// Browser-side Tauri transport double: the real React app and real Channel reducer
// run unchanged. Backend HTTP/SQLite behavior is checked by cargo tests separately.
async function boot(page: Page, options: {empty?: boolean; offline?: boolean; failDownload?: boolean} = {}) {
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
      id:p.id,name:p.name,family:p.family,size_bytes:(i+1)*1024**3,status:'installed',parameter_size:'1.2B',
      quantization:'Q8_0',context_tokens:131072,modified_at:new Date().toISOString(),publisher:p.publisher,arch:null,
    }));
    const hardware = {chip:'Apple M4',arch:'aarch64',memory_bytes:16*1024**3,total_cores:10,performance_cores:4,
      efficiency_cores:6,gpu_cores:10,os_version:'26.0',apple_silicon:true,model_name:'Mac'};
    const stats = {eval_count:32,eval_duration_ns:1e9,prompt_eval_count:20,prompt_eval_duration_ns:1e8,total_duration_ns:2e9,load_duration_ns:0};
    const state = w.__e2e = {models:options.empty?[]:models,calls:[] as any[],conversations:[] as any[],messages:{} as any,
      runs:[] as any[],chatStop:false,compareStop:false,benchStop:false,offline:options.offline??false,presets:[{id:'default',name:'Default',system:null,num_ctx:null,temperature:null,top_p:null,model:null,created_ms:0}]};
    const runFor = (model: string) => ({id:'run-'+Date.now(),model_name:model,model_digest:model,hw:{...hardware,key:'test'},
      quant:'Q8_0',suite_id:'anchor-scenarios',suite_version:2,prompt_id:'balanced',prompt_version:1,prompt_tokens:896,
      gen_tokens:1024,num_ctx:2048,repeats:1,decode_tps_median:32,prefill_tps_median:200,ttft_ms_median:100,
      source:'local',updated_at:Date.now(),match_quality:'exact',thermal_label:'sustained',env_start:null,env_end:null,
      rating:null,review:null,notes:null,peak_memory_bytes:null,synced_at:null});
    w.__TAURI_INTERNALS__ = {
      transformCallback: (fn: Function) => {callbacks.set(++sequence,fn); return sequence;},
      unregisterCallback: (id: number) => callbacks.delete(id),
      convertFileSrc: (p: string) => p,
      invoke: async (cmd: string, args: any = {}) => {
        state.calls.push({cmd,args});
        switch(cmd) {
          case 'list_catalog': return catalog;
          case 'list_models': if(state.offline) throw 'Ollama is not reachable'; return state.models;
          case 'get_hardware_profile': case 'refresh_hardware_profile': return hardware;
          case 'get_server_status': return {reachable:!state.offline,version:'0.12',host:'http://localhost:11434',local:true,managed:true};
          case 'running_models': return [];
          case 'list_presets': return structuredClone(state.presets);
          case 'save_preset': state.presets=state.presets.filter((p:any)=>p.id!==args.preset.id).concat(args.preset); return;
          case 'set_conversation_preset': { const c=state.conversations.find((c:any)=>c.id===args.id); if(c)c.preset_id=args.presetId; return; }
          case 'list_conversations': return structuredClone(state.conversations);
          case 'create_conversation': {const c={id:'chat-'+(++sequence),title:'New trial',model:args.model,preset_id:args.presetId,created_ms:Date.now(),updated_ms:Date.now()};state.conversations.unshift(c);state.messages[c.id]=[];return c;}
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
          case 'recent_searches': return [];
          case 'search_models': return catalog.map((profile:any)=>({profile,score:0.8}));
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
          case 'run_benchmark': {
            state.benchStop=false;emit(args.onEvent,{kind:'status',message:'Warming up'});await sleep(700);
            const runs=state.benchStop?[]:[runFor(args.model)];state.runs.push(...runs);
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
  await nav(page,'Try & history').click();
  await expect(page.getByText('A useful local answer.',{exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('A draft worth keeping');
  await nav(page,'Models').click();await nav(page,'Try & history').click();
  await expect(page.getByRole('textbox',{name:'Message',exact:true})).toHaveValue('A draft worth keeping');
  expect(await page.evaluate(()=> (window as any).__e2e.conversations.length)).toBe(1);
  expect(await page.evaluate(()=> (window as any).__e2e.presets.find((p:any)=>p.id==='trial-context-32768').num_ctx)).toBe(32768);
});

test('Find uses installed metadata and keyboard selection',async({page})=>{
  await boot(page);await page.getByRole('tab',{name:'Find',exact:true}).click();
  await page.getByLabel('Describe your use case').fill('low memory');await page.getByRole('button',{name:'Search',exact:true}).click();
  const result=page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true});
  await expect(result).toContainText('Q8_0');await result.focus();await page.keyboard.press('Enter');
  await expect(page.getByRole('region',{name:'Model inspector'})).toBeVisible();
});

test('empty installation → find → download → installed; removal requires confirmation',async({page})=>{
  await boot(page,{empty:true});await page.getByRole('button',{name:'Find a model',exact:true}).click();
  await page.getByLabel('Describe your use case').fill('writing');await page.getByRole('button',{name:'Search',exact:true}).click();
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
  await page.getByRole('tab',{name:'Find',exact:true}).click();await page.getByLabel('Describe your use case').fill('coding');
  await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByRole('button',{name:'Download '+catalog[2].name,exact:true}).click();
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

test('selected inspector brings actions into view and history works by keyboard', async({page})=>{
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
  await page.getByRole('button',{name:'History',exact:true}).click();
  const conversation=page.getByRole('button',{name:'Open New trial',exact:true});
  await conversation.focus();await page.keyboard.press('Enter');
  await expect(conversation).toHaveAttribute('aria-pressed','true');
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
    await page.getByLabel('Describe your use case').fill('coding');
    await page.getByRole('button',{name:'Search',exact:true}).click();
    await expect(page.getByRole('button',{name:'Inspect '+catalog[0].name,exact:true})).toBeVisible();
    await capture('find');
    await nav(page,'Try & history').click();await capture('try');
  });
}
