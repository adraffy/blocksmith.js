import {Foundry} from '../src/index.js';
import {test, after} from 'node:test';
import assert from 'assert/strict';

test('ethereum/paris', async () => {
	const foundry = await Foundry.launch({
		infoLog: false,
		hardfork: 'PARIS'
	});
	after(foundry.shutdown);
	assert.equal(foundry.backend, 'ethereum');
	assert.equal(foundry.hardfork, 'paris');
});

test('optimism/ecotone', async () => {
	const foundry = await Foundry.launch({
		infoLog: false,
		backend: 'optimism',
		hardfork: 'ecotone'
	});
	after(foundry.shutdown);
	assert(foundry.backend === 'optimism');
	assert(foundry.hardfork === 'ecotone');
});

test('backend: unknown', async () => {
	assert.rejects(() => Foundry.launch({
		backend: 'chonk'
	}));
});

test('hardfork: unknown', async () => {
	assert.rejects(() => Foundry.launch({
		hardfork: 'chonk'
	}));
});

test('hardfork: empty', async () => {
	assert.rejects(() => Foundry.launch({
		hardfork: ''
	}));
});
