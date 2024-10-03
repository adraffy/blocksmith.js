import {compile} from '../src/index.js';

// TODO: fix me

function deployedByteCount(bytecode) {
	let pos = bytecode.indexOf('6080604', 4); // this is dogshit
	return (bytecode.length - pos) >> 1;
}

async function compare(code) {
	console.log(code);
	for (let optimize of [false, 200, 9999]) {
		let {bytecode} = await compile(`contract Test { ${code} }`, {optimize});
		console.log(deployedByteCount(bytecode), bytecode.length, optimize);
	}
}

await compare(`
	uint256 sum;
	constructor() {
		for (uint256 i = 0; i < 10; i++) {
			sum += i;
		}
	}
`);

await compare(`
	uint256 sum;
	function f() external pure returns (bytes32) {
		return keccak256("chonk");
	}
`);


console.log('\n[evm version]');
console.log((await compile(`contract C {}`, {evmVersion: 'cancun'})).bytecode);
console.log((await compile(`contract C {}`, {evmVersion: 'london'})).bytecode);


console.log('\n[solc version]');
console.log((await compile(`contract C {}`, {solcVersion: '0.8.23'})).bytecode);
console.log((await compile(`contract C {}`, {solcVersion: '0.8.26'})).bytecode);


console.log('\n[via-ir]');
console.log((await compile(`contract C {}`, {viaIR: false})).bytecode);
console.log((await compile(`contract C {}`, {viaIR: true})).bytecode);
