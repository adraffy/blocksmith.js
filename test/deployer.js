import {FoundryDeployer} from '../src/Foundry.js';

const deployer = await FoundryDeployer.load({
	provider: 'sepolia',
	privateKey: process.env.PRIVATE_KEY,
});

{
	const deployable = await deployer.prepare(`
		import "forge-std/console2.sol";
		contract C {
			function chonk2() external {
				console2.log("CHONK");
			}
		}
	`);
	console.log(deployable);
	console.log(deployer.etherscanApiKey);


	// const {contract, receipt} = await info.deploy();
	// await info.verifyEtherscan();

	// console.log(contract, receipt);
}

{
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
