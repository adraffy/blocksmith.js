import {Foundry} from '../src/index.js';

let foundry = await Foundry.launch({procLog: true});

//foundry.provider.on("debug", (x) => console.log(x));
//foundry.provider.on({address: '0x000000000000000000636F6e736F6c652e6c6f67'}, (x) => console.log(x));

foundry.provider.send('anvil_setLoggingEnabled', [false]);

let contract = await foundry.deploy({sol: `
	import "forge-std/console2.sol";
	contract Test {
		function f() external view {
			console2.log("chonk");
		}
	}
`});

await contract.f();

foundry.shutdown();
