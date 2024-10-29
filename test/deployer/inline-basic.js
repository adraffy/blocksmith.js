import {FoundryDeployer} from '../../src/Foundry.js';
import {hexlify, randomBytes} from 'ethers';

const deployer = await FoundryDeployer.sepolia(process.env.PRIVATE_KEY);
const deployable = await deployer.prepare(`
	contract InlineBasic {
		function f() external pure returns (uint256) {
			return ${hexlify(randomBytes(32))};
		}
	}
`);

const {contract, receipt} = await deployable.deploy();

await deployable.verifyEtherscan();

console.log(receipt);
