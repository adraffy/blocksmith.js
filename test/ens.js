import { Foundry } from "../src/Foundry.js";
import { ethers } from "ethers";

const foundry = await Foundry.launch({
	fork: "https://rpc.ankr.com/eth",
});

console.log(foundry.ensRegistry);

const ens = new ethers.Contract(
	foundry.ensRegistry,
	[
		"function owner(bytes32) view returns (address)",
		"function resolver(bytes32) view returns (address)",
	],
	foundry.provider
);

const node = ethers.namehash("__dne.eth");

async function dump() {
	const [owner, resolver] = await Promise.all([
		ens.owner(node),
		ens.resolver(node),
	]);
	console.log(owner, resolver);
}

await dump();
await foundry.overrideENS({
	node,
	owner: "0x0000000000000000000000000000000000000001",
	resolver: "0x0000000000000000000000000000000000000002",
});
await dump();
await foundry.overrideENS({
	node,
	owner: null,
	resolver: null,
});
await dump();
await foundry.overrideENS({
	node,
	owner: "0x0000000000000000000000000000000000000003",
	resolver: null,
});
await dump();
await foundry.overrideENS({
	node,
	owner: null,
	resolver: "0x0000000000000000000000000000000000000004",
});
await dump();

await foundry.shutdown();
