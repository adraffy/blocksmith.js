import {Foundry} from '../src/index.js';
import {ethers} from 'ethers';
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

test('setStorageValue', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(() => foundry.shutdown());
	let contract = await foundry.deploy({sol: `contract C {
		uint256 x;
		function get() external view returns (uint256) { return x; }
	}`});
	const value = BigInt(ethers.hexlify(ethers.randomBytes(32)));
	await foundry.setStorageValue(contract, 0, value);
	assert(await contract.get(), value);

	await foundry.setStorageValue(contract, 0, 0);
	await foundry.setStorageValue(contract, 0, 0n);
	await foundry.setStorageValue(contract, 0, '0x00');
	await foundry.setStorageValue(contract, 0, new Uint8Array(32));
});

test('setStorageBytes: small', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(() => foundry.shutdown());
	let contract = await foundry.deploy({sol: `contract C {
		bytes v;
		function get() external view returns (bytes memory) { return v; }
	}`});
	const value = ethers.hexlify(ethers.randomBytes(17));
	await foundry.setStorageBytes(contract, 0, value);
	assert(await contract.get(), value);
});

test('setStorageBytes: large', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(() => foundry.shutdown());
	let contract = await foundry.deploy({sol: `contract C {
		bytes v;
		function get() external view returns (bytes memory) { return v; }
	}`});
	const value = ethers.hexlify(ethers.randomBytes(1337));
	await foundry.setStorageBytes(contract, 0, value);
	assert(await contract.get(), value);
});
