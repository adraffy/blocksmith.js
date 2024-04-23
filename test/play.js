import {FoundryBase, Foundry} from '../src/index.js';
import {format} from 'node:util';

let profile = FoundryBase.profile();
let root = await FoundryBase.root();
console.log({profile, root});

let base = await FoundryBase.load();
console.log(base);

let f = await Foundry.launch();


f.infoLog("yo");
console.log(await f.build());

// TODO: move this into tests
await assert_silence(f, () => f.deploy({sol: `
	contract F {
	}
`, silent: true}));

await assert_silence(f, async () => {
	let c = await f.deploy({sol: `
		event E();
		contract F {
			function f() external {
				emit E();
			}
		}
	`, silent: true});
	await f.confirm(c.f(), {silent: true});
});

await f.shutdown();

async function assert_silence(foundry, fn) {
	const old = foundry.infoLog;
	try {
		let args;
		f.infoLog = (...a) => args = a;
		await fn();
		if (args) throw new Error(format('silence broken:', ...args));
	} finally {
		foundry.infoLog = old;
	}
}

