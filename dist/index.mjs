import { spawn, execSync } from 'node:child_process';
import { ethers } from 'ethers';
import { accessSync, readFileSync, createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
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

function is_address(s) {
	return typeof s === 'string' && /^0x[0-9a-f]{40}$/i.test(s);
}

function to_address(x) {
	if (is_address(x)) return x;
	if (is_address(x.target)) return x.target;
	if (is_address(x.address)) return x.address;
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
		block_sec,
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
					let out = createWriteStream(log);
					out.write(init);
					proc.stdout.pipe(out);
				}
				let endpoint = `http://${host}`;
				let provider = new ethers.JsonRpcProvider(endpoint, chain, {staticNetwork: true, pollingInterval: 50});
				if (!chain) {
					chain = parseInt(await provider.send('eth_chainId')); // determine chain id
				}
				let wallets = Array.from({length: accounts}, (_, i) => {
					let wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, '', derivation + i).connect(provider);
					wallet.name = `dev#${i}`;
					//wallet.nonce = 0;
					//wallet.getNonce = function() { return this.nonce++; }
					return wallet;
				});
				proc.stdout.removeListener('data', fail);
				ful(new this(proc, provider, wallets, {base, endpoint, chain, port, config}));
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
			if (deploy) return deploy.name;
		}
		return x;
	}
	async confirm(p, extra = {}) {
		let tx = await p;
		let receipt = await tx.wait();
		let from = this.wallet(receipt.from);
		let contract = this.deployed.get(receipt.to);
		// TODO: this could be sending to a wallet
		let desc = contract.interface.parseTransaction(tx);
		let args = {
			gas: receipt.gasUsed,
			...desc.args.toObject(),
			...extra
		};
		// replace any known address with it's name
		for (let [k, v] of Object.entries(args)) {
			if (is_address(v)) {
				args[k] = this.desc(v);
			}
		}
		console.log(`${from.name} ${contract.name}.${desc.name}()`, args);
		return receipt;
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
	async deploy({wallet = 0, name, contract: impl, args}, proto = {}) {
		wallet = this.wallet(wallet);
		if (!impl) impl = name; //basename(file).replace(/\.sol$/, '');
		const {base, endpoint, config: {src, out}} = this.info;
		let code_path = join(src, `${name}.sol`);
		let artifact_path = join(out, `${name}.sol`, `${impl}.json`);
		let cmd = ['forge create', '--rpc-url', endpoint, '--private-key', wallet.privateKey, `${code_path}:${impl}`];
		if (args) cmd.push('--constructor-args', ...args);
		let output = execSync(cmd.join(' '), {encoding: 'utf8'});
		let address = output.match(/Deployed to: (0x[0-9a-f]{40}\b)/mi)[1];
		let hash = output.match(/Transaction hash: (0x[0-9a-f]{64}\b)/mi)[1];
		let {abi} = JSON.parse(await readFile(join(base, artifact_path)));
		let contract = new ethers.Contract(address, abi, wallet);
		this.deployed.set(address, contract);
		//let tx = await wallet.provider.getTransaction(hash);
		let code = ethers.getBytes(await wallet.provider.getCode(address));
		let receipt = await wallet.provider.getTransactionReceipt(hash);
		Object.assign(contract, proto, {
			receipt, 
			name: impl,
			file: join(base, code_path), 
			code,
		});
		console.log(`${wallet.name} Deployed: ${impl} @ ${address}`, {gas: receipt.gasUsed, size: code.length});
		//wallet.nonce = tx.nonce + 1; // this didn't go through normal channels
		return contract;
	}
}

function split(s) {
	return s ? s.split('.') : [];
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
			let labelhash = ethers.id(label);
			let namehash = ethers.solidityPackedKeccak256(['bytes32', 'bytes32'], [this.namehash, labelhash]);
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
	async records(recs, {multi = true, ccip = true, tor} = {}) {
		const options = {enableCcipRead: ccip};
		const {node, info: {wild}, contract} = this;
		const {interface: abi} = contract;
		let dnsname = ethers.dnsEncode(node.name, 255);
		if (multi && recs.length > 1 && wild && this.info.tor) {
			let encoded = recs.map(rec => {
				let frag = abi.getFunction(record_type(rec));
				let params = [node.namehash];
				if ('arg' in rec) params.push(rec.arg);
				return abi.encodeFunctionData(frag, params);
			});
			let frag = abi.getFunction('multicall');
			let call = tor_prefix(abi.encodeFunctionData(frag, [encoded]), tor);	
			let data = await contract.resolve(dnsname, call, options);
			let [answers] = abi.decodeFunctionResult(frag, data);
			return [recs.map((rec, i) => {
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
		return [await Promise.all(recs.map(async rec => {
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
		let obj = Object.fromEntries(v.map(({rec, res, err}) => [record_key(rec), err ?? res]));
		if (multi) obj.multicalled = true;
		return obj;
	}
}

function record_type(rec) {
	let {type, arg} = rec;
	if (type === 'addr')  type = Number.isInteger(arg) ? 'addr(bytes32,uint256)' : 'addr(bytes32)';
	return type;
}

function record_key(rec) {
	let {type, arg} = rec;
	switch (type) {
		case 'addr': return `addr${arg ?? 60}`;
		case 'text': return arg;
		default: return type;
	}
}

function tor_prefix(call, prefix) {
	switch (prefix) {
		case 'off': return '0x000000FF' + call.slice(2);
		case 'on':  return '0xFFFFFF00' + call.slice(2);
		case undefined: return call;
		default: throw new Error(`unknown prefix: ${prefix}`);
	}
}

export { Foundry, Node, Resolver, error_with, is_address, to_address };
