import {Foundry} from '../../src/index.js';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {ethers} from 'ethers';

// random name generator
function rng(n) {
	return Math.random()*n|0;
}
function rng_label(n, v) {
	return Array.from({length: n}, () => v[rng(v.length)]).join('');
}
function rng_name(m, n, v) {
	return Array.from({length: m}, () => rng_label(1 + rng(n), v)).join('.');
}

const CHARS = ['🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🍋‍🟩', '#️⃣', ...'abcdef', 'è', '힣', '\u200D'];
const GOOD_ENS = [
	'', // root
	'a', // shortest possible
	'aaa.bb.c', // code example
	...Array.from({length: 100}, () => rng_name(1 + rng(5), 5, CHARS))
].map(ens => ({name: ens || '<empty>', ens, dns: dns_encoded_from(ens)}));
// note: ethers.dnsEncode() both normalizes and doesn't accept empty string

const LABEL_WITH_STOP = ethers.toUtf8Bytes('\x03a.b\x00');
const BAD_DNS = [
	Uint8Array.of(),
	Uint8Array.of(2),
	Uint8Array.of(0, 0),
	Uint8Array.of(1, 0),
	LABEL_WITH_STOP,
];
BAD_DNS.forEach(v => assert.throws(() => labels_from_dns_encoded(v))); 

test('ENSDNS', async T => {
	let foundry = await Foundry.launch();
	after(() => foundry.shutdown());
	let contract = await foundry.deploy({file: 'ENSDNSTest'});
	await T.test('dnsDecode: good', async TT => {
		for (let {name, ens, dns} of GOOD_ENS) {	
			await TT.test(name, async () => assert.equal(await contract.dnsDecode(dns), ens));
		}
	});
	await T.test('dnsDecodeUnsafe: good', async TT => {
		for (let {name, ens, dns} of GOOD_ENS) {	
			await TT.test(name, async () => assert.equal(await contract.dnsDecodeUnsafe(dns), ens));
		}
	});
	await T.test('dnsDecode: bad', async TT => {
		for (let v of BAD_DNS) {
			await TT.test(ethers.hexlify(v), async () => assert.rejects(contract.dnsDecode(v)));
		}
	});
	await T.test('dnsDecodeUnsafe: label w/stop', async () => {
		assert.equal(await contract.dnsDecodeUnsafe(LABEL_WITH_STOP), 'a.b');
	});
	await T.test('dnsEncode: good', async TT => {
		for (let {name, ens, dns} of GOOD_ENS) {
			await TT.test(name, async () => assert.deepEqual(ethers.getBytes(await contract.dnsEncode(ens)), dns));
		}
	});
});

// https://github.com/adraffy/ens-normalize.js/blob/fa1b1998923ebaf5fdc6d523e09df769a51d4062/test/resolver.html#L5105
function labels_from_dns_encoded(v) {
	let labels = [];
	let pos = 0;
	while (true) {
		let n = v[pos++];
		if (!n) { // empty
			if (pos !== v.length) break; // must be last
			return labels;
		}
		if (v.length < pos+n) break; // overflow
		let label = ethers.toUtf8String(v.subarray(pos, pos += n));
		if (label.includes('.')) break;
		labels.push(label);
	}
	throw new Error('invalid DNS-encoded name');
}
function dns_encoded_from(labels) {
	if (typeof labels === 'string') {
		labels = labels ? labels.split('.') : [];
	}
	const MAX_LABEL = 255;
	let v = [];
	for (let label of labels) {
		if (!label) throw new Error('invalid empty label');
		let u = ethers.toUtf8Bytes(label);
		if (u.length > MAX_LABEL) throw new Error(`too long: ${u.length} > ${MAX_LABEL}`);
		v.push(u.length, ...u);
	}
	v.push(0);
	return Uint8Array.from(v);
}
