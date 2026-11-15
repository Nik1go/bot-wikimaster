// A visible card has no public instance ID. Use its displayed identity together
// with neighbours, rather than treating a page/index as a durable identity.
const clean = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');
export const visibleCard = ({title,rarity,stats}) => ({title,rarity,stats:[...stats]});
export const cardIdentity = card => JSON.stringify([clean(card.title),clean(card.rarity),card.stats.map(clean)]);

export function collectionCursor(page, index, previous = []) {
  return {
    version: 2, page: page.number, index, pageSize: Math.max(page.cards.length,1), totalPages: page.totalPages,
    next: page.cards.slice(index,index+16).map(visibleCard),
    before: [...previous,...page.cards.slice(0,index)].slice(-8).map(visibleCard),
  };
}

function candidates(pages, cursor) {
  const next = cursor.next.map(cardIdentity), before = cursor.before.map(cardIdentity);
  const expectedPosition = (cursor.page - 1 + pages.delta) * cursor.pageSize + cursor.index;
  const options = new Map();
  let block = [], lastPage = 0;
  const evaluate = () => {
    const keys = block.map(p=>cardIdentity(p.card));
    const forward = (position,start) => {
      let matched=0, expected=start;
      while(position<keys.length && expected<next.length) {
        const found=next.indexOf(keys[position],expected);
        if(found<0) break;
        expected=found+1; matched++; position++;
      }
      return matched;
    };
    const backward = (position,end) => {
      let matched=0, expected=end;
      while(position>=0 && expected>=0) {
        const found=before.lastIndexOf(keys[position],expected);
        if(found<0) break;
        expected=found-1; matched++; position--;
      }
      return matched;
    };
    const add = (position,ahead,behind,skipped,anchored=true) => {
      if(!ahead && !behind) return;
      const at=block[position] ?? (block.length ? {...block.at(-1),index:block.at(-1).index+1} : null);
      if(!at) return;
      const key=`${at.page}:${at.index}`;
      // A returned/unsold target can reappear alone at the head. An unchanged
      // predecessor is stronger evidence for the old position than that copy.
      const score=ahead+2*behind;
      const distance=Math.abs((at.page-1)*cursor.pageSize+at.index-expectedPosition);
      const value={page:at.page,index:at.index,score,skipped,distance,anchored};
      const old=options.get(key);
      if(!old || Number(anchored)>Number(old.anchored) || (anchored===old.anchored && (score>old.score || (score===old.score && skipped<old.skipped)))) options.set(key,value);
    };
    for(let i=0;i<keys.length;i++) {
      for(let j=0;j<next.length;j++) if(keys[i]===next[j]) add(i,forward(i,j),backward(i-1,before.length-1),j);
      for(let j=0;j<before.length;j++) if(keys[i]===before[j]) {
        const start=next.indexOf(keys[i+1]);
        add(i+1,start<0?0:forward(i+1,start),backward(i,j),start<0?next.length:start,start>=0||j===before.length-1);
      }
    }
  };
  for(const page of [...pages.cache.values()].sort((a,b)=>a.number-b.number)) {
    if(lastPage && page.number!==lastPage+1) { evaluate(); block=[]; }
    block.push(...page.cards.map((card,index)=>({card,page:page.number,index})));
    lastPage=page.number;
  }
  evaluate();
  const ranked=[...options.values()].sort((a,b)=>Number(b.anchored)-Number(a.anchored) || b.score-a.score || a.skipped-b.skipped || a.distance-b.distance);
  const best=ranked[0];
  if(best) best.ambiguous=ranked.some((other,i)=>i>0 && other.anchored===best.anchored && other.score===best.score && other.skipped===best.skipped);
  return best;
}

export async function locateCollectionCursor(site, cursor, {signal,log=async()=>{},attempt=0}={}) {
  const first=await site.readPage();
  const total=first.totalPages;
  const cache=new Map([[first.number,first]]);
  const delta=total-cursor.totalPages;
  const clamp=n=>Math.max(1,Math.min(total,n));
  const predicted=clamp(cursor.page+delta), original=clamp(cursor.page);
  const go=async number=>{
    for(let retry=0;;retry++) {
      signal?.throwIfAborted();
      const current=await site.readPage();
      try { await site.goToPage(Math.min(number,current.totalPages)); return; }
      catch(error) { if(error.code!=='collection_changed' || retry>=1) throw error; }
    }
  };
  const read=async number=>{
    signal?.throwIfAborted();
    const current=await site.readPage();
    const target=Math.min(number,current.totalPages);
    if(cache.has(target)) return;
    await go(target);
    const page=await site.readPage();
    cache.set(page.number,page);
    if(cache.size%20===0) await log('collection_locating',{message:`Recherche du repère de reprise : ${cache.size}/${total} pages lues.`,pagesRead:cache.size});
  };
  // New fetches go to the head of the pile. Page-count changes give a cheap
  // first estimate, while the old page covers deletions later in the pile.
  for(const number of new Set([predicted,original,predicted-1,predicted+1,original-1,original+1].filter(n=>n>=1&&n<=total))) await read(number);
  let found=candidates({cache,delta},cursor);
  const unique=new Set([...cursor.next,...cursor.before].map(cardIdentity)).size;
  const enough=()=>found?.anchored && found.score>=Math.min(3,cursor.next.length+cursor.before.length);
  if(!enough() && unique>1) {
    for(let number=1;number<=total;number++) {
      await read(number);
      found=candidates({cache,delta},cursor);
      if(enough()) break;
    }
  }
  if(found) {
    await go(found.page);
    const page=await site.readPage();
    const old=cache.get(found.page);
    const identityAt=(cards,index)=>cards[index] ? cardIdentity(cards[index]) : null;
    const stable=page.number===found.page && identityAt(old.cards,found.index)===identityAt(page.cards,found.index) && identityAt(old.cards,found.index-1)===identityAt(page.cards,found.index-1);
    if(!stable && attempt<2) return locateCollectionCursor(site,cursor,{signal,log,attempt:attempt+1});
    if(!stable) return {page,index:Math.min(found.index,page.cards.length),approximate:true,lost:true,skipped:cursor.next.length};
    if(found.index>page.cards.length) return {page,index:page.cards.length,approximate:true,lost:true,skipped:cursor.next.length};
    return {page,index:found.index,previous:cache.get(page.number-1)?.cards.slice(-8) ?? [],approximate:found.ambiguous || !enough() || (unique===1 && cursor.next.length+cursor.before.length>1),lost:false,skipped:found.skipped};
  }
  // If the entire remembered neighbourhood was sold, continue approximately
  // rather than stopping a 10K-card job. Never call an unknown match exact.
  await go(original);
  const page=await site.readPage();
  return {page,index:Math.min(cursor.index,page.cards.length),approximate:true,lost:true,skipped:cursor.next.length};
}
