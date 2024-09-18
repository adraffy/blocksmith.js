import {Foundry} from '../src/index.js';

let foundry = await Foundry.launch();

// 20240917: this works as expected
// unclear how github ci was creating forge/$output subdirectories

await foundry.deploy({file: 'A'});
await foundry.deploy({file: 'a/A'});
await foundry.deploy({file: 'b/A'});

await foundry.shutdown();
