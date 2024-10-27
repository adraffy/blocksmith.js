import {Foundry} from '../src/index.js';
import {test, after} from 'node:test';
import assert from 'assert/strict';

test('findEvent', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	await foundry.deploy(`
		contract C {
			event Chonk(uint256 x);
		}
	`);
	const {frag} = foundry.findEvent('Chonk');
	foundry.findEvent(frag.format());
	foundry.findEvent(frag.topicHash);
	foundry.findEvent(frag);
});

test('findEvent: duplicates', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	for (let i = 0; i < 5; i++) {
		await foundry.deploy(`contract C { event Chonk(uint256 x); }`);
	}
	await foundry.findEvent('Chonk');
});

test('findEvent: missing', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	assert.throws(() => foundry.findEvent('Chonk'));
});

test('findEvent: conflict', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	await foundry.deploy(`contract C { event Chonk(uint256 x); }`);
	await foundry.deploy(`contract C { event Chonk(uint256 x, uint256 y); }`);
	assert.throws(() => foundry.findEvent('Chonk'));
});

test('getEventResults: contract', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	const contract = await foundry.deploy(`
		contract C {
			event Chonk(uint256 x);
			constructor() {
				emit Chonk(1);
			}
		}
	`);
	const [{x}] = foundry.getEventResults(contract, 'Chonk');
	assert.equal(x, 1n);
});

test('getEventResults: receipt', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	const contract = await foundry.deploy(`
		contract C {
			event Chonk(uint256 x);
			function f() external {
				emit Chonk(2);
				emit Chonk(3);
			}
		}
	`);
	const [{x: x1}, {x: x2}] = foundry.getEventResults(await foundry.confirm(contract.f()), 'Chonk');
	assert.equal(x1, 2n);
	assert.equal(x2, 3n);
});

