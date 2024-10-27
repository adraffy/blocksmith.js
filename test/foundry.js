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
	assert.equal(b0 + 1, b1);
});

test('nextBlock blocks=2', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	let b0 = await foundry.provider.getBlockNumber();
	const blocks = 3;
	await foundry.nextBlock({blocks});
	let b1 = await foundry.provider.getBlockNumber();
	assert.equal(b0 + blocks, b1);
});

test('nextBlock sec=1', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	let b0 = await foundry.provider.getBlock('latest');
	const sec = 1; // currently bugged: https://github.com/foundry-rs/foundry/issues/8962
	await foundry.nextBlock({sec});
	let b1 = await foundry.provider.getBlock('latest');
	assert.equal(b0.timestamp + sec, b1.timestamp);
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

test('setStorageBytes: small', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	let contract = await foundry.deploy(`
		contract C {
			bytes v;
			function get() external view returns (bytes memory) {
				return v;
			}
		}
	`);
	const value = ethers.hexlify(ethers.randomBytes(17));
	await foundry.setStorageBytes(contract, 0, value);
	assert.equal(await contract.get(), value);
});

test('setStorageBytes: large', async () => {
	let foundry = await Foundry.launch({infoLog: false});
	after(foundry.shutdown);
	let contract = await foundry.deploy(`
		contract C {
			bytes v;
			function get() external view returns (bytes memory) { 
				return v;
			}
		}
	`);
	const value = ethers.hexlify(ethers.randomBytes(1337));
	await foundry.setStorageBytes(contract, 0, value);
	assert.equal(await contract.get(), value);
});
