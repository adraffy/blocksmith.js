import {Foundry} from '../src/index.js';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';

test('forked mainnet', async T => {
	let foundry = await Foundry.launch({fork: 'https://cloudflare-eth.com', infoLog: true});
	after(() => foundry.shutdown());

	const raffy = '0x51050ec063d393217B436747617aD1C2285Aeeee';
	await T.test('raffy.eth', async () => {
		assert.equal(await foundry.provider.resolveName('raffy.eth'), raffy);
	});
	await T.test('onchain wildcard: NFTResolver', async () => {
		assert.equal(await foundry.provider.resolveName('331.moo.nft-owner.eth'), raffy);
	});
	await T.test('offchain wildcard: TheOffchainGateway', async () => {
		assert.equal(await foundry.provider.resolveName('fixed.tog.raffy.eth'), raffy);
	});
})


