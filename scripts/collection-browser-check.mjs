// Local-only integration check. The fake website deliberately offers multiple
// rarities and duplicate copies. No account, cookies or WikiMasters requests.
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CollectionSite } from '../src/collection-site.mjs';
import { scanCollection, readCollectionConfig, pageSignature } from '../src/collection-core.mjs';

const { chromium } = await import(process.env.COLLECTION_TEST_PLAYWRIGHT || 'playwright');
const cards = [
  { title:'Même carte', rarity:'PC', stats:['1 234','5 678'] },
  { title:'Même carte', rarity:'PC', stats:['1 234','5 678'] },
  { title:'Limite 50', rarity:'R', stats:['1 234','5 678'] },
  { title:'Sans vente', rarity:'C', stats:['1 234','5 678'] },
  { title:'Sergio Gómez', rarity:'R', stats:['5 068','4 048'], average:12, sales:25 },
  { title:'Limite 80 ventes', rarity:'PC', stats:['1 234','5 678'], average:60, sales:80 },
  { title:'Corey Sevier', rarity:'SR', stats:['1 234','5 678'], unavailableMarket:true },
  { title:'Broad Peak', rarity:'SR', stats:['6 363','6 039'], average:100, sales:181 },
];
cards.forEach((card,index)=>card.fixtureId=index);
const labels = new Set();
let writes = 0, refusal = false, selectionMode = 'exclusive', headingMismatch = false, loginRequired=false, labelEndpoint='/collection', persistWrites=true;
const handleRequest = async(req,res)=>{
  if (loginRequired && req.url==='/collection' && req.method==='GET') { res.writeHead(302,{location:'/login'}); res.end(); return; }
  if (req.method==='OPTIONS') {
    res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-methods':'POST','access-control-allow-headers':'content-type'});
    res.end(); return;
  }
  if (req.method==='POST' && ['/api/mock-label','/collection'].includes(req.url)) {
    let raw=''; for await (const part of req) raw += part;
    const { index } = JSON.parse(raw);
    res.writeHead(refusal ? 429 : 200,{'content-type':'application/json','access-control-allow-origin':'*'});
    if (!refusal) { if(persistWrites)labels.add(index); writes++; }
    res.end(JSON.stringify(refusal ? {error:'rate limit'} : {ok:true})); return;
  }
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
  res.end(String.raw`<!doctype html><html><body><main>
  <h1>Collection</h1><input placeholder="Rechercher par titre ou catégorie...">
  <button aria-label="Filtrer par étiquette">Toutes les étiquettes</button>
  <button id="sortButton" aria-label="Trier la collection" onclick="document.getElementById('sort').hidden=false">Rareté</button>
  <div id="sort" hidden><button role="option" onclick="document.getElementById('sortButton').textContent=this.textContent;this.parentElement.hidden=true">Date d'ajout</button></div>
  <div id="filters"></div><div id="grid"></div><div id="pager"></div></main><div id="detail"></div>
  <script>
  const cards=${JSON.stringify(cards)}; const saved=new Set(${JSON.stringify([...labels])});
  const selectionMode=${JSON.stringify(selectionMode)};
  const headingMismatch=${JSON.stringify(headingMismatch)};
  const labelEndpoint=${JSON.stringify(labelEndpoint)};
  const names={Toutes:'Toutes',C:'Commun',PC:'Peu commun',R:'Rare',SR:'Super Rare',UR:'Ultra Rare',L:'Légendaire'};
  let page=1, active=null, selected=new Set(), market=false, rarities=new Set(['R']);
  const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  function renderGrid(){
    const visible=cards.map((card,index)=>({card,index})).filter(({card})=>selected.size===0||selected.has(card.rarity));
    const totalPages=Math.max(1,Math.ceil(visible.length/2));
    if(page>totalPages)page=1;
    document.getElementById('filters').innerHTML=['L','UR','SR','R','PC','C'].map(r=>'<button class="'+(selected.has(r)?'ring-2':'')+'" onclick="filter(\''+r+'\')">'+r+'</button>').join('')+(selected.size?'<button onclick="selected.clear();renderGrid()">Réinitialiser rareté</button>':'');
    document.getElementById('grid').innerHTML=visible.slice((page-1)*2,page*2).map(({card:c,index})=>'<div class="cursor-pointer"><img src="/rarity/rare.webp"><div>'+c.rarity+'</div><div><h3 onclick="openCard('+index+')">'+esc(c.title)+'</h3><span class="font-bold">1 234</span><span class="font-bold">5 678</span></div></div>').join('')||(visible.length?'':'Aucune carte');
    document.getElementById('pager').innerHTML=totalPages>1?'<button onclick="jumpForm()">Page '+page+' / '+totalPages+'</button><button '+(page===totalPages?'disabled':'')+' onclick="page++;renderGrid()">Suivant →</button>':'';
  }
  function jumpForm(){document.getElementById('pager').innerHTML='<input type="number" aria-label="Aller à la page" value="'+page+'" onkeydown="jump(event,this.value)">';}
  function jump(event,value){if(event.key==='Enter'){page=Number(value);renderGrid();}}
  function filter(r){ selected.has(r)?selected.delete(r):selected.add(r);renderGrid(); }
  function openCard(i){active=i;market=false;rarities=new Set([selectionMode==='exclusive'?'Toutes':'R']);renderModal();}
  function renderModal(){
    const c=cards[active]; const name=names[c.rarity];
    let content='';
    if(market){
      if(c.rarity==='C') content="<h3>10 dernières ventes</h3><p>Aucune vente pour l'instant.</p>";
      else {
        content=(selectionMode==='exclusive'?['Toutes','C','PC','R','SR','UR','L']:['R','PC','SR']).filter(r=>!c.unavailableMarket||r!==c.rarity).map(r=>'<button aria-pressed="'+rarities.has(r)+'" onclick="toggle(\''+r+'\')">'+names[r]+'</button>').join('');
        const sole=rarities.size===1?[...rarities][0]:null;
        const avg=sole===c.rarity && c.average!=null?c.average:sole==='PC'?'60':c.rarity==='R'?'50':'999';
        const heading=sole?names[sole]:'Rare, Peu commun';
        content+='<h3>Évolution des prix</h3><div><p>Ventes</p><p>'+(c.sales??81)+'</p></div><div><p>Moyenne</p><p>'+avg+'</p></div><h3>10 dernières ventes · '+(headingMismatch?'Super Rare':heading)+'</h3>';
      }
    }else content='<p>Étiquettes</p>'+(saved.has(c.fixtureId)?'<button aria-label="Retirer l\'étiquette à vendre">×</button>':'')+'<input role="combobox" oninput="options()"><ul role="listbox" hidden><li role="option"><button onclick="tag()">'+(saved.size?'à vendre':'Créer à vendre')+'</button></li></ul>';
    document.getElementById('detail').innerHTML='<div class="card-frame"><button aria-label="Fermer" onclick="document.getElementById(\'detail\').innerHTML=\'\'">Fermer</button><div><h2>'+esc(c.title)+'</h2><div><span>'+name+'</span><div role="tablist"><button role="tab" onclick="market=false;renderModal()">Détails</button><button role="tab" onclick="market=true;renderModal()">Marché</button></div></div></div>'+content+'</div>';
  }
  function toggle(r){if(selectionMode==='exclusive')rarities=new Set([r]);else rarities.has(r)?rarities.delete(r):rarities.add(r);renderModal();}
  function options(){document.querySelector('[role=listbox]').hidden=false;}
  async function tag(){const index=cards[active].fixtureId;saved.add(index);renderModal();await fetch(labelEndpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({index})});}
  renderGrid();
  </script></body></html>`);
};
const server=createServer(handleRequest), backend=createServer(handleRequest);
server.listen(0,'127.0.0.1'); await once(server,'listening');
backend.listen(0,'127.0.0.1'); await once(backend,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
const backendOrigin=`http://127.0.0.1:${backend.address().port}`;
const browser = await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.COLLECTION_TEST_EXECUTABLE ? {executablePath:process.env.COLLECTION_TEST_EXECUTABLE} : {})});
const state=()=>{const data=new Map(),events=[];return {events,get:async k=>structuredClone(data.get(k)??null),put:async(k,v)=>data.set(k,structuredClone(v)),remove:async k=>data.delete(k),log:async(event,details)=>events.push({event,...details})};};
try {
  const cliDir=await mkdtemp(path.join(process.env.TEST_TMPDIR||os.tmpdir(),'collection-cli-browser-'));
  const childFile=fileURLToPath(new URL('./collection-cli-check-child.mjs',import.meta.url));
  const execute=promisify(execFile);
  const runCli=(args,command='collection-scan')=>execute(process.execPath,[childFile,command,cliDir,origin,...args],{env:process.env,windowsHide:true,timeout:30_000,maxBuffer:1024*1024});
  const firstCli=await runCli(['--dry-run','--fresh','--limit','1']);
  assert.match(firstCli.stdout,/collection_limit/);
  assert.doesNotMatch(firstCli.stderr,/unsettled top-level await/);
  const nextCli=await runCli(['--dry-run','--limit','1']);
  assert.match(nextCli.stdout,/collection_limit/);
  assert.equal(JSON.parse(await readFile(path.join(cliDir,'collection','simulation','state','progress.json'),'utf8')).totals.checked,2);
  await assert.rejects(stat(path.join(cliDir,'collection.lock')),{code:'ENOENT'});
  const taggedCli=await runCli(['--apply','--fresh','--limit','1']);
  assert.match(taggedCli.stdout,/collection_label_verified/);
  assert.equal(labels.has(0),true);
  await assert.rejects(stat(path.join(cliDir,'collection.lock')),{code:'ENOENT'});
  loginRequired=true;
  await assert.rejects(runCli(['--dry-run','--limit','1']),error=>error.code===1&&/collection_paused/.test(error.stdout)&&/collection_browser_closed/.test(error.stdout)&&!/unsettled top-level await/.test(error.stderr));
  assert.equal(JSON.parse(await readFile(path.join(cliDir,'collection','simulation','state','progress.json'),'utf8')).totals.checked,2);
  await assert.rejects(stat(path.join(cliDir,'collection.lock')),{code:'ENOENT'});
  loginRequired=false;
  await runCli([],'collection-resume');
  if(process.platform==='linux') {
    const service=spawn(process.execPath,[childFile,'collection-run',cliDir,origin],{env:process.env,stdio:['ignore','pipe','pipe']});
    let output='',errors='';
    service.stdout.on('data',chunk=>output+=chunk); service.stderr.on('data',chunk=>errors+=chunk);
    const done=once(service,'close');
    try {
      const end=Date.now()+30_000;
      while(!output.includes('collection_idle')&&service.exitCode===null&&Date.now()<end) await sleep(50);
      assert.match(output,/collection_idle/,'Le service doit rester vivant après la fermeture du navigateur.');
      assert.equal(service.exitCode,null); assert.doesNotMatch(errors,/unsettled top-level await/);
      service.kill('SIGTERM');
      const [code]=await Promise.race([done,sleep(10_000).then(()=>{throw new Error('Le service ne se ferme pas.');})]);
      assert.equal(code,0); await assert.rejects(stat(path.join(cliDir,'collection.lock')),{code:'ENOENT'});
    } finally { if(service.exitCode===null&&service.signalCode===null)service.kill('SIGKILL'); }
  }
  console.log('OK : commande réelle — limite 1, fermeture Chromium, sortie 0, verrou retiré, reprise à la carte suivante.');
  const page=await browser.newPage();
  page.on('pageerror',error=>console.error('Page de test :',error.message));
  const config={...readCollectionConfig({COLLECTION_RARITIES:'C,PC,R,SR'}),delayMs:0,timeoutMs:3000};
  for(labelEndpoint of ['/collection','/api/mock-label',`${backendOrigin}/collection`]) {
  for (selectionMode of ['exclusive','multi']) {
  labels.clear(); writes=0; refusal=false;
  let site=new CollectionSite(page,config,{sleep,log:async()=>{},baseUrl:origin});
  const dryState=state();
  const dry=await scanCollection(site,config,dryState,{sleep});
  assert.equal(dry.totals.checked,8); assert.equal(dry.totals.eligible,3); assert.equal(dry.totals.errors,1); assert.equal(writes,0);
  assert.equal(dryState.events.find(e=>e.event==='collection_card_error').title,'Corey Sevier');
  assert.equal(dryState.events.find(e=>e.event==='collection_card_error').code,'market_rarity_missing');
  site.dispose();
  site=new CollectionSite(page,{...config,apply:true},{sleep,log:async()=>{},baseUrl:origin});
  const real=await scanCollection(site,{...config,apply:true},state(),{sleep});
  assert.equal(real.totals.tagged,3); assert.equal(real.totals.errors,1); assert.deepEqual([...labels],[0,1,7]);
  site.dispose();
  // Server-persisted labels are read after a full navigation; no toggles.
  site=new CollectionSite(page,{...config,apply:true},{sleep,log:async()=>{},baseUrl:origin});
  const repeated=await scanCollection(site,{...config,apply:true},state(),{sleep});
  assert.equal(repeated.totals.alreadyTagged,3); assert.equal(repeated.totals.errors,1); assert.equal(writes,3); site.dispose();
  labels.clear(); refusal=true;
  site=new CollectionSite(page,{...config,apply:true},{sleep,log:async()=>{},baseUrl:origin});
  const failed=state();
  await assert.rejects(scanCollection(site,{...config,apply:true},failed,{sleep}),{code:'rate_limited'});
  assert.equal((await failed.get('progress')).pages[1].done,0); assert.equal(writes,3); site.dispose();
  labels.clear(); refusal=false; headingMismatch=true;
  site=new CollectionSite(page,{...config,apply:true},{sleep,log:async()=>{},baseUrl:origin});
  await site.prepare();
  const unconfirmedPage=await site.readPage();
  await site.openCard(0,unconfirmedPage.cards[0],pageSignature(unconfirmedPage.cards));
  await assert.rejects(site.readMarket(unconfirmedPage.cards[0]),error => error.code==='market_rarity_unconfirmed' && /sélection Peu commun/.test(error.message) && /Super Rare/.test(error.message));
  assert.equal(labels.size,0); assert.equal(writes,3); site.dispose(); headingMismatch=false;
  console.log(`OK : ${labelEndpoint}, filtre ${selectionMode} — Corey sans marché SR ignorée, Broad Peak suivante étiquetée, doublons, simulation, refus HTTP 429 sans nouvelle tentative.`);
  }
  }
  cards.splice(6,2);
  labels.clear(); writes=0; refusal=false; persistWrites=false; selectionMode='exclusive';
  const optimistic=new CollectionSite(page,{...config,apply:true},{sleep,log:async()=>{},baseUrl:origin});
  const optimisticState=state();
  const unpersisted=await scanCollection(optimistic,{...config,apply:true},optimisticState,{sleep});
  assert.equal(unpersisted.complete,true); assert.equal(unpersisted.totals.errors,2); assert.equal(unpersisted.totals.tagged,0);
  assert.equal(labels.size,0); assert.equal(writes,2);
  assert.ok(optimisticState.events.filter(e=>e.event==='collection_card_error').every(e=>e.code==='label_unconfirmed'&&/après rechargement/.test(e.reason)));
  await scanCollection(optimistic,{...config,apply:true},optimisticState,{sleep});
  assert.equal(writes,2); optimistic.dispose(); persistWrites=true;
  console.log('OK : badge non enregistré consigné à revoir ; poursuite sans nouveau clic ni répétition à la reprise.');
  // Real DOM pagination + changed server-side collection between two runs.
  const changedState=state();
  const moving=new CollectionSite(page,config,{sleep,log:async()=>{},baseUrl:origin});
  await scanCollection(moving,config,changedState,{sleep,limit:3});
  cards.unshift({title:'Nouvelle carte après ouverture',rarity:'R',stats:['1 234','5 678'],average:1,sales:10,fixtureId:1000});
  const resumed=await scanCollection(moving,config,changedState,{sleep});
  assert.equal(resumed.complete,true); assert.equal(resumed.approximate,true); assert.ok(resumed.totals.changes>=1);
  assert.equal(resumed.totals.checked,6);
  assert.ok(changedState.events.some(e=>e.event==='collection_cursor_found'&&e.page===3));
  assert.ok(!changedState.events.some(e=>e.event==='collection_card'&&e.title==='Nouvelle carte après ouverture'));
  cards.shift(); moving.dispose();
  console.log('OK : ajout après un arrêt, carte attendue retrouvée page 3 ; nouvelle carte du haut ignorée.');
  const originalCards=cards.slice();
  labels.clear(); writes=0; labelEndpoint='/collection';
  const liveState=state();
  const live=new CollectionSite(page,{...config,apply:true},{sleep,log:async()=>{},baseUrl:origin});
  const readMarket=live.readMarket.bind(live); let added=false;
  live.readMarket=async card=>{
    const market=await readMarket(card);
    if(!added) {
      added=true;
      cards.unshift({title:'Achat pendant le tri',rarity:'R',stats:['1 234','5 678'],average:999,sales:999,fixtureId:1001});
    }
    return market;
  };
  const shifted=await scanCollection(live,{...config,apply:true},liveState,{sleep});
  assert.equal(shifted.complete,true); assert.equal(shifted.totals.checked,6); assert.equal(shifted.totals.tagged,2);
  assert.deepEqual([...labels],[0,1]); assert.equal(writes,2);
  assert.ok(!liveState.events.some(e=>e.event==='collection_card'&&e.title==='Achat pendant le tri'));
  live.dispose(); cards.splice(0,cards.length,...originalCards);
  console.log('OK : achat entre lecture du marché et ajout — carte initiale relue après déplacement, aucune étiquette sur la nouvelle arrivée.');
  const returnState=state();
  const returning=new CollectionSite(page,config,{sleep,log:async()=>{},baseUrl:origin});
  await scanCollection(returning,config,returnState,{sleep,limit:3});
  const returned=cards.find(c=>c.title==='Sans vente');
  cards.splice(0,cards.length,returned,...originalCards.filter(c=>!['Même carte','Sans vente'].includes(c.title)));
  const afterSales=await scanCollection(returning,config,returnState,{sleep});
  assert.equal(afterSales.complete,true);
  const attempted=returnState.events.filter(e=>e.event==='collection_card').map(e=>e.title);
  assert.deepEqual(attempted,['Même carte','Même carte','Limite 50','Sergio Gómez','Limite 80 ventes']);
  returning.dispose(); cards.splice(0,cards.length,...originalCards);
  console.log('OK : ventes avant le repère et retour de la carte attendue en tête — poursuite sur la voisine restée en place.');
  for(const bought of [true,false]) {
    const boundaryState=state();
    const boundary=new CollectionSite(page,config,{sleep,log:async()=>{},baseUrl:origin});
    const next=boundary.nextPage.bind(boundary); let moved=false;
    boundary.nextPage=async number=>{
      if(!moved) {
        moved=true;
        await page.evaluate(bought=>{
          if(bought) cards.unshift({title:'Achat au changement de page',rarity:'R',stats:['1 234','5 678'],average:999,sales:999,fixtureId:2000});
          else cards.shift();
          renderGrid();
        },bought);
      }
      await next(number);
    };
    const result=await scanCollection(boundary,config,boundaryState,{sleep});
    assert.equal(result.complete,true); assert.equal(result.totals.checked,6);
    assert.deepEqual(boundaryState.events.filter(e=>e.event==='collection_card').map(e=>e.title),originalCards.map(c=>c.title));
    boundary.dispose();
  }
  console.log('OK : achat ou vente révélé au changement de page — aucune nouvelle carte traitée ni carte restante sautée.');
  selectionMode='exclusive'; refusal=false; labels.clear(); writes=0;
  for (const rarity of ['R','C','SR','UR','L']) {
    const custom={...readCollectionConfig({COLLECTION_RARITIES:rarity,COLLECTION_MIN_AVERAGE:'70',COLLECTION_MIN_SALES:'80'}),delayMs:0,timeoutMs:3000};
    if (['SR','UR','L'].includes(rarity)) cards.push({title:`Exemple ${rarity}`,rarity,stats:['1 234','5 678'],average:75,sales:90});
    const site=new CollectionSite(page,custom,{sleep,log:async()=>{},baseUrl:origin});
    const result=await scanCollection(site,custom,state(),{sleep});
    assert.equal(result.totals.checked,rarity==='R'?2:1);
    assert.equal(result.totals.eligible,['SR','UR','L'].includes(rarity)?1:0);
    assert.equal(writes,0); site.dispose();
  }
  console.log('OK : réglages env — raretés R/C/SR/UR/L, seuils personnalisés, collection sur une seule page sans pagination.');
} finally { await browser.close(); server.close(); backend.close(); }
