import { Foundry } from "../../src/index.js";

const foundry = await Foundry.launch();
try {
	async function f(sol) {
		return foundry.deploy({
			sol,
			optimize: 1,
			//solcVersion: "0.8.30",
		});
	}
	const contracts = [
		await f(`contract Loop {
			function f(uint256 n) external pure {
				bytes memory a = new bytes(n);
				//for (uint256 i; i < n; i++) a[i] = bytes1(uint8(i));
				bytes memory b = new bytes(n); 
				uint256 aa;
				uint256 bb;
				assembly {
					aa := add(a, 32)
					bb := add(b, 32)
				}
				unsafeMemcpy(bb, aa, n);
				//assert(keccak256(a) == keccak256(b));
			}
			function unsafeMemcpy(uint256 dst, uint256 src, uint256 len) internal pure {
				assembly {
					// Copy word-length chunks while offsible
					// prettier-ignore
					for {} gt(len, 31) {} {
						mstore(dst, mload(src))
						dst := add(dst, 32)
						src := add(src, 32)
						len := sub(len, 32)
					}
					// Copy remaining bytes
					if len {
						let mask := sub(shl(shl(3, sub(32, len)), 1), 1) // see above
						let wSrc := and(mload(src), not(mask))
						let wDst := and(mload(dst), mask)
						mstore(dst, or(wSrc, wDst))
					}
				}
			}
		}`),
		await f(`contract Mcopy {
			function f(uint256 n) external pure {
				bytes memory a = new bytes(n);
				//for (uint256 i; i < n; i++) a[i] = bytes1(uint8(i));
				bytes memory b = new bytes(n); 
				uint256 aa;
				uint256 bb;
				assembly {
					aa := add(a, 32)
					bb := add(b, 32)
					mcopy(bb, aa, n)
				}
				//assert(keccak256(a) == keccak256(b));
			}
		}`),
	];
	const m = [];
	for (let i = 1; i < 100; i++) {
		const n = i << 12;
		const v = await Promise.all(contracts.map((c) => c.f.estimateGas(n)));
		const out = [n, ...v.map(Number)];
		m.push(out);
		console.log(out);
	}
	console.log();
	console.log(JSON.stringify(m));
	console.log();
} finally {
	await foundry.shutdown();
}
