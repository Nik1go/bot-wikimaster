import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCollectionConfig, frenchNumber, rarityCode, decision, scanCollection, pageSignature } from '../src/collection-core.mjs';
import { collectionArguments, runCollectionCommand } from '../src/collection-cli.mjs';
import { CollectionSite } from '../src/collection-site.mjs';

const config = { ...readCollectionConfig({}), delayMs: 0 };
const card = (title = 'Carte', rarity = 'R') => ({ title, rarity, stats: ['1 234','5 678'] });
function store() {
  const data = new Map(), events = [];
  return { data, events, get: async k => structuredClone(data.get(k) ?? null), put: async (k,v) => data.set(k,structuredClone(v)), remove: async k => data.delete(k), log: async (event,details) => events.push({ event, ...details }) };
}
class Site {
  constructor(pages) { this.pages = pages; this.labels = new Set(); this.checked = []; this.tagCalls = 0; }
  async prepare() { this.number = 1; }
  async readPage() { return { number: this.number, totalPages: this.pages.length, cards: this.pages[this.number-1] }; }
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
}
const options = { sleep: async () => {} };

test('seuils stricts, rareté contrôlée et nombres français', () => {
  assert.equal(frenchNumber('1\u202f234,50'),1234.5);
  for (const bad of ['—','NaN','50 WB','1.234,50','']) assert.throws(() => frenchNumber(bad));
  assert.equal(rarityCode('Peu commun'),'PC');
  assert.equal(rarityCode('Rare'),'R');
  assert.equal(rarityCode('Ultra Rare'),null);
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
test('page modifiée avant reprise : arrêt, puis nouveau parcours explicite', async () => {
  const site = new Site([[card(),card()]]), state = store();
  await scanCollection(site,config,state,{...options,limit:1});
  site.pages[0].unshift(card('Nouveau'));
  await assert.rejects(scanCollection(site,config,state,options),{code:'collection_changed'});
  const result = await scanCollection(site,config,state,{...options,fresh:true});
  assert.equal(result.totals.checked,3);
});
test('changement de seuil refusé, étiquettes exclues de la signature de page', async () => {
  const site = new Site([[card(),card()]]), state = store();
  await scanCollection(site,config,state,{...options,limit:1});
  await assert.rejects(scanCollection(site,{...config,minAverage:99},state,options),{code:'scan_policy_changed'});
  assert.equal(pageSignature([card()]),pageSignature([{...card(),labels:['à vendre']} ]));
});
test('données du mauvais marché : aucune étiquette et progression inchangée', async () => {
  const site = new Site([[card()]]), state = store();
  site.readMarket = async()=>({rarity:'PC',sales:200,average:999});
  await assert.rejects(scanCollection(site,{...config,apply:true},state,options),{code:'market_rarity_mismatch'});
  assert.equal(site.tagCalls,0);
  assert.equal(state.data.get('progress').pages[1].done,0);
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
