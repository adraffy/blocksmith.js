import {FoundryDeployer} from '../src/Foundry.js';

const deployer = await FoundryDeployer.load({
	provider: 'sepolia',
	privateKey: process.env.PRIVATE_KEY,
});

console.log(deployer.etherscanApiKey);

if (0) {
	const deployable = await deployer.prepare(`
		import "forge-std/console2.sol";
		contract C {
			function chonk2() external {
				console2.log("CHONK");
			}
		}
	`);
	console.log(deployable);
}


if (1) {
	const deployable = await deployer.prepare({
		sol: `
			struct S {
				string s;
				bytes v;
				bytes32 x;
				address a;
			}
			contract C {
				constructor(S memory) {}
			}
		`,
		args: [['ab', '0x'.padEnd(90, '0'), '0x'.padEnd(66, '0'), '0x'.padEnd(42, '0')]]
	});
	console.log(deployable);
	console.log(deployable.deployArgs());
	await deployable.deploy();
}


if (0) {
	const deployable = await deployer.prepare({
		sol: `contract C {
			struct S {
				string a;
				uint256 b;
			}
			constructor(string[2] memory, S memory) {
			}
		}`,
		args: [["a", "b"], ["c", 3]]
	});
	console.log(deployable.deployArgs());
	await deployable.deploy();
}
