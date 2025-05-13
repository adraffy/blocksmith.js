import { Foundry, compile } from "../../src/index.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";

async function F() {
	const foundry = await Foundry.launch({infoLog: true});
	after(foundry.shutdown);
	return foundry;
}

test("deploy file", async () => {
	const foundry = await F();
	const contract = await foundry.deploy({ file: "Deploy" });
	assert.equal(await contract.read(), 1n);
	await foundry.confirm(contract.write(2n));
});

test("deploy inline", async () => {
	const foundry = await F();
	const contract = await foundry.deploy({
		sol: `
			contract Chonk {
				function f() external pure returns (string memory) {
					return 'chonk';
				}
				function g(uint256 a, uint256 b) external pure returns (uint256) {
					return a * 1000 + b;
				}
			}
		`,
	});
	assert.equal(await contract.f(), "chonk");
	assert.equal(await contract.g(69, 420), 69420n);
});

test("deploy inline w/interface", async () => {
	const foundry = await F();
	await foundry.deploy({
		sol: `
			interface X {
				function f() external view returns (uint256);	
			}
			contract Y is X {
				function f() external view returns (uint256) {
					return 1;
				}
			}
	`,
	});
});

test("deploy w/inline import", async () => {
	const foundry = await F();
	const contract = await foundry.deploy({
		sol: `
			import {Deploy} from "@test/deploy/Deploy.sol";
			contract Chonk is Deploy {
			}
		`,
	});
	assert.equal(await contract.read(), 1n);
});

test("deploy w/import", async () => {
	const foundry = await F();
	const contract = await foundry.deploy({
		import: "@test/deploy/Deploy.sol",
	});
	assert.equal(await contract.read(), 1n);
});

test("solc tagged template", async () => {
	const { bytecode } = await compile`
		contract Chonk {
			function f() external pure returns (string memory) {
				return 'chonk';
			}
			function g(uint256 a, uint256 b) external pure returns (uint256) {
				return a * 1000 + b;
			}
		}
	`;
	assert.equal(bytecode.slice(0, 10), "0x60806040");
});
