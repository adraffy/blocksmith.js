import {FoundryBase} from '../src/index.js';


let base = await FoundryBase.load();
//console.log(base);


console.log(base.config.evm_version);

console.log(base.config.libs);