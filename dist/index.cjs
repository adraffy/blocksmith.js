'use strict';

var node_child_process = require('node:child_process');
var ethers = require('ethers');
var node_fs = require('node:fs');
var promises = require('node:fs/promises');
var node_path = require('node:path');
var node_os = require('node:os');
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

const TMP_DIR = node_path.join(node_os.tmpdir(), 'blocksmith');

const CONFIG_NAME = 'foundry.toml';

function ansi(c, s) {
	return `\u001b[${c}m${s}\u001b[0m`;
}
function strip_ansi(s) {
	return s.replaceAll(/[\u001b][^m]+m/g, '').split('\n');
}

const TAG_DEPLOY = ansi('35', 'DEPLOY');
const TAG_TX     = ansi('33', 'TX');
const TAG_LOG    = ansi('36', 'LOG');

const DEFAULT_WALLET = 'admin';

const _OWNER = Symbol('foundry');
const _NAME  = Symbol('foundry.name');

function take_hash(s) {
	return s.slice(2, 6);
}

function solc(v) { return compile(v.join('\n')); } // experimental
function compile(sol, contract) {
	if (!contract) {
		let match = sol.match(/contract\s(.*)\b/);
		if (!match) throw error_with('expected contract name', {sol});
		contract = match[1];
	}
	let hash = take_hash(ethers.ethers.id(sol));
	let root = node_path.join(TMP_DIR, hash);
	node_fs.rmSync(root, {recursive: true, force: true});
	let src = node_path.join(root, 'src');
	node_fs.mkdirSync(src, {recursive: true});
	let file = node_path.join(src, `${contract}.sol`);
	node_fs.writeFileSync(file, sol);
	let {errors, contracts} = JSON.parse(node_child_process.execSync(`forge build --format-json --root ${root}`, {encoding: 'utf8'}));
	if (errors.length) {
		throw error_with('compile error', {sol, errors});
	}
	let info = contracts[file]?.[contract]?.[0];
	if (!info) {
		throw error_with('expected contract', {sol, contracts, contract});
	}
	let {contract: {abi, evm: {bytecode: {object: bytecode}}}} = info;
	abi = ethers.ethers.Interface.from(abi);
	bytecode = '0x' + bytecode;
	return {abi, bytecode, contract, origin: `InlineCode{${hash}}`, sol};
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
		wallets = [DEFAULT_WALLET],
		chain,
		block_sec,
		autoclose = true,
		fork, log, base
	} = {}) {
		return new Promise((ful, rej) => {
			let args = [
				'--port', port,
				'--accounts', 0 // create accounts on demand
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
				proc.stdout.removeListener('data', fail);
				let init = buf.toString();
				//let mnemonic, derivation, host;
				let host;
				for (let x of init.split('\n')) {
					let match;
					// if (match = x.match(/^Mnemonic:(.*)$/)) {
					// 	// Mnemonic: test test test test test test test test test test test junk
					// 	mnemonic = match[1].trim();
					// } else if (match = x.match(/^Derivation path:(.*)$/)) {
					// 	// Derivation path:   m/44'/60'/0'/0/
					// 	derivation = match[1].trim();
					// } else 
					if (match = x.match(/^Listening on (.*)$/)) {
						host = match[1].trim();
					} 
 				}
				if (!host) {
					proc.kill();
					rej(error_with('init', {args, init}));
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
				if (!chain) {
					chain = parseInt(await provider.send('eth_chainId')); // determine chain id
				}
				let automine = await provider.send('anvil_getAutomine');
				if (automine) {
					provider.destroy();
					provider = new ethers.ethers.WebSocketProvider(endpoint, chain, {staticNetwork: true, cacheTimeout: -1});
				}
				let self = new this(proc, provider, {endpoint, chain, port, automine});
				wallets = await Promise.all(wallets.map(x => self.ensureWallet(x)));
				if (base) {
					await self.ensureBuilt(base);
				}
				console.log(`Anvil`, self.pretty({chain, endpoint, wallets}));
				ful(self);
			});
		});
	}
	constructor(proc, provider, info) {
		this.accounts = new Map();
		this.wallets = {};
		this.proc = proc;
		this.provider = provider;
		this.info = info;
		
		

		// provider.resolveName = async function(name) {
		// 	let wallet = this.named_wallets.get(name);
		// 	if (wallet) {
		// 		return wallet.address;
		// 	}
		// 	let resolver = await this.getResolver(name);
		// 	if (resolver) { 
		// 		return resolver.getAddress(); 
		// 	}
		// 	return null;
		// }



	}
	async ensureBuilt(base) {
		if (this.built) return this.built;
		if (!base) base = Foundry.base();
		let config = toml.parse(node_fs.readFileSync(node_path.join(base, CONFIG_NAME), {encoding: 'utf8'})); // throws
		let profile = Foundry.profile();
		config = config.profile[profile];
		if (!config) {
			throw error_with('unknown profile', {profile});
		}
		// TODO fix me
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
		return this.built = {config, base, profile};
	}
	shutdown() {
		this.proc.kill();
		this.provider.destroy();
	}
	requireWallet(x, y) {
		if (x instanceof ethers.ethers.Wallet) {
			if (x[_OWNER] === this) return x;
			throw error_with('unowned wallet', {wallet: x});
		} else if (is_address(x)) {
			let a = this.accounts.get(x);
			if (a) return a;
			throw error_with('unknown wallet', {address: x});
		} else if (typeof x === 'string') {
			let a = this.wallets[x];
			if (a) return a;
			throw error_with('unknown wallet', {name: x});
		} else if (y) {
			return this.requireWallet(y);
		}
		throw error_with('expected wallet', {wallet: x});
	}
	async ensureWallet(x) {
		if (x instanceof ethers.ethers.Wallet) {
			if (x[_OWNER] === this) return x;
			throw error_with('unowned wallet', {wallet: x});
		}
		if (!x || typeof x !== 'string' || is_address(x)) {
			throw error_with('expected wallet name', {name: x});
		}
		let wallet = this.wallets[x];
		if (!wallet) {
			wallet = new ethers.ethers.Wallet(ethers.ethers.id(x), this.provider);
			await this.provider.send('anvil_setBalance', [wallet.address, ethers.ethers.toBeHex(10000n * BigInt(1e18))]);
			wallet[_NAME] = x;
			wallet[_OWNER] = this;
			this.wallets[x] = wallet;
			this.accounts.set(wallet.address, wallet);
		}
		return wallet;
	}
	pretty(x) {
		if (x) {
			if (typeof x === 'object') {
				if (_OWNER in x) {
					return {
						[node_util.inspect.custom]() { return ansi(32, x[_NAME]); }
					};
				} else if (Array.isArray(x)) {
					return x.map(y => this.pretty(y));
				} else if (x.constructor === Object) {
					return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, this.pretty(v)]));
				}
			} else if (typeof x === 'string') {
				if (is_address(x)) {
					let a = this.accounts.get(x);
					if (a) return this.pretty(a);
				}
			}
		}
		return x;
	}
	async confirm(p, extra = {}) {
		let tx = await p;
		let receipt = await tx.wait();
		let args = {gas: receipt.gasUsed, ...extra};
		let contract = this.accounts.get(receipt.to);
		if (contract instanceof ethers.ethers.BaseContract) {
			let desc = contract.interface.parseTransaction(tx);
			Object.assign(args, desc.args.toObject());
			console.log(TAG_TX, this.pretty(receipt.from), `${contract[_NAME]}.${desc.signature}`, this.pretty(args));
			this._dump_logs(contract.interface, receipt);
		} else {
			console.log(TAG_TX, this.pretty(receipt.from), '>>', this.pretty(receipt.to), this.pretty(args));
		}
		return receipt;
	}
	_dump_logs(abi, receipt) {
		for (let x of receipt.logs) {
			let log = abi.parseLog(x);
			if (log) {
				console.log(TAG_LOG, log.signature, this.pretty(log.args.toObject()));
			}
		}
	}	
	async resolveArtifact(args) {
		let {sol, bytecode, abi, file, contract} = args;
		if (sol) {
			return compile(sol, contract);
		} else if (bytecode) {
			if (!contract) contract = 'Unnamed';
			abi = ethers.ethers.Interface.from(abi);
			return {abi, bytecode, contract, origin: 'Bytecode'}
		} else if (file) {
			return this.fileArtifact(file, contract);
		}
		throw error_with('unknown artifact', args);
	}
	async fileArtifact(file, contract) {
		file = file.replace(/\.sol$/, '');
		if (!contract) contract = node_path.basename(file);
		file += '.sol';
		const {base, config: {src, out}} = await this.ensureBuilt();
		let artifact_file = node_path.join(out, file, `${contract}.json`);
		let {abi, bytecode: {object: bytecode}} = JSON.parse(await promises.readFile(node_path.join(base, artifact_file)));
		abi = ethers.ethers.Interface.from(abi);
		return {abi, bytecode, contract,
			origin: file, 
			file: node_path.join(base, src, file)
		};
	}
	async deploy({from, args = [], ...artifactLike}, proto = {}) {
		let w = await this.ensureWallet(from || DEFAULT_WALLET);
		let {abi, bytecode, ...artifact} = await this.resolveArtifact(artifactLike);
		let {contract} = artifact;
		let factory = new ethers.ethers.ContractFactory(abi, bytecode, w);
		let unsigned = await factory.getDeployTransaction(...args);
		let tx = await w.sendTransaction(unsigned);
		let receipt = await tx.wait();
		let {contractAddress: address} = receipt;
		let code = ethers.ethers.getBytes(await this.provider.getCode(address));
		let c = new ethers.ethers.Contract(address, abi, w);
		c[_NAME] = `${contract}<${take_hash(address)}>`; // so we can deploy the same contract multiple times
		c[_OWNER] = this;
		c.toString = function() { return this[_NAME]; };
		c.__artifact = artifact;
		c.__receipt = tx;
		Object.assign(c, proto);
		this.accounts.set(address, c); // keep track of it
		console.log(TAG_DEPLOY, this.pretty(w), artifact.origin, this.pretty(c), {address, gas: receipt.gasUsed, size: code.length});
		this._dump_logs(abi, receipt);
		return c;
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
exports.compile = compile;
exports.error_with = error_with;
exports.is_address = is_address;
exports.solc = solc;
exports.to_address = to_address;
