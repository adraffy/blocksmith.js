import {FoundryDeployer} from '../src/Foundry.js';
import {ethers} from 'ethers';

const deployer = await FoundryDeployer.sepolia(process.env.PRIVATE_KEY);
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

