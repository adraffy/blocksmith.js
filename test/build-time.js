import {Foundry} from '../src/index.js';

const foundry = await Foundry.launch();

foundry.on('building', console.log);
foundry.on('built', x => console.log(Date.now() - x.started, x.sources));

await foundry.build(false);

await foundry.shutdown();
