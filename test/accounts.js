import {Foundry} from '../src/index.js';
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';

// TODO fix me

test('deploy file', async T => {
	let foundry = await Foundry.launch();
	after(() => foundry.shutdown());
	
	let a = await foundry.ensureWallet('raffy');
	let b = await foundry.ensureWallet('chonk');

	console.log(foundry.pretty([a, b]));
	console.log(a.address);
	console.log(a);
});