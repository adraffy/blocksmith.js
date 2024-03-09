import {ethers} from 'ethers';

const IFACE_ENSIP_10 = '0x9061b923';
const IFACE_TOR = '0x73302a25';

export class Resolver {
	static async dump(ens, node) {
		let nodes = node.nodes();
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
			let contract = new ethers.Contract(resolver, [
				'function supportsInterface(bytes4) view returns (bool)',
				'function resolve(bytes name, bytes data) view returns (bytes)',
				'function addr(bytes32 node, uint coinType) view returns (bytes)',
				'function addr(bytes32 node) view returns (address)',
				'function text(bytes32 node, string key) view returns (string)',
				'function contenthash(bytes32 node) view returns (bytes)',
				'function pubkey(bytes32 node) view returns (bytes32 x, bytes32 y)',
				'function name(bytes32 node) view returns (string)',
				'function multicall(bytes[] calldata data) external returns (bytes[] memory results)',
			], ens.runner.provider);
			let wild = await contract.supportsInterface(IFACE_ENSIP_10);
			if (drop && !wild) break;
			let tor = wild && await contract.supportsInterface(IFACE_TOR);
			return new this(node, base, contract, {wild, drop, tor});
		}
	}
	constructor(node, base, contract, info) {
		this.node = node;
		this.base = base;
		this.contract = contract;
		this.info = info;
	}
	async fetch(records, {multi = true, tor_prefix} = {}) {
		const options = {enableCcipRead: true};
		const {node, info: {wild}, contract} = this;
		const {interface: abi} = contract;
		let dnsname = ethers.dnsEncode(node.name, 255);
		if (multi && records.length > 1 && wild && this.info.tor) {
			let encoded = records.map(rec => {
				let frag = abi.getFunction(record_type(rec));
				let params = [node.namehash];
				if (rec.arg) params.push(rec.arg);
				return abi.encodeFunctionData(frag, params);
			});
			let frag = abi.getFunction('multicall');
			let call = add_prefix(abi.encodeFunctionData(frag, [encoded]), tor_prefix);	
			let data = await contract.resolve(dnsname, call, options);
			let [answers] = abi.decodeFunctionResult(frag, data);
			return [records.map((rec, i) => {
				let frag = abi.getFunction(record_type(rec));
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
		return [await Promise.all(records.map(async rec => {
			let params = [node.namehash];
			if (rec.arg) params.push(rec.arg);
			try {
				let type = record_type(rec);
				let res;
				if (wild) {
					let frag = abi.getFunction(type);
					let call = add_prefix(abi.encodeFunctionData(frag, params), tor_prefix);
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
	profile() {
		// TODO: fix me
		return this.fetch([
			{type: 'addr', arg: 60},
			{type: 'text', arg: 'name'},
			{type: 'text', arg: 'avatar'},
			{type: 'contenthash'},
		]);
	}
}

function record_type(rec) {
	let {type, arg} = rec;
	if (type === 'addr')  type = arg ? 'addr(bytes32,uint256)' : 'addr(bytes32)';
	return type;
}

function add_prefix(call, prefix) {
	switch (prefix) {
		case 'off': return '0x000000FF' + call.slice(2);
		case 'on':  return '0xFFFFFF00' + call.slice(2);
		case undefined: return call;
		default: throw new Error(`unknown prefix: ${prefix}`);
	}
}