import {Foundry} from '../src/index.js';

let foundry = await Foundry.launch();

foundry.deploy({sol: `
	import "forge-std/Console.sol";
	contract Test {
		function f() external view {
			console2.log()
		}
	}
`})

foundry.