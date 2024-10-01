import {Foundry} from '../src/index.js';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';

test('Accounts', async T => {

	await T.test('find admin wallet', async () => {
		let foundry = await Foundry.launch({infoLog: false});
		after(() => foundry.shutdown());
		assert.equal(foundry.wallets.admin, foundry.requireWallet('admin'));
		assert.equal(foundry.wallets.admin, await foundry.ensureWallet('admin'));
	});
	
	await T.test('create named wallet', async () => {
		let foundry = await Foundry.launch({infoLog: false});
		after(() => foundry.shutdown());
		let w = await foundry.ensureWallet('raffy');
		assert(await foundry.provider.getBalance(w.address) > 0);
	});

	await T.test('create random wallet', async () => {
		let foundry = await Foundry.launch({infoLog: false});
		after(() => foundry.shutdown());
		let a = await foundry.createWallet();
		let b = await foundry.createWallet();
		assert.equal(a.toString(), 'random1');
		assert.equal(b.toString(), 'random2');
		assert.notEqual(a.address, b.address);
		assert(await foundry.provider.getBalance(a.address) > 0);
		assert(await foundry.provider.getBalance(b.address) > 0);
	});

	await T.test('wallet w/1 ether', async () => {
		let foundry = await Foundry.launch({infoLog: false});
		after(() => foundry.shutdown());
		let w = await foundry.createWallet({ether: 1});
		assert(await foundry.provider.getBalance(w.address) === BigInt(1e18));
	});

	await T.test('wallet w/0 ether', async () => {
		let foundry = await Foundry.launch({infoLog: false});
		after(() => foundry.shutdown());
		let w = await foundry.createWallet({ether: 0});
		assert(await foundry.provider.getBalance(w.address) === 0n);
	});

	await T.test('wallet name', async () => {
		let foundry = await Foundry.launch({infoLog: false});
		after(() => foundry.shutdown());
		const name = 'raffy';
		let w = await foundry.ensureWallet(name);
		assert(w.toString(), name);
	});

	await T.test('wallet owner', async () => {
		let foundry = await Foundry.launch({infoLog: false});
		after(() => foundry.shutdown());
		let w = await foundry.createWallet();
		assert(Foundry.of(w), foundry);
	});

});

