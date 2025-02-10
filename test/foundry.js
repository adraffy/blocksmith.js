import {Foundry} from '../src/index.js';
import {ethers} from 'ethers';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';

test('nextBlock', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	let b0 = await foundry.provider.getBlockNumber();
	await foundry.nextBlock();
	let b1 = await foundry.provider.getBlockNumber();
	assert.equal(b1, b0 + 1);
});

test('nextBlock blocks=2', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	let b0 = await foundry.provider.getBlockNumber();
	const blocks = 3;
	await foundry.nextBlock({blocks});
	let b1 = await foundry.provider.getBlockNumber();
	assert.equal(b1, b0 + blocks);
});

test('nextBlock sec=5', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	const sec = 5;
	let b0 = await foundry.provider.getBlock('latest');
	await foundry.nextBlock({sec});
	let b1 = await foundry.provider.getBlock('latest');
	assert.equal(b1.timestamp, b0.timestamp + sec);
});

test('contract name', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	const name = 'Abc';
	let contract = await foundry.deploy(`contract ${name} {}`);
	assert.equal(contract.__info.contract, name);
	assert.match(contract.toString(), new RegExp(`^${name}<`));
});

test('contract owner', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	let contract = await foundry.deploy(`contract C {}`);
	assert.equal(Foundry.of(contract), foundry);
});

test('setStorageValue', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	let contract = await foundry.deploy(`
		contract C {
			uint256 x;
			function get() external view returns (uint256) {
				return x;
			}
		}
	`);
	const value = BigInt(ethers.hexlify(ethers.randomBytes(32)));
	await foundry.setStorageValue(contract, 0, value);
	assert.equal(await contract.get(), value);
	await foundry.setStorageValue(contract, 0, 0);
	assert.equal(await contract.get(), 0n);
	await foundry.setStorageValue(contract, 0, 0n);
	assert.equal(await contract.get(), 0n);
	await foundry.setStorageValue(contract, 0, '0x00');
	assert.equal(await contract.get(), 0n);
	await foundry.setStorageValue(contract, 0, new Uint8Array(32));
	assert.equal(await contract.get(), 0n);
});

test('storageBytes: small', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	const contract = await foundry.deploy(`
		contract C {
			bytes v;
			function get() external view returns (bytes memory) {
				return v;
			}
		}
	`);
	const SLOT = 0;
	const value = ethers.randomBytes(17);
	await foundry.setStorageBytes(contract, SLOT, value);
	assert.equal(await foundry.getStorageBytesLength(contract, SLOT), BigInt(value.length));
	assert.deepEqual(await foundry.getStorageBytes(contract, SLOT), value);
	assert.equal(await contract.get(), ethers.hexlify(value));
});

test('storageBytes: large', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	const contract = await foundry.deploy(`
		contract C {
			bytes v;
			function get() external view returns (bytes memory) { 
				return v;
			}
		}
	`);
	const SLOT = 0;
	const value = ethers.randomBytes(1337);
	await foundry.setStorageBytes(contract, SLOT, value);
	assert.equal(await foundry.getStorageBytesLength(contract, SLOT), BigInt(value.length));
	assert.deepEqual(await foundry.getStorageBytes(contract, SLOT), value);
	assert.equal(await contract.get(), ethers.hexlify(value));
	await foundry.setStorageBytes(contract, SLOT);
	const slot = BigInt(ethers.solidityPackedKeccak256(['uint256'], [SLOT]));
	assert.equal(BigInt(await foundry.provider.getStorage(contract, slot)), 0n);
});

test('setStorageBytes: unzeroed', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	const contract = await foundry.deploy(`contract C {}`);
	const v = new Uint8Array(32);
	v[31] = 1;
	const SLOT = 0;
	await foundry.setStorageBytes(contract, 0, v);
	await foundry.setStorageBytes(contract, 0, new Uint8Array(0), false);
	const slot = BigInt(ethers.solidityPackedKeccak256(['uint256'], [SLOT]));
	assert.equal(BigInt(await foundry.provider.getStorage(contract, slot)), 1n);
});


test('getStorageBytes: too large', async () => {
	const foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	const contract = await foundry.deploy(`contract C {}`);
	await foundry.setStorageValue(contract, 0, 100000000n);
	await assert.rejects(() => foundry.getStorageBytes(contract, 0));
});

