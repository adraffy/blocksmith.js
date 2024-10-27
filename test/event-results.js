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
	const {frag} = await foundry.findEvent('Chonk');
	await foundry.findEvent(frag.format());
	await foundry.findEvent(frag.topicHash);
	await foundry.findEvent(frag);
});

test('getEventResults', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	const contract = await foundry.deploy(`
		contract C {
			event Chonk(uint256 x);
			constructor() {
				emit Chonk(1);
			}
			function f() external {
				emit Chonk(2);
				emit Chonk(3);
			}
		}
	`);
	// from contract
	assert.equal(foundry.getEventResults(contract, 'Chonk')[0].x, 1n);
	// from receipt
	const receipt = await foundry.confirm(contract.f());
	assert.equal(foundry.getEventResults(receipt, 'Chonk')[0].x, 2n);
	assert.equal(foundry.getEventResults(receipt.logs, 'Chonk')[0].x, 2n);
	assert.equal(foundry.getEventResults(receipt, 'Chonk')[1].x, 3n);
	assert.equal(foundry.getEventResults(receipt.logs, 'Chonk')[1].x, 3n);
});
