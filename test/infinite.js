import {Foundry} from '../src/Foundry.js';
import {ethers} from 'ethers';

for (let forked of [true, false]) {

	const f = await Foundry.launch({
		fork: forked ? 'https://ethereum-rpc.publicnode.com' : undefined,
		infiniteCallGas: true,
	});

	const c = await f.deploy({sol: `
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
	`});

	let ok;
	try {
		await c.waste(10000000, ethers.id('chonk'));
		ok = true; 
	} catch (err) {
	}
	console.log({forked, ok});

	await f.shutdown();
}
