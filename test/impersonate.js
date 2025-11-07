import {Foundry} from '../src/index.js';

const foundry = await Foundry.launch({procLog: false});
try {
	const sol = `
		import "forge-std/console.sol";
		event Hi();
		contract C {
			constructor() {
				console.log("Sender: %s", msg.sender);
			}
			function f() external {
				console.log("Sender: %s", msg.sender);
				emit Hi();
			}
		}`;
	const A = await foundry.deploy({sol});
	const from = foundry.impersonateWallet('0x51050ec063d393217B436747617aD1C2285Aeeee');
	await from.setNonce(1275);
	const B = await foundry.deploy({sol, from});
	await foundry.confirm(A.f());
	await foundry.confirm(B.f());
	// https://etherscan.io/tx/0x099872b2614cd331458ce3d724fc6ec4f12f83006a251bd04bd4dd883fd20035
	console.log(B.target === '0x805B697Da68E32d1Ab28a621B3f006F1858b2D72');
	// no receipt
	// no logs
	console.log(B.__receipt);
} finally {
	await foundry.shutdown();
}
