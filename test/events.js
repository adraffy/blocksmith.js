import {Foundry} from '../src/index.js';
import {ethers} from 'ethers';
import {test, after} from 'node:test';
import assert from 'assert/strict';

async function expectEvent(foundry, event, fn) {
	let occurred = false;
	foundry.on(event, () => occurred = true);
	await fn();
	assert(occurred, `expected event: ${event}`);
}

test('event: deploy', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	await expectEvent(foundry, 'deploy', () => foundry.deploy('contract C {}'));
});

test('event: building', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	await expectEvent(foundry, 'building', () => foundry.build(true));
});

test('event: built', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	await expectEvent(foundry, 'built', () => foundry.build(true));
});

test('event: tx', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	const contract = await foundry.deploy(`
		contract C {
			function f() external {
			}
		}
	`);
	await expectEvent(foundry, 'tx', () => foundry.confirm(contract.f()));
});

test('event: console', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	const contract = await foundry.deploy(`
		import "forge-std/console2.sol";
		contract C {
			function f() external {
				console2.log("chonk");
			}
		}
	`);
	await expectEvent(foundry, 'console', () => foundry.confirm(contract.f()));
});

test('event: console view', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	const contract = await foundry.deploy(`
		import "forge-std/console2.sol";
		contract C {
			function f() external pure {
				console2.log("chonk");
			}
		}
	`);
	await expectEvent(foundry, 'console', () => contract.f());
});

test('event: shutdown', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	await expectEvent(foundry, 'shutdown', foundry.shutdown);
});

async function expectSilence(foundry, fn) {
	const old = foundry.infoLog;
	try {
		let silent = true;
		foundry.infoLog = () => silent = false;
		await fn();
		assert(silent);
	} finally {
		foundry.infoLog = old;
	}
}

test('silent: contract', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	await expectSilence(foundry, () => foundry.deploy({
		sol: 'contract C {}', 
		silent: true
	}));
});

test('silent: event', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	const contract = await foundry.deploy(`
		contract C {
			event Chonk();
			function f() external {
				emit Chonk();
			}
		}
	`);
	await expectSilence(foundry, () => foundry.confirm(contract.f(), {silent: true}));
});

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

test('getEventResult', async () => {
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
	assert.equal(foundry.getEventResult(contract, 'Chonk').x, 1n);
	// from receipt
	const receipt = await foundry.confirm(contract.f());
	assert.equal(foundry.getEventResult(receipt, 'Chonk').x, 2n);
	assert.equal(foundry.getEventResult(receipt.logs, 'Chonk').x, 2n);
	// using skip
	assert.equal(foundry.getEventResult(receipt, 'Chonk', 1).x, 3n);
	assert.equal(foundry.getEventResult(receipt.logs, 'Chonk', 1).x, 3n);
});
