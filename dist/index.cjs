'use strict';

var node_child_process = require('node:child_process');
var ethers = require('ethers');
var node_fs = require('node:fs');
var promises = require('node:fs/promises');
var node_path = require('node:path');
var toml = require('toml');
var node_util = require('node:util');

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

function is_address(s) {
	return typeof s === 'string' && /^0x[0-9a-f]{40}$/i.test(s);
}

function to_address(x) {
	if (is_address(x)) return x;
	if (is_address(x.target)) return x.target;
	if (is_address(x.address)) return x.address;
}

const CONFIG_NAME = 'foundry.toml';

function ansi(c, s) {
	return `\u001b[${c}m${s}\u001b[0m`;
}

const TAG_DEPLOY = ansi('35', 'DEPLOY');
const TAG_TX = ansi('33', 'TX');
const TAG_LOG = ansi('36', 'LOG');

function strip_ansi(s) {
	return s.replaceAll(/[\u001b][^m]+m/g, '').split('\n');
}

class Foundry {
	static profile() {
		return process.env.FOUNDRY_PROFILE ?? 'default';
	}
	static base(cwd) {
		let dir = cwd || process.cwd();
		while (true) {
			let file = node_path.join(dir, 'foundry.toml');
			try {
				node_fs.accessSync(file);
				return dir;
			} catch {
			}
			let parent = node_path.dirname(dir);
			if (parent === dir) throw error_with(`expected ${CONFIG_NAME}`, {cwd});
			dir = parent;
		}
	}
	static async launch({
		port = 0,
		chain,
		block_sec,
		accounts = 5,
		autoclose = true,
		fork, log, base
	} = {}) {
		return new Promise((ful, rej) => {
			if (!base) base = this.base();
			try {
				node_child_process.execSync('forge build', {encoding: 'utf8'}); // throws
			} catch (err) {
				if (err.stderr) {
					err.stderr = strip_ansi(err.stderr);
					delete err.stdout;
					delete err.output;
				}
				throw err;
			}
			let config = toml.parse(node_fs.readFileSync(node_path.join(base, CONFIG_NAME), {encoding: 'utf8'})); // throws
			config = config.profile[this.profile()]; // should exist
			let args = [
				'--port', port,
				'--accounts', accounts
			];
			if (chain) args.push('--chain-id', chain);
			if (block_sec) {
				args.push('--block-time', block_sec);
			}
			if (fork) args.push('--fork-url', fork);
			let proc = node_child_process.spawn('anvil', args);
			function fail(data) {
				proc.kill();
				rej(error_with('launch', {args, data}));
			}
			proc.stdin.end();
			proc.stderr.once('data', fail);
			proc.stdout.once('data', async buf => {
				let init = buf.toString();
				let mnemonic, derivation, host;
				for (let x of init.split('\n')) {
					let match;
					if (match = x.match(/^Mnemonic:(.*)$/)) {
						// Mnemonic: test test test test test test test test test test test junk
						mnemonic = match[1].trim();
					} else if (match = x.match(/^Derivation path:(.*)$/)) {
						// Derivation path:   m/44'/60'/0'/0/
						derivation = match[1].trim();
					} else if (match = x.match(/^Listening on (.*)$/)) {
						host = match[1].trim();
					} 
 				}
				if (!mnemonic || !host || !derivation) {
					proc.kill();
					rej(error_with('init', {mnemonic, derivation, host, args, init}));
				}
				if (autoclose) {
					process.on('exit', () => proc.kill());
				}
				if (log === true) {
					console.log(init);
					proc.stdout.pipe(process.stdout);
				} else if (log instanceof Function) { // pass string
					log(init);
					proc.stdout.on('data', buf => log(buf.toString()));
				} else if (log) { // assume file
					let out = node_fs.createWriteStream(log);
					out.write(init);
					proc.stdout.pipe(out);
				}
				let endpoint = `ws://${host}`;
				port = parseInt(host.slice(host.lastIndexOf(':') + 1));
				let provider = new ethers.ethers.WebSocketProvider(endpoint, chain, {staticNetwork: true});
				//provider.on('block', block => console.log('block'));
				if (!chain) {
					chain = parseInt(await provider.send('eth_chainId')); // determine chain id
				}
				let automine = await provider.send('anvil_getAutomine');
				let wallets = await Promise.all(Array.from({length: accounts}, async (_, i) => {
					let wallet = ethers.ethers.HDNodeWallet.fromPhrase(mnemonic, '', derivation + i).connect(provider);
					if (automine) {
						// forked chains have to start from their true nonce
						wallet.__nonce = fork ? await provider.getTransactionCount(wallet.address) : 0;
						wallet.getNonce = function() {
							return this.__nonce;
						};
					}
					wallet.__name = `dev#${i}`;
					wallet[node_util.inspect.custom] = function() {
						return ansi(32, this.__name);
					};
					return wallet;
				}));
				proc.stdout.removeListener('data', fail);
				console.log(`Anvil`, {chain, endpoint, wallets});
				ful(new this(proc, provider, wallets, {base, endpoint, chain, port, automine, config}));
			});
		});
	}
	constructor(proc, provider, wallets, info) {
		this.proc = proc;
		this.provider = provider;
		this.wallets = wallets;
		this.info = info;
		this.deployed = new Map(wallets.map(x => [x.address, x]));
	}
	shutdown() {
		this.proc.kill();
		this.provider.destroy();
	}
	// require a signer from: index | address | self
	wallet(x) {
		let {wallets: v} = this;
		if (Number.isInteger(x)) {
			if (x >= 0 && x < v.length) return v[x];
		} else if (is_address(x)) {
			let wallet = v.find(y => y.address === x);
			if (wallet) return wallet;
		} else if (v.includes(x)) {
			return x;
		} 
		throw error_with('expected wallet', {wallet: x});
	}
	// get a name for a contract or wallet
	desc(x) {
		let a = to_address(x);
		if (a) {
			let deploy = this.deployed.get(a);
			if (deploy) return deploy.__name;
		}
		return x;
	}
	replace(obj) {
		let copy = {};
		for (let [k, v] of Object.entries(obj)) {
			copy[k] = is_address(v) ? this.deployed.get(v) : v;
		}
		return copy;
	}
	async wait(tx) {
		if (this.info.automine) {
			let receipt = await this.provider.getTransactionReceipt(tx.hash);
			let from = this.wallet(receipt.from);
			if (from) from.__nonce++;
			return receipt;
		}
		return tx.wait();
	}
	async confirm(p, extra = {}) {
		let tx = await p;
		let receipt = await this.wait(tx);
		let from = this.wallet(receipt.from);
		let contract = this.deployed.get(receipt.to);
		let args = {gas: receipt.gasUsed, ...extra};
		let action;
		if (contract instanceof ethers.ethers.BaseContract) {
			let desc = contract.interface.parseTransaction(tx);
			Object.assign(args, desc.args.toObject());
			action = `${contract.__name}.${desc.signature}`;
			this.print_logs(contract.interface, receipt);
		} else {
			action = this.desc(receipt.to);
		}
		console.log(TAG_TX, from, action, this.replace(args));
		return receipt;
	}
	print_logs(abi, receipt) {
		for (let x of receipt.logs) {
			let log = abi.parseLog(x);
			if (log) {
				console.log(TAG_LOG, log.signature, this.replace(log.args.toObject()));
			}
		}
	}
	// resolve(path) {
	// 	let {info: {config: {src, remappings = []}}} = this;
	// 	for (let line of remappings) {
	// 		let pos = line.indexOf('=');
	// 		if (path.startsWith(line.slice(0, pos))) {
	// 			return line.slice(pos +1) + path.slice(pos);
	// 		}
	// 	}
	// 	return `${src}/${path}`;
	// }
	async deploy({wallet = 0, name, contract: impl, args = []}, proto = {}) {
		wallet = this.wallet(wallet);
		if (!impl) impl = name; //basename(file).replace(/\.sol$/, '');
		const {base, config: {src, out}} = this.info;
		let code_path = node_path.join(src, `${name}.sol`);
		let artifact_path = node_path.join(out, `${name}.sol`, `${impl}.json`);
		let {abi, bytecode} = JSON.parse(await promises.readFile(node_path.join(base, artifact_path)));
		abi = new ethers.ethers.Interface(abi);
		let factory = new ethers.ethers.ContractFactory(abi, bytecode, wallet);
		let unsigned = await factory.getDeployTransaction(args);
		let tx = await wallet.sendTransaction(unsigned);
		let receipt = await this.wait(tx);
		let {contractAddress: address} = receipt;
		let code = ethers.ethers.getBytes(await this.provider.getCode(address));
		let contract = new ethers.ethers.Contract(address, abi, wallet);
		let __name = `${impl}<${address.slice(2, 6)}>`; // so we can deploy the same contract multiple times
		// store some shit in the ethers contract without conflicting
		let info = {
			__name,
			__contract: impl,
			__file: node_path.join(base, code_path), 
			__code: code,
			__tx: receipt,
			[node_util.inspect.custom]() {
				return ansi(32, this.__name);
			}
		};
		Object.assign(contract, info);
		this.deployed.set(address, contract); // keep track of it
		console.log(TAG_DEPLOY, wallet, `${code_path}`, contract, {address, gas: receipt.gasUsed, size: code.length});
		this.print_logs(abi, receipt);
		return contract;
	}
}

function split(s) {
	return s ? s.split('.') : [];
}

class Node extends Map {
	static root() {
		return new this(null, ethers.ethers.ZeroHash, '[root]');
	}
	constructor(parent, namehash, label, labelhash) {
		super();
		this.parent = parent;
		this.namehash = namehash;
		this.label = label;
		this.labelhash = labelhash;
	}
	get root() {
		let x = this;
		while (x.parent) x = x.parent;
		return x;
	}
	get name() {
		if (!this.parent) return '';
		let v = [];
		for (let x = this; x.parent; x = x.parent) v.push(x.label);
		return v.join('.');
	}
	get depth() {
		let n = 0;
		for (let x = this; x.parent; x = x.parent) ++n;
		return n;
	}
	get nodes() {
		let n = 0;
		this.scan(() => ++n);
		return n;
	}
	find(name) {
		return split(name).reduceRight((n, s) => n?.get(s), this);
	}
	create(name) {
		return split(name).reduceRight((n, s) => n.child(s), this);
	}
	unique(prefix = 'u') {
		for (let i = 1; ; i++) {
			let label = prefix + i;
			if (!this.has(label)) return this.child(label);
		}
	}
	child(label) {
		let node = this.get(label);
		if (!node) {
			let labelhash = ethers.ethers.id(label);
			let namehash = ethers.ethers.solidityPackedKeccak256(['bytes32', 'bytes32'], [this.namehash, labelhash]);
			node = new this.constructor(this, namehash, label, labelhash);
			this.set(label, node);
		}
		return node;
	}
	scan(fn, level = 0) {
		fn(this, level++);
		for (let x of this.values()) {
			x.scan(fn, level);
		}
	}
	flat() {
		let v = [];
		this.scan(x => v.push(x));
		return v;
	}
	print(format = x => x.label) {
		this.scan((x, n) => console.log('  '.repeat(n) + format(x)));
	}
	toString() {
		return this.name;
	}
}

const IFACE_ENSIP_10 = '0x9061b923';
const IFACE_TOR = '0x73302a25';

class Resolver {
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
			if (resolver === ethers.ethers.ZeroAddress) continue;
			let contract = new ethers.ethers.Contract(resolver, [
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
	get address() { 
		return this.contract.target; 
	}
	async text(key, a)   { return this.record({type: 'text', arg: key}, a); }
	async addr(type, a)  { return this.record({type: 'addr', arg: type}, a); }
	async contenthash(a) { return this.record({type: 'contenthash'}, a); }
	async record(rec, a) {
		let [[{res, err}]] = await this.records([rec], a);
		if (err) throw err;
		return res;
	}
	async records(recs, {multi = true, ccip = true, tor: tor_prefix} = {}) {
		const options = {enableCcipRead: ccip};
		const {node, info: {wild, tor}, contract} = this;
		const {interface: abi} = contract;
		let dnsname = ethers.ethers.dnsEncode(node.name, 255);
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
	async profile(a) {
		let [v, multi] = await this.records([
			{type: 'text', arg: 'name'},
			{type: 'text', arg: 'avatar'},
			{type: 'text', arg: 'description'},
			{type: 'text', arg: 'url'},
			{type: 'addr', arg: 60},
			{type: 'addr', arg: 0},
			{type: 'contenthash'},
		], a);
		let obj = Object.fromEntries(v.map(({rec, res, err}) => [key_from_record(rec), err ?? res]));
		if (multi) obj.multicalled = true;
		return obj;
	}
}

function type_from_record(rec) {
	let {type, arg} = rec;
	if (type === 'addr')  type = Number.isInteger(arg) ? 'addr(bytes32,uint256)' : 'addr(bytes32)';
	return type;
}

function key_from_record(rec) {
	let {type, arg} = rec;
	switch (type) {
		case 'addr': return `addr${arg ?? 60}`;
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

exports.Foundry = Foundry;
exports.Node = Node;
exports.Resolver = Resolver;
exports.error_with = error_with;
exports.is_address = is_address;
exports.to_address = to_address;
