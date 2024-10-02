import {Foundry, compile} from '../src/Foundry.js';
import {ethers} from 'ethers';

const artifact = await compile(`
	contract C {
		constructor(uint256 x, uint256 y) {
			assembly {
				mstore(0, add(x, y))
				return(0, 32)
			}
		}
	}
`);

const f = await Foundry.launch();

const data = ethers.concat([artifact.bytecode, ethers.toBeHex(1300, 32), ethers.toBeHex(37, 32)]);
console.log(data);
console.log(BigInt(await f.provider.call({data})));
console.log(await f.provider.estimateGas({data}));

await f.shutdown();
