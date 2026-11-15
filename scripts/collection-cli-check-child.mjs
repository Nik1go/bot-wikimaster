// Test boundary for the full command lifecycle. Only the browser executable,
// display mode and the local fixture origin differ from production.
import { chromium } from 'playwright';
import { runCollectionCommand } from '../src/collection-cli.mjs';
import { CollectionSite } from '../src/collection-site.mjs';
const [command, dataDir, origin, ...args] = process.argv.slice(2);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Origine de test locale requise.');
const env={...process.env,DATA_DIR:dataDir,COLLECTION_APPLY:'false',COLLECTION_MIN_AVERAGE:'50',COLLECTION_MIN_SALES:'80',COLLECTION_RARITIES:'C,PC,R',COLLECTION_DELAY_SECONDS:'1',COLLECTION_TIMEOUT_SECONDS:'5'};
process.exitCode=await runCollectionCommand(command,args,env,{
  launchContext:(profile,options)=>chromium.launchPersistentContext(profile,{...options,headless:true,...(process.env.COLLECTION_TEST_EXECUTABLE?{executablePath:process.env.COLLECTION_TEST_EXECUTABLE}:{})}),
  createSite:(page,config,io)=>new CollectionSite(page,config,{...io,baseUrl:origin}),
});
