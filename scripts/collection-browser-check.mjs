// Local-only integration check. The fake website deliberately offers multiple
// rarities and duplicate copies. No account, cookies or WikiMasters requests.
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { CollectionSite } from '../src/collection-site.mjs';
import { scanCollection, readCollectionConfig } from '../src/collection-core.mjs';

const { chromium } = await import(process.env.COLLECTION_TEST_PLAYWRIGHT || 'playwright');
const cards = [
  { title:'Même carte', rarity:'PC', stats:['1 234','5 678'] },
  { title:'Même carte', rarity:'PC', stats:['1 234','5 678'] },
  { title:'Limite 50', rarity:'R', stats:['1 234','5 678'] },
  { title:'Sans vente', rarity:'C', stats:['1 234','5 678'] },
  { title:'Sergio Gómez', rarity:'R', stats:['5 068','4 048'], average:12, sales:25 },
  { title:'Limite 80 ventes', rarity:'PC', stats:['1 234','5 678'], average:60, sales:80 },
];
const labels = new Set();
let writes = 0, refusal = false, selectionMode = 'exclusive', headingMismatch = false;
const server = createServer(async(req,res)=>{
  if (req.url === '/api/mock-label') {
    let raw=''; for await (const part of req) raw += part;
    const { index } = JSON.parse(raw);
    res.writeHead(refusal ? 429 : 200,{'content-type':'application/json'});
    if (!refusal) { labels.add(index); writes++; }
    res.end(JSON.stringify(refusal ? {error:'rate limit'} : {ok:true})); return;
  }
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
  res.end(String.raw`<!doctype html><html><body><main>
  <h1>Collection</h1><input placeholder="Rechercher par titre ou catégorie...">
  <button aria-label="Filtrer par étiquette">Toutes les étiquettes</button>
  <button aria-label="Trier la collection" onclick="document.getElementById('sort').hidden=false">Rareté</button>
  <div id="sort" hidden><button role="option" onclick="this.parentElement.hidden=true">Rareté</button></div>
  <div id="filters"></div><div id="grid"></div><div id="pager"></div></main><div id="detail"></div>
  <script>
  const cards=${JSON.stringify(cards)}; const saved=new Set(${JSON.stringify([...labels])});
  const selectionMode=${JSON.stringify(selectionMode)};
  const headingMismatch=${JSON.stringify(headingMismatch)};
  let page=1, active=null, selected=new Set(), market=false, rarities=new Set(['R']);
  const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  function renderGrid(){
    document.getElementById('filters').innerHTML=['L','UR','SR','R','PC','C'].map(r=>'<button class="'+(selected.has(r)?'ring-2':'')+'" onclick="filter(\''+r+'\')">'+r+'</button>').join('')+(selected.size?'<button onclick="selected.clear();renderGrid()">Réinitialiser rareté</button>':'');
    document.getElementById('grid').innerHTML=cards.slice((page-1)*2,page*2).map((c,k)=>'<div class="cursor-pointer"><img src="/rarity/rare.webp"><div>'+c.rarity+'</div><div><h3 onclick="openCard('+((page-1)*2+k)+')">'+esc(c.title)+'</h3><span class="font-bold">1 234</span><span class="font-bold">5 678</span></div></div>').join('');
    document.getElementById('pager').innerHTML='<button>Page '+page+' / 3</button><button '+(page===3?'disabled':'')+' onclick="page++;renderGrid()">Suivant →</button>';
  }
  function filter(r){ selected.has(r)?selected.delete(r):selected.add(r);renderGrid(); }
  function openCard(i){active=i;market=false;rarities=new Set([selectionMode==='exclusive'?'Toutes':'R']);renderModal();}
  function renderModal(){
    const c=cards[active]; const name={R:'Rare',PC:'Peu commun',C:'Commun'}[c.rarity];
    let content='';
    if(market){
      if(c.rarity==='C') content="<h3>10 dernières ventes</h3><p>Aucune vente pour l'instant.</p>";
      else {
        content=(selectionMode==='exclusive'?['Toutes','R','PC','SR']:['R','PC']).map(r=>'<button aria-pressed="'+rarities.has(r)+'" onclick="toggle(\''+r+'\')">'+({Toutes:'Toutes',R:'Rare',PC:'Peu commun',SR:'Super Rare'}[r])+'</button>').join('');
        const sole=rarities.size===1?[...rarities][0]:null;
        const avg=sole===c.rarity && c.average!=null?c.average:sole==='PC'?'60':c.rarity==='R'?'50':'999';
        const heading=sole?({Toutes:'Toutes',R:'Rare',PC:'Peu commun',SR:'Super Rare'}[sole]):'Rare, Peu commun';
        content+='<h3>Évolution des prix</h3><div><p>Ventes</p><p>'+(c.sales??81)+'</p></div><div><p>Moyenne</p><p>'+avg+'</p></div><h3>10 dernières ventes · '+(headingMismatch?'Super Rare':heading)+'</h3>';
      }
    }else content='<p>Étiquettes</p>'+(saved.has(active)?'<button aria-label="Retirer l\'étiquette à vendre">×</button>':'')+'<input role="combobox" oninput="options()"><ul role="listbox" hidden><li role="option"><button onclick="tag()">'+(saved.size?'à vendre':'Créer à vendre')+'</button></li></ul>';
    document.getElementById('detail').innerHTML='<div class="card-frame"><button aria-label="Fermer" onclick="document.getElementById(\'detail\').innerHTML=\'\'">Fermer</button><div><h2>'+esc(c.title)+'</h2><div><span>'+name+'</span><div role="tablist"><button role="tab" onclick="market=false;renderModal()">Détails</button><button role="tab" onclick="market=true;renderModal()">Marché</button></div></div></div>'+content+'</div>';
  }
  function toggle(r){if(selectionMode==='exclusive')rarities=new Set([r]);else rarities.has(r)?rarities.delete(r):rarities.add(r);renderModal();}
  function options(){document.querySelector('[role=listbox]').hidden=false;}
  async function tag(){saved.add(active);renderModal();await fetch('/api/mock-label',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({index:active})});}
  renderGrid();
  </script></body></html>`);
});
server.listen(0,'127.0.0.1'); await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.COLLECTION_TEST_EXECUTABLE ? {executablePath:process.env.COLLECTION_TEST_EXECUTABLE} : {})});
const state=()=>{const data=new Map();return {get:async k=>structuredClone(data.get(k)??null),put:async(k,v)=>data.set(k,structuredClone(v)),remove:async k=>data.delete(k),log:async()=>{}};};
try {
  const page=await browser.newPage();
  page.on('pageerror',error=>console.error('Page de test :',error.message));
  const config={...readCollectionConfig({}),delayMs:0,timeoutMs:3000};
  for (selectionMode of ['exclusive','multi']) {
  labels.clear(); writes=0; refusal=false;
  let site=new CollectionSite(page,config,{sleep,log:async()=>{},baseUrl:origin});
  const dry=await scanCollection(site,config,state(),{sleep});
  assert.equal(dry.totals.checked,6); assert.equal(dry.totals.eligible,2); assert.equal(writes,0);
  site.dispose();
  site=new CollectionSite(page,{...config,apply:true},{sleep,log:async()=>{},baseUrl:origin});
  const real=await scanCollection(site,{...config,apply:true},state(),{sleep});
  assert.equal(real.totals.tagged,2); assert.deepEqual([...labels],[0,1]);
  site.dispose();
  // Server-persisted labels are read after a full navigation; no toggles.
  site=new CollectionSite(page,{...config,apply:true},{sleep,log:async()=>{},baseUrl:origin});
  const repeated=await scanCollection(site,{...config,apply:true},state(),{sleep});
  assert.equal(repeated.totals.alreadyTagged,2); assert.equal(writes,2); site.dispose();
  labels.clear(); refusal=true;
  site=new CollectionSite(page,{...config,apply:true},{sleep,log:async()=>{},baseUrl:origin});
  const failed=state();
  await assert.rejects(scanCollection(site,{...config,apply:true},failed,{sleep}),{code:'rate_limited'});
  assert.equal((await failed.get('progress')).pages[1].done,0); assert.equal(writes,2); site.dispose();
  labels.clear(); refusal=false; headingMismatch=true;
  site=new CollectionSite(page,{...config,apply:true},{sleep,log:async()=>{},baseUrl:origin});
  await assert.rejects(scanCollection(site,{...config,apply:true},state(),{sleep}),error => error.code==='market_rarity_unconfirmed' && /sélection Peu commun/.test(error.message) && /Super Rare/.test(error.message));
  assert.equal(labels.size,0); assert.equal(writes,2); site.dispose(); headingMismatch=false;
  console.log(`OK : filtre ${selectionMode} — rareté isolée, doublons, pagination, simulation, étiquettes persistantes, refus HTTP 429 sans nouvelle tentative.`);
  }
} finally { await browser.close(); server.close(); }
