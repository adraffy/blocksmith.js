import { ethers } from 'ethers';
import { spawn, execSync } from 'node:child_process';
import { accessSync, readFileSync, createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import toml from 'toml';

function error_with(message, params, cause) {
	let error;
	if (cause) {
		error = new Error(message, {cause});
		if (!error.cause) error.cause = cause;
	} else {
		error = new Error(message);
	}
	return Object.assign(error, params);
}

// extract an address from ethers objects
function to_address(x) {
	if (x instanceof ethers.Contract) {
		return x.target;
	} else if (x instanceof ethers.BaseWallet) {
		return x.address;
	} else if (typeof x === 'string') {
		return x;
	} else if (!x) {
		return ethers.ZeroAddress;
	}
	throw error_with('unable to coerce address', {input: x});
}

const CONFIG_NAME = 'foundry.toml';

class Foundry {
	static profile() {
		return process.env.FOUNDRY_PROFILE ?? 'default';
	}
	static base(cwd) {
		let dir = cwd || process.cwd();
		while (true) {
			let file = join(dir, 'foundry.toml');
			try {
				accessSync(file);
				return dir;
			} catch {
			}
			let parent = dirname(dir);
			if (parent === dir) throw error_with(`expected ${CONFIG_NAME}`, {cwd});
			dir = parent;
		}
	}
	static async launch({
		port = 8545, 
		chain, 
		block_sec = 1, 
		accounts = 5, 
		autoclose = true, 
		fork, log, base
	} = {}) {
		return new Promise((ful, rej) => {
			if (!base) base = this.base();
			let config = toml.parse(readFileSync(join(base, CONFIG_NAME), {encoding: 'utf8'}));
			config = config.profile[this.profile()];
			let args = [
				'--port', port,
				'--accounts', accounts
			];
			if (chain) args.push('--chain-id', chain);
			if (block_sec) args.push('--block-time', block_sec);
			if (fork) args.push('--fork-url', fork);
			let proc = spawn('anvil', args);
			function fail(data) {
				proc.kill();
				rej(error_with('launch', {args, data}));
			}
			//proc.stdin.close();
			proc.stderr.once('data', fail);
			proc.stdout.once('data', buf => {
				let init = buf.toString();
				let mnemonic, host;
				for (let x of init.split('\n')) {
					let match;
					if (match = x.match(/^Mnemonic:(.*)$/)) {
						mnemonic = match[1].trim();
					} else if (match = x.match(/^Listening on (.*)$/)) {
						host = match[1].trim();
					}
 				}
				if (!mnemonic || !host) {
					proc.kill();
					rej(error_with('init', {mnemonic, host, args, init}));
				}
				if (autoclose) {
					process.on('exit', () => proc.kill());
				}
				if (log === true) log = console.log;
				if (log instanceof Function) {
					log(init);
					proc.stdout.on('data', buf => log(buf.toString()));
				} else if (log) {
					let out = createWriteStream(log);
					out.write(init);
					proc.stdout.pipe(out);
				}
				let endpoint = `http://${host}`;
				let provider = new ethers.JsonRpcProvider(endpoint, chain, {staticNetwork: true, pollingInterval: (block_sec * 1000) >> 1});
				let wallets = Array.from({length: accounts}, (_, i) => {
					let wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, '', `m/44'/60'/0'/0/${i}`).connect(provider);
					wallet.name = `dev#${i}`;
					return wallet;
				});
				proc.stdout.removeListener('data', fail);
				ful(new this(proc, provider, wallets, {base, mnemonic, endpoint, chain, port, config}));
			});
		});
	}
	constructor(proc, provider, wallets, info) {
		this.proc = proc;
		this.provider = provider;
		this.wallets = wallets;
		this.info = info;
		this.deployed = new Map();
	}
	shutdown() {
		this.proc.kill();
		this.provider.destroy();
	}
	wallet(x, optional) {
		let {wallets: v} = this;
		if (Number.isInteger(x)) {
			if (x >= 0 && x < v.length) return v[x];
		} else if (typeof x === 'string') {
			let wallet = v.find(y => y.address === x);
			if (wallet) return wallet;
		} else if (v.includes(x)) {
			return x;
		} 
		if (!optional) {
			throw error_with('expected wallet', {wallet: x});
		}
	}
	resolve(path) {
		let {info: {config: {src, remappings = []}}} = this;
		for (let line of remappings) {
			let pos = line.indexOf('=');
			if (path.startsWith(line.slice(0, pos))) {
				return line.slice(pos +1) + path.slice(pos);
			}
		}
		return `${src}/${path}`;
	}
	async deploy({wallet = 0, file, name, contract: impl, args}, proto = {}) {
		wallet = this.wallet(wallet);
		if (file) ; else {
			if (!name) throw Error('expected name or file');
			file = `${name}.sol`;
		}
		if (!impl) impl = basename(file).replace(/\.sol$/, '');
		file = this.resolve(file);
		let cmd = ['forge create', '--rpc-url', this.info.endpoint, '--private-key', wallet.privateKey, `${file}:${impl}`];
		if (args) cmd.push('--constructor-args', ...args);
		let output = execSync(cmd.join(' '), {encoding: 'utf8'});
		let address = output.match(/Deployed to: (0x[0-9a-f]{40}\b)/mi)[1];
		let tx = output.match(/Transaction hash: (0x[0-9a-f]{64}\b)/mi)[1];
		let {abi} = JSON.parse(await readFile(join(this.info.base, `out/${basename(file)}/${impl}.json`)));
		let contract = new ethers.Contract(address, abi, wallet);
		this.deployed.set(address, contract);
		let receipt = await wallet.provider.getTransactionReceipt(tx);
		Object.assign(contract, proto, {receipt, file, filename: impl});
		console.log(`${wallet.name} Deployed: ${impl} @ ${address}`, receipt.gasUsed);
		return contract;
	}
}

class Node extends Map {
	static root() {
		return new this(null, ethers.ZeroHash, '[root]');
	}
	constructor(parent, namehash, label, labelhash) {
		super();
		this.parent = parent;
		this.namehash = namehash;
		this.label = label;
		this.labelhash = labelhash;
	}
	get root() {
		let node = this;
		while (node.parent) {
			node = node.parent;
		}
		return node;
	}
	get name() {
		let v = [];
		for (let node = this; node.parent != null; node = node.parent) {
			v.push(node.label);
		}
		return v.join('.');
	}
	nodes(v = []) {
		v.push(this);
		for (let x of this.values()) x.nodes(v);
		return v;
	}
	find(name) {
		if (!name) return this;
		return name.split('.').reduceRight((n, s) => n?.get(s), this);
	}
	create(name) {
		if (!name) return this;
		return name.split('.').reduceRight((n, s) => n.child(s), this);
	}
	unique(prefix = 'u') {
		for (let i = 1; ; i++) {
			let label = prefix + i;
			if (!this.has(label)) return this.child(label);
		}
	}
	child(label) {
		let c = this.get(label);
		if (!c) {
			let labelhash = ethers.id(label);
			let namehash = ethers.solidityPackedKeccak256(['bytes32', 'bytes32'], [this.namehash, labelhash]);
			c = new this.constructor(this, namehash, label, labelhash);
			this.set(label, c);
		}
		return c;
	}
	print(format = x => x.label, level = 0) {
		console.log('  '.repeat(level++), format(this));
		for (let x of this.values()) {
			x.print(format, level);
		}
	}
	toString() {
		return this.name;
	}
}

const IFACE_ENSIP_10 = '0x9061b923';
const IFACE_TOR = '0x73302a25';

class Resolver {
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
	async fetch(records, {multi = true, tor} = {}) {
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
			let call = tor_prefix(abi.encodeFunctionData(frag, [encoded]), tor);	
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
					let call = tor_prefix(abi.encodeFunctionData(frag, params), tor);
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

function tor_prefix(call, prefix) {
	switch (prefix) {
		case 'off': return '0x000000FF' + call.slice(2);
		case 'on':  return '0xFFFFFF00' + call.slice(2);
		case undefined: return call;
		default: throw new Error(`unknown prefix: ${prefix}`);
	}
}

export { Foundry, Node, Resolver, error_with, to_address };
