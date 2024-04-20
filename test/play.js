import {FoundryBase, Foundry} from '../src/index.js';

let profile = FoundryBase.profile();
let root = await FoundryBase.root();
console.log({profile, root});

let base = await FoundryBase.load();
console.log(base);

let f = await Foundry.launch({infoLog: true});
f.infoLog("yo");
console.log(await f.build());
await f.shutdown();
