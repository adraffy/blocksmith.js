import {Foundry} from '../src/index.js';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';

test('deploy', async () => {
	let foundry = await Foundry.launch();
	after(() => foundry.shutdown());
	// check deploy
	let contract = await foundry.deploy({name: 'Deploy'});
	// check read
	assert.equal(await contract.read(), 1n);
	// check write
	await foundry.confirm(contract.write(2n));
});
