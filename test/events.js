import {Foundry} from '../src/Foundry.js';

// TODO: fix me

const f = await Foundry.launch();

f.on('deploy', c => {
	console.log(c.__info.contract, c.__receipt.gasUsed);
});

f.on('tx', (...a) => console.log(a.map(x => x.constructor.name)));

const c = await f.deploy(`
import "forge-std/console2.sol";
contract C {
	function f() external {
	}
	function g() external view {
		console2.log("hello");
	}
}`);

await f.confirm(c.f());

f.on('console', line => console.log({line}));

await c.g();

f.on('shutdown', () => console.log('i am kill'));

await f.shutdown();
