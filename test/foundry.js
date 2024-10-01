import {Foundry} from '../src/index.js';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';

// TODO add more shit

test('nextBlock', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(() => foundry.shutdown());
	let b0 = await foundry.provider.getBlockNumber();
	await foundry.nextBlock();
	let b1 = await foundry.provider.getBlockNumber();
	assert(b0 + 1, b1);
});

test('contract name', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(() => foundry.shutdown());
	let contract = await foundry.deploy({
		sol: `contract C {}`
	})
	assert(contract.toString(), 'C');
});

test('contract owner', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(() => foundry.shutdown());
	let contract = await foundry.deploy({
		sol: `contract C {}`
	})
	assert(Foundry.of(contract), foundry);
});
