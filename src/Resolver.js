import {ethers} from 'ethers';
//import {Node} from './Node.js';

const IFACE_ENSIP_10 = '0x9061b923';
const IFACE_TOR = '0x73302a25';

const RESOLVER_ABI = new ethers.Interface([
	'function supportsInterface(bytes4) view returns (bool)',
	'function resolve(bytes name, bytes data) view returns (bytes)',
	'function addr(bytes32 node, uint coinType) view returns (bytes)',
	'function addr(bytes32 node) view returns (address)',
	'function text(bytes32 node, string key) view returns (string)',
	'function contenthash(bytes32 node) view returns (bytes)',
	'function pubkey(bytes32 node) view returns (bytes32 x, bytes32 y)',
	'function name(bytes32 node) view returns (string)',
	'function multicall(bytes[] calldata data) external returns (bytes[] memory results)',
]);

const DEFAULT_RECORDS = [
	{type: 'text', arg: 'name'},
	{type: 'text', arg: 'avatar'},
	{type: 'text', arg: 'description'},
	{type: 'text', arg: 'url'},
	{type: 'addr', arg: 60},
	{type: 'addr', arg: 0},
	{type: 'contenthash'},
];

export class Resolver {
	static get ABI() {
		return RESOLVER_ABI;
	}
	static async dump(ens, node) {
		let nodes = node.flat();
		let owners = await Promise.all(nodes.map(x => ens.owner(x.namehash)));
		let resolvers = await Promise.all(nodes.map(x => ens.resolver(x.namehash)));
		let width = String(nodes.length).length;
		for (let i = 0; i < nodes.length; i++) {
			console.log(i.toString().padStart(width), owners[i], resolvers[i], nodes[i].name);
		}
	}
	static async get(ens, node) {
		for (let base = node, drop = 0; base; base = base.parent, drop++) {
			let resolver = await ens.resolver(base.namehash);
			if (resolver === ethers.ZeroAddress) continue;
			let contract = new ethers.Contract(resolver, RESOLVER_ABI, ens.runner.provider);
			let wild = await contract.supportsInterface(IFACE_ENSIP_10).catch(() => false);
			if (drop && !wild) break;
			let tor = wild && await contract.supportsInterface(IFACE_TOR);
			return Object.assign(new this(node, contract), {wild, tor, drop, base});
		}
	}
	constructor(node, contract) {
		this.node = node;
		this.contract = contract;
	}
	get address() {
		return this.contract.target;
	}
	async text(key, a)   { return this.record({type: 'text', arg: key}, a); }
	async addr(type, a)  { return this.record({type: 'addr', arg: type}, a); }
	async contenthash(a) { return this.record({type: 'contenthash'}, a); }
	async name(a)        { return this.record({type: 'name'}, a); }
	async record(rec, a) {
		let [[{res, err}]] = await this.records([rec], a);
		if (err) throw err;
		return res;
	}
	async records(recs, {multi = true, ccip = true, tor: tor_prefix} = {}) {
		const options = {enableCcipRead: ccip};
		const {node, contract, wild, tor} = this;
		const {interface: abi} = contract;
		let dnsname = ethers.dnsEncode(node.name, 255);
		if (multi && recs.length > 1 && wild && tor) {
			let encoded = recs.map(rec => {
				let frag = abi.getFunction(type_from_record(rec));
				let params = [node.namehash];
				if ('arg' in rec) params.push(rec.arg);
				return abi.encodeFunctionData(frag, params);
			});
			// TODO: add external multicall
			let frag = abi.getFunction('multicall');
			let call = add_tor_prefix(tor_prefix, abi.encodeFunctionData(frag, [encoded]));	
			let data = await contract.resolve(dnsname, call, options);
			let [answers] = abi.decodeFunctionResult(frag, data);
			return [recs.map((rec, i) => {
				let frag = abi.getFunction(type_from_record(rec));
				let answer = answers[i];
				try {
					let res = abi.decodeFunctionResult(frag, answer);
					if (res.length === 1) res = res[0];
					return {rec, res};
				} catch (err) {
					return {rec, err};
				}
			}), true];
		}
		return [await Promise.all(recs.map(async rec => {
			let params = [node.namehash];
			if (rec.arg) params.push(rec.arg);
			try {
				let type = type_from_record(rec);
				let res;
				if (wild) {
					let frag = abi.getFunction(type);
					let call = abi.encodeFunctionData(frag, params);
					if (tor) call = add_tor_prefix(tor_prefix, call);
					let answer = await contract.resolve(dnsname, call, options);
					res = abi.decodeFunctionResult(frag, answer);
					if (res.length === 1) res = res[0];
				} else {
					res = await contract[type](...params);
				}
				return {rec, res};
			} catch (err) {
				return {rec, err};
			}
		}))];
	}
	async profile(records = DEFAULT_RECORDS, a) {
		let [v, multi] = await this.records(records, a);
		let obj = Object.fromEntries(v.map(({rec, res, err}) => [key_from_record(rec), err ?? res]));
		if (multi) obj.multicalled = true;
		return obj;
	}
}

function type_from_record(rec) {
	let {type, arg} = rec;
	if (type === 'addr') type = arg === undefined ? 'addr(bytes32)' : 'addr(bytes32,uint256)';
	return type;
}

function key_from_record(rec) {
	let {type, arg} = rec;
	switch (type) {
		case 'addr': return `addr${arg ?? ''}`;
		case 'text': return arg;
		default: return type;
	}
}

function add_tor_prefix(prefix, call) {
	switch (prefix) {
		case 'off': return '0x000000FF' + call.slice(2);
		case 'on':  return '0xFFFFFF00' + call.slice(2);
		case undefined: return call;
		default: throw new Error(`unknown prefix: ${prefix}`);
	}
}
