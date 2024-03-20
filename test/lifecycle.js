import {Foundry} from '../src/index.js';

// check for leaks
for (let i = 0; i < 1000; i++) {
	let f = await Foundry.launch({infoLog: false});
	await f.shutdown();
	console.log(i);
}
