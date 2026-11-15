// Docker/Linux-only lifecycle regression. Uses an isolated temporary directory,
// a paused scan and no account, no site requests or browser authentication.
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createState } from '../src/state.mjs';
import { readCollectionLock } from '../src/collection-lock.mjs';

if(process.platform!=='linux') throw new Error('Ce test doit être lancé dans le conteneur Linux.');
const exec=promisify(execFile);
const dir=await mkdtemp(path.join(os.tmpdir(),'collection-lifecycle-'));
const store=await createState(path.join(dir,'collection','simulation'));
await store.put('paused',{code:'test_pause',message:'Pause fictive du test de démarrage.'});
await store.put('progress',{position:17});
await writeFile(path.join(dir,'session-marker'),'session fictive conservée');
const env={...process.env,DATA_DIR:dir,COLLECTION_APPLY:'false',DISPLAY:':107'};
const processes=[];
function start(mode='collection-run') {
  const process=spawn('/app/entrypoint.sh',[mode],{env,detached:true,stdio:['ignore','pipe','pipe']});
  const run={process,stdout:'',stderr:'',done:once(process,'close')};
  process.stdout.on('data',data=>run.stdout+=data);
  process.stderr.on('data',data=>run.stderr+=data);
  processes.push(run); return run;
}
async function until(test,message) {
  const end=Date.now()+15_000;
  while(Date.now()<end) { if(await test())return; await sleep(50); }
  throw new Error(message);
}
async function stop(run,signal='SIGTERM') {
  if(run.process.exitCode!==null||run.process.signalCode!==null)return;
  if(signal==='SIGKILL') process.kill(-run.process.pid,signal);
  else run.process.kill(signal);
  await Promise.race([run.done,sleep(10_000).then(()=>{throw new Error('Le processus ne se ferme pas.');})]);
}
const control=(mode,...args)=>exec('/app/entrypoint.sh',[mode,...args],{env,timeout:15_000,maxBuffer:1024*1024});
let phase='initial start';
try {
  const first=start();
  await until(()=>first.stdout.includes('collection_paused'),'Le service fictif ne devient pas prêt.');
  assert.equal((await readCollectionLock(dir)).backend,'flock');
  phase='active lock blocks maintenance';
  const original=await readFile(path.join(dir,'collection.lock'),'utf8');
  await assert.rejects(control('collection-unlock','--stopped'),error=>error.stdout.includes('collection_locked'));
  assert.equal(await readFile(path.join(dir,'collection.lock'),'utf8'),original);
  const status=JSON.parse((await control('collection-status')).stdout);
  assert.equal(status.lock.exists,true); assert.equal(status.lock.backend,'flock');
  // A second service waits without starting a second desktop or browser.
  const blocked=start();
  await until(()=>blocked.stdout.includes('collection_locked'),'Le second service ne signale pas son attente.');
  await sleep(250); assert.equal(blocked.process.exitCode,null);
  assert.equal(blocked.stdout.includes('collection_browser'),false);
  phase='stop waiting service';
  await stop(blocked);
  // Simulate a killed container: all its processes disappear but metadata stays.
  phase='forced kill';
  await stop(first,'SIGKILL');
  assert.equal((await readCollectionLock(dir)).exists,true);
  phase='restart after forced kill';
  const restarted=start();
  await until(()=>restarted.stdout.includes('collection_lock_recovered')&&restarted.stdout.includes('collection_paused'),'La reprise après arrêt brutal ne fonctionne pas.');
  phase='graceful shutdown';
  await stop(restarted);
  assert.equal((await readCollectionLock(dir)).exists,false);
  phase='repeated resume';
  for(let i=0;i<5;i++) {
    await control('collection-resume');
    assert.equal((await readCollectionLock(dir)).exists,false);
  }
  // Existing installations need one explicit migration of the old file lock.
  phase='legacy lock migration';
  await writeFile(path.join(dir,'collection.lock'),JSON.stringify({pid:123,command:'collection-run'}));
  const legacy=start();
  await until(()=>legacy.stdout.includes('collection_locked'),'Le verrou historique n’est pas détecté.');
  await sleep(250); assert.equal(legacy.process.exitCode,null);
  await stop(legacy);
  const unlocked=await control('collection-unlock','--stopped');
  assert.match(unlocked.stdout,/Verrou retiré/);
  assert.equal((await readCollectionLock(dir)).exists,false);
  assert.equal(await readFile(path.join(dir,'session-marker'),'utf8'),'session fictive conservée');
  assert.deepEqual(await store.get('progress'),{position:17});
  assert.equal((await stat(path.join(dir,'collection.guard'))).isFile(),true);
  console.log('OK : cycle Docker — exclusion concurrente, statut disponible, SIGKILL puis reprise, arrêt propre, resume répété, migration ancien verrou, session/progression conservées.');
} catch(error) {
  // Public CI annotation contains only this isolated fictional fixture.
  const details=JSON.stringify({phase,error:error.message,runs:processes.map(run=>({stdout:run.stdout.slice(-1800),stderr:run.stderr.slice(-1000),exitCode:run.process.exitCode,signal:run.process.signalCode}))});
  console.error('::error title=Collection lifecycle::'+details.replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'));
  throw error;
} finally {
  for(const run of processes) { try { await stop(run); } catch { try { process.kill(-run.process.pid,'SIGKILL'); } catch {} } }
}
