import {Foundry} from '../src/index.js';
import {ethers} from 'ethers';
import {test, after} from 'node:test';

test('infinite gas: normal', () => launch());
test('infinite gas: fork', () => launch('https://ethereum-rpc.publicnode.com'));

async function launch(fork) {
	const foundry = await Foundry.launch({
		fork,
		infoLog: false,
		infiniteCallGas: true,
	});
	after(foundry.shutdown);
	const contract = await foundry.deploy(`
		contract X {
			function waste(uint256 n, bytes32 h) external pure returns (bytes32) {
				for (; n > 0; n--) {
					assembly {
						mstore(0, h)
						h := keccak256(0, 32)
					}
				}
				return h;
			}
		}	
	`);
	await contract.waste(1000000, ethers.id('chonk'));
}
