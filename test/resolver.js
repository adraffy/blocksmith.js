import {Node} from '../src/Node.js';
import {Resolver} from '../src/Resolver.js';
import {ethers} from 'ethers';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';

const AVATAR = 'https://raffy.antistupid.com/ens.jpg';

const root = Node.root();
const mainnet = new ethers.CloudflareProvider();
const sepolia = new ethers.InfuraProvider(11155111);
const ens = new ethers.Contract('0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', [
	'function resolver(bytes32 node) external view returns (address)',
	'function owner(bytes32 node) external view returns (address)',
], mainnet);

after(() => {
	mainnet.destroy();
	sepolia.destroy();	
});

test('raffy.eth', async T => {
	let node = root.create('raffy.eth');
	let resolver = await Resolver.get(ens, node);
	await T.test('text(avatar)', async () => assert.equal(await resolver.text('avatar'), AVATAR));
	await T.test('addr(60)', async () => assert.equal(await resolver.addr(60), '0x51050ec063d393217b436747617ad1c2285aeeee'));	
});

test('coinbase demo', async T => {
	let node = root.create('eth.coinbase.tog.raffy.eth');
	let resolver = await Resolver.get(ens, node);
	let profile = await resolver.profile();
	console.log({
		name: node.name,
		basename: resolver.base.name,
		resolver: resolver.contract.target,
		info: resolver.info,
		profile
	});
});

// not on mainnet yet
test('TOR lensing', async T => {
	let sep_ens = ens.connect(sepolia);
	let node = root.create('fixed.debug.eth');
	let resolver = await Resolver.get(sep_ens, node);
	await T.test('hybrid', async () => assert.equal(await resolver.text('avatar'), AVATAR));
	await T.test('force off-chain', async () => assert.equal(await resolver.text('avatar', {tor: 'off'}), AVATAR));
	await T.test('force on-chain', async () => assert.equal(await resolver.text('avatar', {tor: 'on', ccip: false}), ''));	
});