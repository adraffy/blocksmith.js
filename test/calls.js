import {Foundry} from '../src/index.js';

const foundry = await Foundry.launch();

const c = await foundry.deploy({sol: `
	contract X {
		function f(uint256 x) external {
		}
	}
`});

await foundry.confirm(foundry.wallets.admin.sendTransaction({to: foundry.wallets.admin, value: 1n}));
await foundry.confirm(foundry.wallets.admin.sendTransaction({to: foundry.wallets.admin, data: '0x1234ABCD'}));
await foundry.confirm(foundry.wallets.admin.sendTransaction({to: foundry.wallets.admin, data: '0x1234ABCD1234'}));
await foundry.confirm(c.f(1));

await foundry.shutdown();
