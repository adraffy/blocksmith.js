import {Foundry} from '../src/index.js';
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
		import "forge-std/console.sol";
		contract C {
			function f() external {
				console.log("chonk");
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
