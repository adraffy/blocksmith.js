import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import { createWriteStream } from 'node:fs';
import { realpath, rm, mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { Console } from 'node:console';

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
	if (x) {
		if (is_address(x)) return x;
		if (is_address(x.target)) return x.target;
		if (is_address(x.address)) return x.address;
	}
}

// https://toml.io/en/v1.0.0

function encode(obj) {
	let lines = [];
	write(lines, obj, []);
	return lines.join('\n');
}

function write(lines, obj, path) {
	let after = [];
	for (let [k, v] of Object.entries(obj)) {
		if (v === null) continue;
		if (is_basic(v)) {
			lines.push(`${encode_key(k)} = ${format_value(v)}`);
		} else if (Array.isArray(v)) {
			if (v.every(is_basic)) {
				lines.push(`${encode_key(k)} = [${v.map(format_value)}]`);
			} else {
				after.push([k, v]);
			}
		} else if (v?.constructor === Object) {
			after.push([k, v]);
		} else {
			throw error_with(`invalid type: "${k}"`, undefined, {key: k, value: v})
		}
	}
	for (let [k, v] of after) {
		path.push(encode_key(k));
		if (Array.isArray(v)) {
			let header = `[[${path.join('.')}]]`;
			for (let x of v) {
				lines.push(header);
				write(lines, x, path);
			}
		} else {
			lines.push(`[${path.join('.')}]`);
			write(lines, v, path);
		}
		path.pop();
	}
}

function format_value(x) {
	if (typeof x === 'number' && Number.isInteger(x) && x > 9223372036854775000e0) {
		return '9223372036854775000'; // next smallest javascript integer below 2^63-1
	} 
	return JSON.stringify(x);
}

function encode_key(x) {
	return /^[a-z_][a-z0-9_]*$/i.test(x) ? x : JSON.stringify(x);
}

function is_basic(x) {
	//if (x === null) return true;
	switch (typeof x) {
		case 'boolean':
		case 'number':
		case 'string': return true;
	}
}

/*
console.log(encode({
	"fruits": [
		{
			"name": "apple",
			"physical": {
				"color": "red",
				"shape": "round"
			},
			"varieties": [
				{ "name": "red delicious" },
				{ "name": "granny smith" }
			]
		},
		{
			"name": "banana",
			"varieties": [
				{ "name": "plantain" }
			]
		}
	]
}));
*/

// https://docs.soliditylang.org/en/latest/grammar.html#a4.SolidityLexer.Identifier

function on_newline(fn) {
	let prior = '';
	return buf => {
		prior += buf.toString();
		let v = prior.split('\n');
		prior = v.pop();
		v.forEach(x => fn(x));
	};
}

function is_pathlike(x) {
	return typeof x === 'string' || x instanceof URL;
}

function remove_sol_ext(s) {
	return s.replace(/\.sol$/, '');
}

const CONFIG_NAME = 'foundry.toml';

function ansi(c, s) {
	return `\u001b[${c}m${s}\u001b[0m`;
}
function strip_ansi(s) {
	return s.replaceAll(/[\u001b][^m]+m/g, ''); //.split('\n');
}

const TAG_START  =            'LAUNCH'; //ansi('34', 'LAUNCH');
const TAG_DEPLOY = ansi('33', 'DEPLOY');
const TAG_LOG    = ansi('36', 'LOG');
const TAG_TX     = ansi('33', 'TX');
const TAG_STOP   =            'STOP'; // ansi('34', '**STOP');

const DEFAULT_WALLET = 'admin';
const DEFAULT_PROFILE = 'default';

const _OWNER = Symbol('blocksmith');
const _NAME  = Symbol('blocksmith.name');
function get_NAME() {
	return this[_NAME];
}

function take_hash(s) {
	return s.slice(2, 10);
}

// async function delayed_printer(promise, delay, fn) {
// 	let timer = setTimeout(fn, delay);	
// 	return promise.finally(() => clearTimeout(timer));
// }

async function exec_json(cmd, args, env) {
	let timer = setTimeout(() => console.log(cmd, args), 1000); // TODO: make this customizable
	return new Promise((ful, rej) => {
		let proc = spawn(cmd, args, {encoding: 'utf8', env});
		let stdout = '';
		let stderr = '';
		proc.stderr.on('data', chunk => stderr += chunk);
		proc.stdout.on('data', chunk => stdout += chunk);
		proc.on('exit', code => {
			try {
				if (!code) {
					return ful(JSON.parse(stdout));
				}
			} catch (err) {
			}
			rej(error_with('expected JSON output', {code, error: strip_ansi(stderr), cmd, args}));
		});
	}).finally(() => clearTimeout(timer));
}

//export async function evaluate(`return (1)`, ['uint256']);

async function compile(sol, {contract, foundry, optimize, smart = true} = {}) {
	if (Array.isArray(sol)) {
		sol = sol.join('\n');
	}
	if (!contract) {
		let match = sol.match(/contract\s([a-z$_][0-9a-z$_]*)/i);
		if (!match) throw error_with('expected contract name', {sol});
		contract = match[1];
	}
	if (smart) {
		if (!/^\s*pragma\s+solidity/m.test(sol)) {
			sol = `pragma solidity >=0.0.0;\n${sol}`;
		}
		if (!/^\s*\/\/\s*SPDX-License-Identifier:/m.test(sol)) {
			sol = `// SPDX-License-Identifier: UNLICENSED\n${sol}`;
		}
	}
	let hash = take_hash(ethers.id(sol)); // TODO should this be more random
	let root = join(await realpath(tmpdir()), 'blocksmith', hash);
	
	await rm(root, {recursive: true, force: true}); // better than --force 
	
	let src = join(root, foundry?.config.src ?? 'src');
	await mkdir(src, {recursive: true});
	let file = join(src, `${contract}.sol`);
	await writeFile(file, sol);

	let args = [
		'build',
		'--format-json',
		'--root', root,
		'--no-cache', // rmdir() so cache is useless
	];
	
	let env = {...process.env, FOUNDRY_PROFILE: DEFAULT_PROFILE};
	let config;
	if (foundry) {
		config = JSON.parse(JSON.stringify(foundry.config)); // structuredClone?
		let remappings = [
			['@src', foundry.config.src], // this is nonstandard
			['@test', foundry.config.test],
			...config.remappings.map(s => s.split('='))
		];
		config.remappings = remappings.map(([a, b]) => `${a}=${join(foundry.root, b)}`);
	} else {
		config = {};
	}
	
	// cant use --optimize, no way to turn it off
	let config_file = join(root, CONFIG_NAME);
	if (optimize !== undefined) {
		if (optimize === true) optimize = 200;
		if (optimize === false) {
			config.optimizer = false;
		} else {
			config.optimizer = true;
			config.optimizer_runs = optimize; // TODO: parse?
		}
	}
	await writeFile(config_file, encode({profile: {[DEFAULT_PROFILE]: config}}));
	args.push('--config-path', config_file);

	let res = await exec_json(foundry?.forge ?? 'forge', args, env);
	let errors = filter_errors(res.errors);
	if (errors.length) {
		throw error_with('forge build', {sol, errors});
	}
	let info = res.contracts[file]?.[contract]?.[0];
	let origin = `InlineCode{${hash}}`;
	if (!info) {
		for (let x of Object.values(res.contracts)) {
			let c = x[contract];
			if (c) {
				info = c[0];
				//origin = '@import';
				break;
			}
		}
		if (!info) {
			throw error_with('expected contract', {sol, contracts: Object.keys(res.contracts), contract});
		}
	}
	let {contract: {abi, evm}} = info;
	abi = ethers.Interface.from(abi);
	let bytecode = '0x' + evm.bytecode.object;
	let deployedBytecode = '0x' + evm.deployedBytecode.object; // TODO: decide how to do this
	return {abi, bytecode, deployedBytecode, contract, origin, sol};
}

// should this be called Foundry?
class FoundryBase {
	static profile() {
		return process.env.FOUNDRY_PROFILE ?? DEFAULT_PROFILE;
	}
	// should
	static async root(cwd) {
		let dir = await realpath(cwd || process.cwd());
		while (true) {
			let file = join(dir, 'foundry.toml');
			try {
				await access(file);
				return dir;
			} catch {
			}
			let parent = dirname(dir);
			if (parent === dir) throw error_with(`expected ${CONFIG_NAME}`, {cwd});
			dir = parent;
		}
	}
	static async load({root, profile, forge = 'forge', ...unknown} = {}) {
		if (Object.keys(unknown).length) {
			throw error_with('unknown options', unknown);
		}
		if (!root) root = await this.root();
		//root = await realpath(root); // do i need this?
		if (!profile) profile = this.profile();
		let config;
		try {
			config = await exec_json(forge, ['config', '--root', root, '--json'], {...process.env, FOUNDRY_PROFILE: profile});
		} catch (err) {
			throw error_with(`invalid ${CONFIG_NAME}`, {root, profile}, err);
		}
		return Object.assign(new this, {root, profile, config, forge});
	}
	async build(force) {
		if (!force && this.built) return this.built;
		let args = ['build', '--format-json', '--root', this.root];
		if (force) args.push('--force');
		let res = await exec_json(this.forge, args, {...process.env, FOUNDRY_PROFILE: this.profile});
		let errors = filter_errors(res.errors);
		if (errors.length) {
			throw error_with('forge build', {errors});
		}
		return this.built = {date: new Date()};
	}
	async find({file, contract}) {
		await this.build();
		file = remove_sol_ext(file); // remove optional extension
		if (!contract) contract = basename(file); // derive contract name from file name
		file += '.sol'; // add extension
		let tail = join(basename(file), `${contract}.json`);
		let path = dirname(file);
		while (true) {
			try {
				let out_file = join(this.root, this.config.out, path, tail);
				await access(out_file);
				return out_file;
			} catch (err) {
				let parent = dirname(path);
				if (parent === path) throw error_with('unknown contract', {file, contract});
				path = parent;
			}
		}
	}
	async resolveArtifact(args) {
		let {import: imported, sol, bytecode, abi, file, contract, ...rest} = args;
		if (imported) {
			sol = `import "${imported}";`;
			contract = remove_sol_ext(basename(imported));
		}
		if (sol) {
			// TODO: should this be .compile?
			return compile(sol, {contract, foundry: this, ...rest});
		} else if (bytecode) {
			if (!contract) contract = 'Unnamed';
			abi = ethers.Interface.from(abi);
			return {abi, bytecode, contract, origin: 'Bytecode'}
		} else if (file) {
			return this.fileArtifact({file, contract});
		}
		throw error_with('unknown artifact', args);
	}
	// async compileArtifact({sol, contract, ...rest}) {
	// 	return compile(sol, {contract, rest})
	// }
	async fileArtifact(args) {
		let file = await this.find(args);
		let artifact = JSON.parse(await readFile(file));
		let [origin, contract] = Object.entries(artifact.metadata.settings.compilationTarget)[0]; // TODO: is this correct?
		let bytecode = artifact.bytecode.object;
		let abi = ethers.Interface.from(artifact.abi);
		return {abi, bytecode, contract, origin, file};
	}
	tomlConfig() {
		return encode({profile: {[this.profile]: this.config}});
	}

	
}

class Foundry extends FoundryBase {
	static async launch({
		port = 0,
		wallets = [DEFAULT_WALLET],
		anvil = 'anvil',
		chain,
		infiniteCallGas,
		gasLimit,
		blockSec,
		autoClose = true,
		fork, 
		procLog,
		infoLog = true,
		...rest
	} = {}) {
		let self = await this.load(rest);

		if (!infoLog) infoLog = undefined;
		if (!procLog) procLog = undefined;
		if (infoLog === true) infoLog = console.log.bind(console);
		if (procLog === true) procLog = console.log.bind(console);

		return new Promise((ful, rej) => {
			let args = [
				'--port', port,
				'--accounts', 0, // create accounts on demand
			];
			if (chain) args.push('--chain-id', chain);
			if (blockSec) args.push('--block-time', blockSec);
			if (infiniteCallGas) {
				//args.push('--disable-block-gas-limit');
				// https://github.com/foundry-rs/foundry/pull/6955
				// currently bugged
				//gasLimit = '9223372036854775000'; // nextBefore(2^63-1)
				gasLimit = '99999999999999999999999';
			}
			if (gasLimit) args.push('--gas-limit', gasLimit);
			if (fork) args.push('--fork-url', fork);
			let proc = spawn(anvil, args);
			proc.stdin.end();
			const fail = data => {
				proc.kill();
				rej(error_with('launch', {args, stderr: data.toString()}));
			};
			proc.stderr.once('data', fail);
			let lines = [];
			const waiter = on_newline(line => {
				lines.push(line);
				// 20240319: there's some random situation where anvil doesnt
				// print a listening endpoint in the first stdout flush
				let match = line.match(/^Listening on (.*)$/);
				if (match) init(lines.join('\n'), match[1]);
				// does this need a timeout?
			});
			proc.stdout.on('data', waiter);
			async function init(bootmsg, host) {
				proc.stdout.removeListener('data', waiter);
				proc.stderr.removeListener('data', fail);
				if (autoClose) {
					const kill = () => proc.kill();
					process.on('exit', kill);
					proc.once('exit', () => process.removeListener('exit', kill));
				}
				if (is_pathlike(procLog)) {
					let out = createWriteStream(procLog);
					out.write(bootmsg + '\n');
					proc.stdout.pipe(out);
				} else if (procLog) {
					// pass string
					procLog(bootmsg);
					proc.stdout.on('data', on_newline(procLog)); // TODO: how to intercept console2
				}
				if (is_pathlike(infoLog)) {
					let console = new Console(createWriteStream(infoLog));
					infoLog = console.log.bind(console);
				}
				let endpoint = `ws://${host}`;
				port = parseInt(host.slice(host.lastIndexOf(':') + 1));
				let provider = new ethers.WebSocketProvider(endpoint, chain, {staticNetwork: true});
				//let provider = new ethers.IpcSocketProvider('/tmp/anvil.ipc', chain, {staticNetwork: true});
				if (!chain) {
					chain = parseInt(await provider.send('eth_chainId')); // determine chain id
				}
				let automine = await provider.send('anvil_getAutomine');
				if (automine) {
					provider.destroy();
					provider = new ethers.WebSocketProvider(endpoint, chain, {staticNetwork: true, cacheTimeout: -1});
				}
				Object.assign(self, {proc, provider, infoLog, procLog, endpoint, chain, port, automine, anvil});
				wallets = await Promise.all(wallets.map(x => self.ensureWallet(x)));
				if (infoLog) {
					const t = Date.now();
					infoLog(TAG_START, self.pretty({chain, endpoint, wallets}));
					proc.once('exit', () => infoLog(TAG_STOP, `${Date.now() - t}ms`)); // TODO fix me
				}
				ful(self);
			}
		});
	}
	constructor() {
		super();
		this.accounts = new Map();
		this.event_map = new Map();
		this.error_map = new Map();
		this.wallets = {};
	}
	async shutdown() {
		return new Promise(ful => {
			this.provider.destroy();
			this.proc.once('exit', ful);
			this.proc.kill();
		});
	}
	async nextBlock(n = 1) {
		await this.provider.send('anvil_mine', [ethers.toBeHex(n)]);
	}
	requireWallet(...xs) {
		for (let x of xs) {
			if (!x) continue;
			if (x instanceof ethers.Wallet) {
				if (x[_OWNER] === this) return x;
				throw error_with('unowned wallet', {wallet: x});
			}
			let address = to_address(x);
			if (address) {
				let a = this.accounts.get(address);
				if (a) return a;
			} else if (typeof x === 'string') {
				let a = this.wallets[x];
				if (a) return a;
			}
			throw error_with('expected wallet', {wallet: x});
		}
		throw new Error('missing required wallet');
	}
	async createWallet({prefix = 'random', ...a} = {}) {
		let id = 0;
		while (true) {
			let name = `${prefix}${++id}`; // TODO fix O(n)
			if (!this.wallets[name]) {
				return this.ensureWallet(name, a);
			}
		}
	}
	async ensureWallet(x, {ether = 10000} = {}) {
		if (x instanceof ethers.Wallet) return this.requireWallet(x);
		if (!x || typeof x !== 'string' || is_address(x)) {
			throw error_with('expected wallet name', {name: x});
		}
		let wallet = this.wallets[x];
		if (!wallet) {
			wallet = new ethers.Wallet(ethers.id(x), this.provider);
			ether = BigInt(ether);
			if (ether > 0) {
				await this.provider.send('anvil_setBalance', [wallet.address, ethers.toBeHex(ether * BigInt(1e18))]);
			}
			wallet[_NAME] = x;
			wallet[_OWNER] = this;
			wallet.toString = get_NAME;
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
						[inspect.custom]() { 
							return ansi('35', x[_NAME]);
						}
					};
				} else if (x instanceof ethers.Indexed) {
					return {
						[inspect.custom]() { 
							return ansi('36', `'${x.hash}'`);
						}
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
	parseError(err) {
		// TODO: fix me
		if (err.code === 'CALL_EXCEPTION') {
			let {data} = err;
			console.log(this.error_map);
			let bucket = this.error_map.get(data.slice(0, 10));
			console.log('bucket', bucket);
			if (bucket) {
				for (let abi of bucket.values()) {
					try {
						return abi.parseError(data);
					} catch (err) {
					}
				}
			}
		}
	}
	async confirm(p, {silent, ...extra} = {}) {
		let tx = await p;
		let receipt = await tx.wait();
		let args = {gas: receipt.gasUsed, ...extra};
		let contract = this.accounts.get(receipt.to);
		if (!silent) {
			if (contract instanceof ethers.BaseContract) {
				let desc = contract.interface.parseTransaction(tx);
				Object.assign(args, desc.args.toObject());
				this.infoLog?.(TAG_TX, this.pretty(receipt.from), `${contract[_NAME]}.${desc.signature}`, this.pretty(args));
				this._dump_logs(contract.interface, receipt);
			} else {
				this.infoLog?.(TAG_TX, this.pretty(receipt.from), '>>', this.pretty(receipt.to), this.pretty(args));
			}
		}
		return receipt;
	}
	_dump_logs(abi, receipt) {
		const {infoLog} = this;
		if (!infoLog) return;
 		for (let x of receipt.logs) {
			let log = abi.parseLog(x);
			if (!log) {
				// TODO: remove fastpast since this is probably better
				let abi = this.event_map.get(x.topics[0]);
				if (abi) {
					log = abi.parseLog(x);
				}
				/*
				for (let c of this.accounts.values()) {
					if (c instanceof ethers.BaseContract) {
						log = c.interface.parseLog(x);
						if (log) break;
					}
				}
				*/
			}
			if (log) {
				infoLog(TAG_LOG, log.signature, this.pretty(log.args.toObject()));
			}
		}
	}
	async deployed({from, at, ...artifactLike}) {
		let w = await this.ensureWallet(from || DEFAULT_WALLET);
		let {abi, ...artifact} = await this.resolveArtifact(artifactLike);
		let c = new ethers.Contract(at, abi, w);
		c[_NAME] = `${artifact.contract}<${take_hash(c.target)}>`; 
		c[_OWNER] = this;
		c.toString = get_NAME;
		c.__artifact = artifact;
		this.accounts.set(c.target, c);
		return c;
	}
	async deploy({from, args = [], silent, ...artifactLike}) {
		let w = await this.ensureWallet(from || DEFAULT_WALLET);
		let {abi, bytecode, ...artifact} = await this.resolveArtifact(artifactLike);
		bytecode = ethers.getBytes(bytecode);
		if (!bytecode.length) throw error_with('no bytecode', artifact);
		let factory = new ethers.ContractFactory(abi, bytecode, w);
		let unsigned = await factory.getDeployTransaction(...args);
		let tx = await w.sendTransaction(unsigned);
		let receipt = await tx.wait();

		let c = new ethers.Contract(receipt.contractAddress, abi, w);
		c[_NAME] = `${artifact.contract}<${take_hash(c.target)}>`; // so we can deploy the same contract multiple times
		c[_OWNER] = this;
		c.toString = get_NAME;
		c.__artifact = artifact;
		c.__receipt = receipt;

		let code = ethers.getBytes(await this.provider.getCode(c.target));
		c.__bytecode = code;

		this.accounts.set(c.target, c);
		abi.forEachEvent(e => this.event_map.set(e.topicHash, abi));
		abi.forEachError(e => {
			let bucket = this.error_map.get(e.selector);
			if (!bucket) {
				bucket = new Map();
				this.error_map.set(e.selector, bucket);
			}
			bucket.set(ethers.id(e.format('sighash')), abi);
		});
		if (!silent) {
			this.infoLog?.(TAG_DEPLOY, this.pretty(w), artifact.origin, this.pretty(c), `${ansi('33', receipt.gasUsed)}gas ${ansi('33', code.length)}bytes`); // {address, gas: receipt.gasUsed, size: code.length});
			this._dump_logs(abi, receipt);
		}
		return c;
	}
}

function filter_errors(errors) {
	return errors.filter(x => x.severity === 'error');
}

function split(s) {
	return s ? s.split('.') : [];
}

class Node extends Map {
	static root() {
		return new this(null, ethers.ZeroHash, '[root]');
	}
	static create(name) {
		return name instanceof this ? name : this.root().create(name);
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
	get dns() {
		return ethers.getBytes(ethers.dnsEncode(this.name, 255));
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
	get isETH2LD() {
		return this.parent?.name === 'eth';
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

class Resolver {
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

export { Foundry, FoundryBase, Node, Resolver, compile, error_with, is_address, to_address };
