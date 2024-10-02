import {Foundry} from '../src/Foundry.js';

const f = await Foundry.launch();

await f.deploy({sol: `
 	interface I {
 		function f() external pure returns (uint256);
	}
	struct S {
		I i;
	}
	library L {
		function g(S memory s) external pure returns (uint256) {
			return s.i.f();
		}
	}`
});

await f.shutdown();
