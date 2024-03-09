import {Node} from '../src/Node.js';
import {Resolver} from '../src/Resolver.js';
import {ethers} from 'ethers';

// TODO: fix me

let provider = new ethers.CloudflareProvider();

let ens = new ethers.Contract('0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', [
	'function resolver(bytes32 node) external view returns (address)',
	'function owner(bytes32 node) external view returns (address)',
], provider);

let node = Node.root().create('eth.coinbase.tog.raffy.eth');

let resolver = await Resolver.get(ens, node);
let [records, multi] = await resolver.profile();

console.log({
	name: node.name.toString(),
	basename: resolver.base.toString(),
	resolver: resolver.contract.target,
	info: resolver.info,
});
console.log(records);
