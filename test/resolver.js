import {Node} from '../src/Node.js';
import {Resolver} from '../src/Resolver.js';
import {ethers} from 'ethers';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';

test('Resolver', async T => {

	const ADDR = '0x51050ec063d393217b436747617ad1c2285aeeee';
	const AVATAR = 'https://raffy.antistupid.com/ens.jpg';

	const root = Node.root();
	const mainnet = new ethers.CloudflareProvider();
	after(() => mainnet.destroy());

	const sepolia = new ethers.InfuraProvider(11155111);
	after(() => sepolia.destroy());

	const ens = new ethers.Contract('0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', [
		'function resolver(bytes32 node) external view returns (address)',
		'function owner(bytes32 node) external view returns (address)',
	], mainnet);

	await T.test('raffy.eth', async TT => {
		let node = root.create('raffy.eth');
		let resolver = await Resolver.get(ens, node);
		await TT.test('text(avatar)', async () => assert.equal(await resolver.text('avatar'), AVATAR));
		await TT.test('addr(60)', async () => assert.equal(await resolver.addr(60), ADDR));	
	});

	await T.test('coinbase demo', async TT => {
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
	await T.test('TOR lensing', async TT => {
		let sep_ens = ens.connect(sepolia);
		let node = root.create('fixed.debug.eth');
		let resolver = await Resolver.get(sep_ens, node);
		await TT.test('hybrid', async () => assert.equal(await resolver.text('avatar'), AVATAR));
		await TT.test('force off-chain', async () => assert.equal(await resolver.text('avatar', {tor: 'off'}), AVATAR));
		await TT.test('force on-chain', async () => assert.equal(await resolver.text('avatar', {tor: 'on', ccip: false}), ''));	
	});

});
