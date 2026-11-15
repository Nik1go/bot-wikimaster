import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionCursor, locateCollectionCursor, cardIdentity } from '../src/collection-cursor.mjs';

const card=n=>({title:`Carte ${n}`,rarity:'PC',stats:[String(n),String(n+1)]});
class Pile {
  constructor(cards,size=5) { this.cards=cards; this.size=size; this.number=1; this.visited=[]; }
  async readPage() { return {number:this.number,totalPages:Math.max(1,Math.ceil(this.cards.length/this.size)),cards:this.cards.slice((this.number-1)*this.size,this.number*this.size)}; }
  async goToPage(n) {
    if(n<1||n>Math.max(1,Math.ceil(this.cards.length/this.size))) throw Object.assign(new Error('Page disparue'),{code:'collection_changed'});
    this.number=n; this.visited.push(this.number);
  }
  async cursor(position) {
    await this.goToPage(Math.floor(position/this.size)+1);
    return collectionCursor(await this.readPage(),position%this.size,this.cards.slice(Math.max(0,Math.floor(position/this.size)*this.size-8),Math.floor(position/this.size)*this.size));
  }
}
const foundCard=found=>found.page.cards[found.index];

test('13 nouvelles cartes : retrouve le même repère plusieurs pages plus loin',async()=>{
  const pile=new Pile(Array.from({length:30},(_,i)=>card(i)));
  const cursor=await pile.cursor(8);
  pile.cards.unshift(...Array.from({length:13},(_,i)=>card(100+i))); await pile.goToPage(1);
  const found=await locateCollectionCursor(pile,cursor);
  assert.equal(cardIdentity(foundCard(found)),cardIdentity(card(8)));
  assert.equal(found.page.number,5); assert.equal(found.index,1); assert.equal(found.lost,false);
});

test('ventes avant la position et retour de la carte suivante en tête : poursuit sur sa voisine restée en place',async()=>{
  const pile=new Pile(Array.from({length:30},(_,i)=>card(i)));
  const cursor=await pile.cursor(10);
  pile.cards=[card(11),...pile.cards.filter(c=>!Array.from({length:7},(_,i)=>`Carte ${i}`).concat('Carte 10','Carte 11').includes(c.title))];
  await pile.goToPage(1);
  const found=await locateCollectionCursor(pile,cursor);
  assert.equal(foundCard(found).title,'Carte 12'); assert.equal(found.skipped,2); assert.equal(found.lost,false);
});

test('carte à traiter supprimée en fin de page : repart après les dernières cartes traitées',async()=>{
  const pile=new Pile(Array.from({length:15},(_,i)=>card(i)));
  const cursor=await pile.cursor(4);
  pile.cards= pile.cards.filter(c=>c.title!=='Carte 4'); await pile.goToPage(1);
  const found=await locateCollectionCursor(pile,cursor);
  assert.equal(foundCard(found).title,'Carte 5'); assert.equal(found.lost,false);
});

test('le nombre de pages est identique malgré un grand décalage : recherche plus loin que la page mémorisée',async()=>{
  const pile=new Pile(Array.from({length:200},(_,i)=>card(i)));
  const cursor=await pile.cursor(100);
  pile.cards=[...Array.from({length:75},(_,i)=>card(1000+i)),...pile.cards.slice(0,125)]; await pile.goToPage(1);
  const found=await locateCollectionCursor(pile,cursor);
  // A checkpoint at a page boundary may locate the end of the preceding page.
  const next=foundCard(found) ?? pile.cards[found.page.number*pile.size];
  assert.equal(next.title,'Carte 100'); assert.equal(found.lost,false);
});

test('tous les repères disparus : fallback explicitement approximatif',async()=>{
  const pile=new Pile(Array.from({length:30},(_,i)=>card(i)));
  const cursor=await pile.cursor(10);
  pile.cards=Array.from({length:9},(_,i)=>card(100+i)); await pile.goToPage(1);
  const found=await locateCollectionCursor(pile,cursor);
  assert.equal(found.lost,true); assert.equal(found.approximate,true);
});

test('doublons strictement identiques : ne promet pas une identité certaine',async()=>{
  const pile=new Pile(Array.from({length:30},()=>card(1)));
  const cursor=await pile.cursor(10);
  pile.cards.unshift(card(1)); await pile.goToPage(1);
  const found=await locateCollectionCursor(pile,cursor);
  assert.equal(found.approximate,true); assert.equal(found.lost,false);
});

test('nouvel achat pendant la recherche : revalide le résultat avant d’accepter sa position',async()=>{
  const pile=new Pile(Array.from({length:30},(_,i)=>card(i)));
  const cursor=await pile.cursor(8); await pile.goToPage(1);
  const go=pile.goToPage.bind(pile); let visits=0;
  pile.goToPage=async n=>{
    if(n===2 && ++visits===2) pile.cards.unshift(card(100),card(101),card(102));
    await go(n);
  };
  const found=await locateCollectionCursor(pile,cursor);
  assert.equal(foundCard(found).title,'Carte 8'); assert.equal(found.lost,false);
});
