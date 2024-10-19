import {FoundryBase} from '../src/index.js';

// TODO: fix me

let f = await FoundryBase.load();

console.log(f.tomlConfig());

console.log(f.config);

let temp = {...f};
delete temp.config;
console.log(temp);

console.log(FoundryBase.profile());

console.log(await FoundryBase.root());

console.log(await f.find({file: 'Deploy'}));

console.log(await f.resolveArtifact({file: 'Deploy'}));

console.log(await f.version());

//console.log(await f.exportArtifacts('chonk'));
