import {Foundry, mergeABI} from '../src/index.js';

const foundry = await Foundry.launch();

const A = await foundry.deploy({sol: `
	contract A {
		error WTF();
		function test() external view {
			revert WTF();
		}
	}
`});
function code(name) {
	return `
		interface A { 
			function test() external view;
		}
		contract ${name} {
			A immutable _a;
			constructor(A a) {
				_a = a;
			}
			function test() external view {
				_a.test();
			}
		}
	`;
}

const things = [
	A,
	await foundry.deploy({
		sol: code('Off'), 
		args: [A],
		parseAllErrors: false
	}),
	await foundry.deploy({
		sol: code('On'), 
		args: [A],
		parseAllErrors: true
	}),
	await foundry.deploy({
		sol: code('MergeWithOff'), 
		args: [A],
		parseAllErrors: false,
		abis: [A.interface]
	}),
	await foundry.deploy({
		sol: code('Default'), 
		args: [A],
	}),
];

for (let x of things) {
	console.log(foundry.pretty(x), await x.test().catch(x => x.message));
}

console.log(mergeABI());
console.log(mergeABI(A, ['function chonk() external']));

await foundry.shutdown();
