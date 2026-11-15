import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCollectionConfig, frenchNumber, rarityCode, decision, scanCollection, pageSignature } from '../src/collection-core.mjs';
import { collectionArguments, runCollectionCommand } from '../src/collection-cli.mjs';
import { CollectionSite } from '../src/collection-site.mjs';
import { PauseError } from '../src/core.mjs';

const config = { ...readCollectionConfig({}), delayMs: 0 };
const card = (title = 'Carte', rarity = 'R') => ({ title, rarity, stats: ['1 234','5 678'] });
function store() {
  const data = new Map(), events = [];
  return { data, events, get: async k => structuredClone(data.get(k) ?? null), put: async (k,v) => data.set(k,structuredClone(v)), remove: async k => data.delete(k), log: async (event,details) => events.push({ event, ...details }) };
}
class Site {
  constructor(pages) { this.pages = pages; this.labels = new Set(); this.checked = []; this.tagCalls = 0; }
  async prepare() { this.number = 1; }
  async readPage() { return { number: this.number, totalPages: this.pages.length, cards: structuredClone(this.pages[this.number-1]) }; }
  async openCard(index) { this.current = `${this.number}:${index}`; this.checked.push(this.current); }
  async readMarket(c) { return { rarity: c.rarity, sales: 81, average: 51 }; }
  async ensureLabel() {
    this.tagCalls++;
    if (this.labels.has(this.current)) return 'already_tagged';
    this.labels.add(this.current);
    if (this.interrupt) { this.interrupt = false; throw new Error('interrupted after confirmed write'); }
    return 'tagged';
  }
  async closeCard() {}
  async nextPage(n) { this.number = n; }
  async goToPage(n) { this.number = n; }
  async recoverCard(n) { this.number = Math.min(n,this.pages.length); }
}
const options = { sleep: async () => {} };

test('seuils stricts, rareté contrôlée et nombres français', () => {
  assert.equal(frenchNumber('1\u202f234,50'),1234.5);
  for (const bad of ['—','NaN','50 WB','1.234,50','']) assert.throws(() => frenchNumber(bad));
  assert.equal(rarityCode('Peu commun'),'PC');
  assert.equal(rarityCode('Rare'),'R');
  assert.equal(rarityCode('Ultra Rare'),'UR');
  assert.equal(decision(card(),{rarity:'R',sales:81,average:51},config).eligible,true);
  assert.equal(decision(card(),{rarity:'R',sales:200,average:50},config).eligible,false);
  assert.equal(decision(card(),{rarity:'R',sales:80,average:500},config).eligible,false);
  assert.equal(decision(card(),{rarity:'R',sales:0,average:null},config).reason,'no_sales');
  assert.throws(() => decision(card(),{rarity:'PC',sales:200,average:999},config),{code:'market_rarity_mismatch'});
  assert.throws(() => decision(card(),{rarity:'R',sales:81.5,average:999},config),{code:'market_stats_invalid'});
  assert.throws(() => decision(card('X','UR'),{rarity:'UR',sales:200,average:999},config),{code:'rarity_out_of_scope'});
});
test('configuration et arguments invalides refusés avant navigateur', () => {
  for (const env of [{COLLECTION_APPLY:'yes'},{COLLECTION_MIN_SALES:'-1'},{COLLECTION_DELAY_SECONDS:'0'},{COLLECTION_TIMEOUT_SECONDS:'Infinity'}]) assert.throws(()=>readCollectionConfig(env));
  assert.equal(collectionArguments('collection-scan',['--apply','--limit','3'],{}).limit,3);
  assert.throws(()=>collectionArguments('collection-scan',['--limit','0'],{}));
  assert.throws(()=>collectionArguments('collection-run',['--limit','1'],{}));
  assert.throws(()=>collectionArguments('collection-scan',['--aply'],{}));
});
test('raretés configurables dans env, validation et ciblage effectif', () => {
  assert.deepEqual(readCollectionConfig({}).rarities,['C','PC','R']);
  const custom=readCollectionConfig({COLLECTION_MIN_AVERAGE:'120',COLLECTION_MIN_SALES:'100',COLLECTION_RARITIES:' r, ur, L '});
  assert.deepEqual(custom.rarities,['L','R','UR']);
  assert.equal(custom.minAverage,120); assert.equal(custom.minSales,100);
  for (const value of ['', 'R,', 'R,R', 'ZZ', 'C PC']) assert.throws(()=>readCollectionConfig({COLLECTION_RARITIES:value}));
  assert.equal(decision(card('X','UR'),{rarity:'UR',sales:101,average:121},custom).eligible,true);
  assert.throws(()=>decision(card('X','PC'),{rarity:'PC',sales:101,average:121},custom),{code:'rarity_out_of_scope'});
});
test('simulation : pagination complète et aucun étiquetage', async () => {
  const site = new Site([[card('A','PC'),card('B','C')],[card('C')]]), state = store();
  const result = await scanCollection(site,config,state,options);
  assert.equal(result.complete,true);
  assert.equal(result.totals.checked,3);
  assert.equal(site.tagCalls,0);
  assert.equal(state.events.filter(e=>e.action==='would_tag').length,3);
});
test('doublons physiques traités individuellement, limite puis reprise exacte', async () => {
  const site = new Site([[card(),card()],[card('A','PC')]]), state = store();
  const apply = { ...config, apply: true };
  await scanCollection(site,apply,state,{...options,limit:1});
  assert.deepEqual([...site.labels],['1:0']);
  const result = await scanCollection(site,apply,state,options);
  assert.equal(result.totals.checked,3);
  assert.equal(site.labels.size,3);
  assert.deepEqual(site.checked,['1:0','1:1','2:0']);
});
test('interruption après écriture : reprise idempotente et carte suivante seulement après confirmation', async () => {
  const site = new Site([[card(),card()]]), state = store(), apply = { ...config, apply: true };
  site.interrupt = true;
  await assert.rejects(scanCollection(site,apply,state,options));
  assert.equal(state.data.get('progress').pages[1].done,0);
  assert.equal(site.labels.size,1);
  const result = await scanCollection(site,apply,state,options);
  assert.equal(site.labels.size,2);
  assert.equal(result.totals.alreadyTagged,1);
});
test('page modifiée avant reprise : retrouve la carte et ignore les nouvelles du haut', async () => {
  const site = new Site([[card('A'),card('B')]]), state = store();
  await scanCollection(site,config,state,{...options,limit:1});
  site.pages[0].unshift(card('Nouveau'));
  const result = await scanCollection(site,config,state,options);
  assert.equal(result.totals.checked,2);
  assert.equal(result.totals.changes,1); assert.equal(result.approximate,true);
  assert.deepEqual(site.checked,['1:0','1:2']);
  assert.equal(state.events.filter(e=>e.event==='collection_changed').length,1);
});
test('changement de seuil refusé, étiquettes exclues de la signature de page', async () => {
  const site = new Site([[card(),card()]]), state = store();
  await scanCollection(site,config,state,{...options,limit:1});
  await assert.rejects(scanCollection(site,{...config,minAverage:99},state,options),{code:'scan_policy_changed'});
  assert.equal(pageSignature([card()]),pageSignature([{...card(),labels:['à vendre']} ]));
});
test('ancienne progression C/PC/R conservée à la mise à jour', async () => {
  const site=new Site([[card(),card()]]), state=store();
  await scanCollection(site,config,state,{...options,limit:1});
  const saved=await state.get('progress');
  const old=JSON.parse(saved.policy); delete old.rarities; saved.policy=JSON.stringify(old);
  await state.put('progress',saved);
  const result=await scanCollection(site,config,state,options);
  assert.equal(result.totals.checked,2); assert.deepEqual(site.checked,['1:0','1:1']);
});
test('changement de rareté exige un nouveau parcours', async () => {
  const site=new Site([[card(),card()]]), state=store();
  await scanCollection(site,config,state,{...options,limit:1});
  await assert.rejects(scanCollection(site,{...config,rarities:['R']},state,options),{code:'scan_policy_changed'});
});

test('ancien tri par rareté : exige fresh avant de changer l’ordre de parcours', async () => {
  const site=new Site([[card('A'),card('B')]]), state=store();
  await scanCollection(site,config,state,{...options,limit:1});
  const saved=await state.get('progress'); const policy=JSON.parse(saved.policy); delete policy.sort;
  saved.policy=JSON.stringify(policy); await state.put('progress',saved);
  await assert.rejects(scanCollection(site,config,state,options),{code:'scan_policy_changed'});
  const result=await scanCollection(site,config,state,{...options,fresh:true});
  assert.equal(result.complete,true); assert.equal(result.totals.checked,2);
});
test('données du mauvais marché : carte ignorée, erreur conservée et parcours terminé', async () => {
  const site = new Site([[card()]]), state = store();
  site.readMarket = async()=>({rarity:'PC',sales:200,average:999});
  const result = await scanCollection(site,{...config,apply:true},state,options);
  assert.equal(site.tagCalls,0);
  assert.equal(result.pages[1].done,1); assert.equal(result.totals.errors,1); assert.equal(result.complete,true);
  assert.equal(state.events.find(e=>e.event==='collection_card_error').code,'market_rarity_mismatch');
});

test('Corey sans marché SR : saute cette carte puis étiquette la SR suivante, sans répéter à la reprise', async () => {
  const site = new Site([[card('Corey Sevier','SR'),card('Broad Peak','SR')]]), state = store();
  const cfg = {...config,apply:true,rarities:['SR']};
  site.readMarket = async c => {
    if (c.title==='Corey Sevier') throw new PauseError('market_rarity_missing','Le marché ne propose pas la rareté SR.');
    return {rarity:'SR',average:100,sales:181};
  };
  const first = await scanCollection(site,cfg,state,{...options,limit:1});
  assert.equal(first.totals.errors,1); assert.equal(first.pages[1].done,1); assert.equal(site.tagCalls,0);
  const result = await scanCollection(site,cfg,state,options);
  assert.equal(result.complete,true); assert.equal(result.totals.errors,1); assert.equal(result.totals.tagged,1);
  assert.deepEqual(site.checked,['1:0','1:1']); assert.deepEqual([...site.labels],['1:1']);
});

test('reprise directe sur la dernière page visitée, malgré des ajouts sur une page précédente', async () => {
  const site = new Site([[card('A')],[card('B'),card('C')],[card('D')]]), state = store();
  await scanCollection(site,config,state,{...options,limit:2});
  const saved = await state.get('progress'); delete saved.cursor; await state.put('progress',saved);
  site.pages[0].unshift(card('Ajout'));
  const result = await scanCollection(site,config,state,options);
  assert.equal(result.complete,true); assert.equal(result.totals.checked,4);
  assert.deepEqual(site.checked,['1:0','2:0','2:1','3:0']);
});

test('ajout en cours de page : relit les cartes à la position courante et garde le bon marché', async () => {
  const site = new Site([[card('A'),card('B')]]), state = store();
  const read = site.readMarket.bind(site);
  site.readMarket = async c => {
    const market = await read(c);
    if (c.title==='A' && site.pages[0].length===2) site.pages[0].unshift(card('Ajout'));
    return market;
  };
  const result = await scanCollection(site,config,state,options);
  assert.equal(result.complete,true); assert.equal(result.totals.checked,2); assert.ok(result.totals.changes>=1);
  assert.deepEqual(site.checked,['1:0','1:2']);
});

test('achat ou vente au changement de page : retrouve la dernière carte traitée avant de poursuivre', async () => {
  for (const bought of [true,false]) {
    const site=new Site([[card('A'),card('B')],[card('C'),card('D')],[card('E')]]), state=store(), titles=[];
    const open=site.openCard.bind(site), next=site.nextPage.bind(site); let changed=false;
    site.openCard=async(index,c,...args)=>{titles.push(c.title);return open(index,c,...args);};
    site.nextPage=async n=>{
      if(!changed) {
        changed=true; const pile=site.pages.flat();
        if(bought) pile.unshift(card('Nouvelle')); else pile.shift();
        site.pages=[]; for(let i=0;i<pile.length;i+=2)site.pages.push(pile.slice(i,i+2));
      }
      await next(n);
    };
    const result=await scanCollection(site,config,state,options);
    assert.equal(result.complete,true); assert.equal(result.totals.checked,5);
    assert.deepEqual(titles,['A','B','C','D','E']);
  }
});

test('suppression de pages avant reprise : position ramenée à la dernière page existante', async () => {
  const site = new Site([[card('A')],[card('B')],[card('C'),card('D')]]), state = store();
  await scanCollection(site,config,state,{...options,limit:3});
  site.pages.pop(); site.pages[1]=[card('E')];
  const result = await scanCollection(site,config,state,options);
  assert.equal(result.complete,true); assert.equal(result.cursor.page,2); assert.ok(result.totals.changes>=1);
});

test('pagination modifiée pendant Suivant : recharge et continue ou termine si la dernière page a disparu', async () => {
  for (const removed of [false,true]) {
    const site = new Site([[card('A')],[card('B')]]), state = store();
    site.nextPage = async () => {
      if (removed) site.pages.pop();
      throw new PauseError('pagination_blocked','Bouton Suivant indisponible');
    };
    const result = await scanCollection(site,config,state,options);
    assert.equal(result.complete,true); assert.equal(result.totals.checked,removed?1:2);
    assert.ok(result.totals.changes>=1);
  }
});

test('étiquette non confirmée : consigne une erreur, sans second clic, puis continue', async () => {
  const site = new Site([[card('A'),card('B')]]), state = store();
  site.ensureLabel = async () => { site.tagCalls++; throw new PauseError('label_unconfirmed','Étiquette absente après rechargement.'); };
  const result = await scanCollection(site,{...config,apply:true},state,options);
  assert.equal(result.complete,true); assert.equal(result.totals.errors,2); assert.equal(result.totals.tagged,0); assert.equal(site.tagCalls,2);
});

test('erreurs globales et échec de récupération : arrêt sans avancer ni avaler les erreurs', async () => {
  for (const code of ['login_required','access_denied','rate_limited','human_verification_required','network_error','browser_closed','rarity_filter_invalid']) {
    const site = new Site([[card(),card('B')]]), state = store();
    site.readMarket = async () => { throw new PauseError(code,'Erreur globale'); };
    await assert.rejects(scanCollection(site,{...config,apply:true},state,options),{code});
    assert.equal((await state.get('progress')).pages[1].done,0); assert.equal(site.tagCalls,0);
  }
  const site = new Site([[card()]]), state = store();
  site.readMarket = async () => { throw new PauseError('market_rarity_missing','SR absent'); };
  site.recoverCard = async () => { throw new PauseError('login_required','Session expirée'); };
  await assert.rejects(scanCollection(site,config,state,options),{code:'login_required'});
  assert.equal((await state.get('progress')).pages[1].done,0);
  assert.equal((await state.get('current')).code,'market_rarity_missing');
});

test('délai UI sur une carte : récupération puis passage à la suivante', async () => {
  const site = new Site([[card('A'),card('B')]]), state = store();
  const open = site.openCard.bind(site);
  site.openCard = async (index,...args) => {
    if(index===0) throw Object.assign(new Error('Bouton introuvable'),{name:'TimeoutError'});
    return open(index,...args);
  };
  const result = await scanCollection(site,{...config,apply:true},state,options);
  assert.equal(result.complete,true); assert.equal(result.totals.errors,1); assert.equal(result.totals.tagged,1);
  assert.equal(state.events.find(e=>e.event==='collection_card_error').code,'ui_timeout');
});

test('rapport : cartes à revoir et changements du parcours courant, sans écraser les cartes déplacées', async () => {
  const dir = await mkdtemp(path.join(process.env.TEST_TMPDIR || os.tmpdir(),'wiki-collection-report-'));
  const { createState } = await import('../src/state.mjs');
  const state = await createState(path.join(dir,'collection','simulation'));
  await state.put('progress',{startedAt:'2026-02-01T00:00:00Z',totals:{errors:1,changes:1},approximate:true,complete:true});
  const events = [
    {at:'2026-01-01T00:00:00Z',event:'collection_card_error',title:'Ancien parcours'},
    {event:'collection_card_error',title:'Corey Sevier',rarity:'SR',code:'market_rarity_missing',reason:'SR absente'},
    {event:'collection_changed',page:2,message:'Page modifiée'},
    {event:'collection_result',page:1,index:1,title:'A',rarity:'PC',eligible:true},
    {event:'collection_result',page:1,index:1,title:'B',rarity:'PC',eligible:true},
  ].map(event=>({at:'2026-02-02T00:00:00Z',...event}));
  await appendFile(path.join(state.dir,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  const original = console.log, lines=[];
  try {
    console.log = line=>lines.push(line);
    assert.equal(await runCollectionCommand('collection-report',[],{DATA_DIR:dir}),0);
  } finally { console.log=original; }
  const report=JSON.parse(lines[0]);
  assert.equal(report.errors.length,1); assert.equal(report.errors[0].title,'Corey Sevier');
  assert.equal(report.changes.length,1); assert.equal(report.candidates.length,2); assert.equal(report.approximate,true);
});
test('arrêt du processus vérifié avant ouverture', async () => {
  const site = new Site([[card()]]), state = store(), abort = new AbortController();
  abort.abort();
  await assert.rejects(scanCollection(site,config,state,{...options,signal:abort.signal}),{name:'AbortError'});
  assert.equal(site.checked.length,0);
});
test('simulation : le pilote refuse aussi un ajout direct', async () => {
  const page = new EventEmitter(); page.setDefaultTimeout = ()=>{};
  const site = new CollectionSite(page,config,{sleep:async()=>{},log:async()=>{}});
  await assert.rejects(site.ensureLabel(card(),'à vendre'),{code:'apply_disabled'});
  site.dispose();
});
test('réponses 401/403/429/500 ou refus JSON interrompent le pilote', async () => {
  for (const status of [401,403,429,500,200]) {
    const page = new EventEmitter();
    page.setDefaultTimeout = ()=>{};
    const site = new CollectionSite(page,config,{sleep:async()=>{},log:async()=>{}});
    page.emit('response',{url:()=> 'https://www.wiki-masters.com/api/mock-label',status:()=>status,ok:()=>status===200,request:()=>({method:()=> 'POST'}),json:async()=>({error:'refused'})});
    await assert.rejects(site.healthy());
    assert.equal(site.writes,0);
    site.dispose();
  }
});
test('pause persistante et commandes état/reprise sans navigateur', async () => {
  const dir = await mkdtemp(path.join(process.env.TEST_TMPDIR || os.tmpdir(),'wiki-collection-'));
  const { createState } = await import('../src/state.mjs');
  const state = await createState(path.join(dir,'collection','simulation'));
  await state.put('paused',{code:'rate_limited',message:'HTTP 429 : pause test.'});
  const env = { DATA_DIR:dir };
  assert.equal(await runCollectionCommand('collection-scan',[],env),1);
  assert.equal(await runCollectionCommand('collection-status',[],env),0);
  assert.equal(await runCollectionCommand('collection-resume',[],env),0);
  assert.equal(await state.get('paused'),null);
});

test('resume --fresh prépare un nouveau parcours sans ouvrir le navigateur ni toucher à la session', async () => {
  const dir = await mkdtemp(path.join(process.env.TEST_TMPDIR || os.tmpdir(),'wiki-collection-fresh-'));
  const { createState } = await import('../src/state.mjs');
  const root = await createState(dir);
  const apply = await createState(path.join(dir,'collection','apply'));
  const simulation = await createState(path.join(dir,'collection','simulation'));
  await root.put('browser-profile','manual-session');
  const saved = { startedAt:'2026-01-01T00:00:00Z', totals:{checked:4}, complete:false };
  await apply.put('progress',saved); await simulation.put('progress',saved);
  await apply.put('current',{page:1,index:5}); await apply.put('paused',{code:'collection_changed'});
  const env = {DATA_DIR:dir,COLLECTION_APPLY:'true'};
  const runtime = {launchContext:()=>{throw new Error('Aucun navigateur attendu pour la maintenance.');}};
  assert.equal(await runCollectionCommand('collection-resume',[],env,runtime),0);
  assert.deepEqual(await apply.get('progress'),saved);
  assert.equal(await runCollectionCommand('collection-resume',['--fresh'],env,runtime),0);
  for (const key of ['progress','current','paused']) assert.equal(await apply.get(key),null);
  assert.deepEqual(await simulation.get('progress'),saved);
  assert.equal(await root.get('browser-profile'),'manual-session');
  assert.equal(await runCollectionCommand('collection-resume',['--fresh'],env,runtime),0);
});
