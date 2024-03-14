import {test, before, after} from 'node:test';
import {Foundry} from '../src/index.js';
import assert from 'node:assert/strict';

let foundry;
before(async () => {
	foundry = await Foundry.launch({fork: 'https://cloudflare-eth.com', log: true});
	console.log(foundry.info);
});
after(() => foundry.shutdown());

const raffy = '0x51050ec063d393217B436747617aD1C2285Aeeee';
test('raffy.eth', async () => {
	assert.equal(await foundry.provider.resolveName('raffy.eth'), raffy);
});
test('onchain wildcard: NFTResolver', async () => {
	assert.equal(await foundry.provider.resolveName('331.moo.nft-owner.eth'), raffy);
});
test('offchain wildcard: TheOffchainGateway', async () => {
	assert.equal(await foundry.provider.resolveName('fixed.tog.raffy.eth'), raffy);
});
test('deploy and test contract', async () => {
	let demo = await foundry.deploy({file: 'Example'});
	assert.equal(await demo.f(69, 420), 69420n);
});
