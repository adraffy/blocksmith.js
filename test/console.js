import {Foundry} from '../src/index.js';

let foundry = await Foundry.launch({
	procLog: false,
});

//foundry.provider.on("debug", (x) => console.log(x));
//foundry.provider.on({address: '0x000000000000000000636F6e736F6c652e6c6f67'}, (x) => console.log(x));

//foundry.provider.send('anvil_setLoggingEnabled', [true]);

let contract = await foundry.deploy({sol: `
	import "forge-std/console2.sol";
	contract Test {
		constructor() {
			console2.log("chonk0");
		}
		function f() external view {
			console2.log("chonk1");
		}
		function g() external {
			console2.log("chonk2");
		}
	}
`});

await contract.f();
await contract.g();

foundry.shutdown();
