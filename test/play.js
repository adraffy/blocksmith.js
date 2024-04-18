import {Foundry} from '../src/index.js';

let f = await Foundry.launch({infoLog: true});
f.infoLog("yo");

await f.ensureBuilt();

await f.shutdown();
