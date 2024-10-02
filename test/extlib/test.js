import {Foundry} from '../../src/index.js';

let foundry = await Foundry.launch();

let ExtLib = await foundry.deploy({
	file: 'ExtLib'
});

let contract = await foundry.deploy({
	file: 'ExtLibTester',
	libs: { ExtLib }
});

console.log(await contract.chonk());

let contract2 = await foundry.deploy({
	sol: `
		import {ExtLib} from "@test/extlib/ExtLib.sol";
		contract X {
			function chonk() external pure returns (uint256) {
				return ExtLib.chonk();
			}
		}
	`,
	libs: { ExtLib }
});

console.log(await contract2.chonk());

console.log(contract2.__info.linked);

foundry.shutdown();
