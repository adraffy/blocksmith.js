
import {Foundry} from '../src/index.js';

const foundry = await Foundry.launch({});
try {
	const sol = `contract C {
		event Hi(uint256 x);
		constructor(uint256 x) {
			emit Hi(x);
		}
	}`;
	
	const A = await foundry.deploy({
		sol,
		args: [1]
	});

	const B = await foundry.deploy({
		sol: `
			contract A {}
			contract B {
				A x;
				constructor() {
					x = new A{salt: bytes32(0)}();
				}
			}
		`,
		contract: 'B'
});

	const C = await foundry.deploy({
		sol,
		args: [1],
		salt: 1
	});


} finally {
	await foundry.shutdown();
}


	// const sol = `contract C {
	// 	struct X {
	// 		uint256 x;
	// 		uint256 y;
	// 	}
	// 	event Hi(uint256, string[2] v, X x);
	// 	constructor(uint256 x) {
	// 		emit Hi(x, ["a", "b"], X(1, 2));
	// 	}
	// }`;