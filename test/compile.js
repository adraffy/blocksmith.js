import {compile} from '../src/index.js';

// TODO: fix me

async function compare(code) {
	console.log(code);
	for (let optimize of [false, 200, 9999]) {
		let artifact = await compile(`contract Test { ${code} }`, {optimize});
		console.log(artifact.deployedByteCount, optimize);
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
