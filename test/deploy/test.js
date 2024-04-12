import {Foundry, compile as solc} from '../../src/index.js';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';

test('deploy file', async () => {
	let foundry = await Foundry.launch();
	after(() => foundry.shutdown());
	let contract = await foundry.deploy({file: 'Deploy'});
	assert.equal(await contract.read(), 1n);
	await foundry.confirm(contract.write(2n));
});

test('deploy inline', async () => {
	let foundry = await Foundry.launch();
	after(() => foundry.shutdown());
	let contract = await foundry.deploy({sol: `
		contract Chonk {
			function f() external pure returns (string memory) {
				return 'chonk';
			}
			function g(uint256 a, uint256 b) external pure returns (uint256) {
				return a * 1000 + b;
			}
		}
	`});
	assert.equal(await contract.f(), 'chonk');
	assert.equal(await contract.g(69, 420), 69420n);
});

test('deploy inline w/import', async () => {
	let foundry = await Foundry.launch();
	after(() => foundry.shutdown());
	let contract = await foundry.deploy({sol: `
		import {Deploy} from "@src/deploy/Deploy.sol";
		contract Chonk is Deploy {
		}
	`});
	assert.equal(await contract.read(), 1n);
});

test('solc tagged template', async () => {
	let {bytecode} = solc`
		contract Chonk {
			function f() external pure returns (string memory) {
				return 'chonk';
			}
			function g(uint256 a, uint256 b) external pure returns (uint256) {
				return a * 1000 + b;
			}
		}
	`;
	assert.equal(bytecode.slice(0, 10), '0x60806040');
});
