import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acquireCollectionLock, readCollectionLock, clearCollectionLock } from '../src/collection-lock.mjs';
import { runCollectionCommand } from '../src/collection-cli.mjs';

const fixture=()=>mkdtemp(path.join(process.env.TEST_TMPDIR || os.tmpdir(),'wiki-lock-'));
test('verrou local : un seul propriétaire et libération vérifiée', async()=>{
  const dir=await fixture();
  const lock=await acquireCollectionLock(dir,{command:'collection-scan'});
  const before=await readCollectionLock(dir);
  await assert.rejects(acquireCollectionLock(dir,{command:'collection-login'}),{code:'collection_locked'});
  assert.deepEqual(await readCollectionLock(dir),before);
  await lock.release(); await lock.release();
  assert.equal((await readCollectionLock(dir)).exists,false);
});
test('ancien verrou sans flock : pas de récupération automatique', async()=>{
  const dir=await fixture(), file=path.join(dir,'collection.lock');
  const original=JSON.stringify({pid:123,command:'collection-run',at:'2026-11-15T10:00:00Z'});
  await writeFile(file,original);
  await assert.rejects(acquireCollectionLock(dir,{command:'collection-run',flockHeld:true}),{code:'collection_locked'});
  assert.equal(await readFile(file,'utf8'),original);
});
test('ancienne métadonnée flock récupérée uniquement après acquisition du verrou système', async()=>{
  const dir=await fixture(), file=path.join(dir,'collection.lock'), events=[];
  await writeFile(file,JSON.stringify({backend:'flock',ownerId:'previous',pid:123,command:'collection-run'}));
  await assert.rejects(acquireCollectionLock(dir,{command:'collection-run'}),{code:'collection_locked'});
  const lock=await acquireCollectionLock(dir,{command:'collection-run',flockHeld:true,log:async(event)=>events.push(event)});
  assert.equal((await readCollectionLock(dir)).backend,'flock');
  assert.notEqual((await readCollectionLock(dir)).ownerId,'previous');
  assert.deepEqual(events,['collection_lock_recovered']);
  await lock.release();
});
test('une ancienne instance ne retire pas le verrou d’une autre instance', async()=>{
  const dir=await fixture();
  const lock=await acquireCollectionLock(dir,{command:'collection-run'});
  await writeFile(path.join(dir,'collection.lock'),JSON.stringify({backend:'file',ownerId:'replacement'}));
  await lock.release();
  assert.equal((await readCollectionLock(dir)).ownerId,'replacement');
});
test('déverrouillage : distingue fichier retiré, absent et format illisible', async()=>{
  const dir=await fixture();
  assert.equal((await clearCollectionLock(dir)).removed,false);
  await writeFile(path.join(dir,'collection.lock'),'interrupted');
  assert.equal((await readCollectionLock(dir)).readable,false);
  const result=await clearCollectionLock(dir);
  assert.equal(result.removed,true); assert.equal(result.previous.readable,false);
  assert.equal((await readCollectionLock(dir)).exists,false);
});
test('resume répété ne laisse aucun verrou et conserve la progression', async()=>{
  const dir=await fixture(), env={DATA_DIR:dir};
  const { createState }=await import('../src/state.mjs');
  const state=await createState(path.join(dir,'collection','simulation'));
  await state.put('progress',{position:17});
  for(let i=0;i<5;i++) {
    await state.put('paused',{code:'test'});
    assert.equal(await runCollectionCommand('collection-resume',[],env),0);
    assert.equal((await readCollectionLock(dir)).exists,false);
  }
  assert.deepEqual(await state.get('progress'),{position:17});
});
