import {Foundry} from '../../src/index.js';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('all known labels', async T => {

	let foundry = await Foundry.launch({infiniteCallGas: true});
	after(() => foundry.shutdown());

	let labels = await fetch('https://adraffy.github.io/ens-labels/labels.json').then(r => r.json());
	//let labels = JSON.parse(readFileSync(new URL('../../../ens-labels/labels.json', import.meta.url)));
	console.log(`Labels: ${labels.length}`);

	let bigs = [];
	let names = [];
	let temp = [];
	function add() {
		names.push(temp.join('.'));
		temp.length = 0;
	}
	for (let x of labels) {
		let n = Buffer.from(x).length;
		if (n > 255) {
			bigs.push([n, x]);
		} else {
			temp.push(x);
			if (Math.random() < 0.2) add();
		}
	}
	if (temp.length) add();
	bigs.sort((a, b) => a[0] - b[0]);
	console.log(`Bigs: ${bigs.length}`);
	console.log(`Names: ${names.length}`);

	let contract = await foundry.deploy({file: 'ENSDNSTest'});

	// names that are too big should return empty
	for (let [n, x] of bigs) {
		await T.test(`too big: ${n}`, async () => assert.equal(await contract.dnsEncode(x), '0x'));
	}

	//  valid names should roundtrip
	for (let i = 0, n = 500; i < names.length; ) {
		let e = Math.min(i + n, names.length);
		await T.test(`${(e/names.length*100).toFixed(1).padStart(5)}% [${i},${e})`, async () => await contract.multicheck(names.slice(i, e)));
		i = e;
	}

});