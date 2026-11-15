import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const config=JSON.parse(execFileSync('docker',['compose','-f','compose.yaml','-f','compose.collection.yaml','--profile','collection','config','--format','json'],{encoding:'utf8',windowsHide:true}));
const base=config.services['wiki-bot'], collection=config.services['wiki-collection'];
assert.ok(base.image,'Une image commune explicite est nécessaire.');
assert.equal(collection.image,base.image,'Maintenance et parcours doivent utiliser la même image.');
assert.equal(collection.volumes.find(v=>v.target==='/data').source,base.volumes.find(v=>v.target==='/data').source,'Maintenance et parcours doivent partager le volume de connexion.');
assert.equal(collection.environment.DATA_DIR,base.environment.DATA_DIR);
console.log('OK : même image et même volume pour le parcours et les commandes de maintenance.');
