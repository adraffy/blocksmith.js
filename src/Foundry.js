import {spawn} from 'node:child_process';
import {ethers} from 'ethers';
import {createWriteStream} from 'node:fs';
import {readFile, writeFile, rm, mkdir, access, realpath, mkdtemp} from 'node:fs/promises';
import {join, dirname, basename, sep as PATH_SEP} from 'node:path';
import {tmpdir} from 'node:os';
import {error_with, is_address, to_address} from './utils.js';
import {inspect} from 'node:util';
import {Console} from 'node:console';
import * as Toml from './toml.js';
import EventEmitter from 'node:events';

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
	return `\x1B[${c}m${s}\u001b[0m`;
}
function strip_ansi(s) {
	return s.replaceAll(/[\u001b][^m]+m/g, ''); //.split('\n');
}

const TAG_START   = ansi('93', 'LAUNCH');
const TAG_DEPLOY  = ansi('33', 'DEPLOY');
const TAG_TX      = ansi('33', 'TX');
const TAG_EVENT   = ansi('36', 'EVENT');
const TAG_CONSOLE = ansi('96', 'LOG');
const TAG_STOP    = ansi('93', 'STOP'); 

const DEFAULT_WALLET = 'admin';
const DEFAULT_PROFILE = 'default';

const Symbol_foundry = Symbol('blocksmith');
const Symbol_name  = Symbol('blocksmith.name');
const Symbol_makeErrors = Symbol('blocksmith.makeError');
function get_NAME() {
	return this[Symbol_name];
}

function smol_addr(addr) {
	return addr.slice(2, 10);
}

function parse_cid(cid) {
	let pos = cid.lastIndexOf(':');
	let contract;
	if (pos == -1) {
		contract = remove_sol_ext(basename(cid));
	} else {
		contract = remove_sol_ext(cid.slice(pos + 1));
		cid = cid.slice(0, pos);
	}
	let path = cid.split(PATH_SEP).reverse();
	return {contract, path};
}

class ContractMap {
	constructor() {
		this.map = new Map();
	}
	add(cid, value) {
		let {contract, path} = parse_cid(cid);
		let bucket = this.map.get(contract);
		if (!bucket) {
			bucket = [];
			this.map.set(contract, bucket);
		}
		bucket.push({path, value});
	}
	find(cid) {
		let {contract, path} = parse_cid(cid);
		let bucket = this.map.get(contract);
		if (bucket) {
			let i = 0;
			for (; bucket.length > 1 && i < path.length; i++) {
				bucket = bucket.filter(x => x.path[i] === path[i]);
			}
			if (bucket.length == 1) {
				let cid = i ? `${path.slice(0, i).reverse().join(PATH_SEP)}:${contract}` : contract;
				return [cid, bucket[0].value];
			}
		}
		return [];
	}
}

async function exec(cmd, args, env, json = true) {
	// 20240905: bun bug
	// https://github.com/oven-sh/bun/issues/13755
	// this fix is absolute garbage
	// idea#1: use chunks[0].length != 262144
	// 20240905: doesn't work
	// idea#2: assume json, check for leading curly: /^\s*{/
	// if (process.isBun && stdout.length > 1 && stdout[0][0] !== 0x7B) {
	// 	console.log('out of order', stdout.map(x => x.length));
	// 	let chunk = stdout[0];
	// 	stdout[0] = stdout[1];
	// 	stdout[1] = chunk;
	// }
	// 20240905: just use file until theres a proper fix
	// https://github.com/oven-sh/bun/issues/4798
	// 20240914: had to revert this fix as it causes more bugs than it fixes
	// https://github.com/oven-sh/bun/issues/13972
	// 20240921: another attempt to fix this bun shit
	// just yolo swap the buffers if it parses incorrectly
	try {
		let stdout = await new Promise((ful, rej) => {
			let proc = spawn(cmd, args, {
				env: {...process.env, ...env}, 
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = [];
			let stderr = [];
			proc.stdout.on('data', chunk => stdout.push(chunk));
			proc.stderr.on('data', chunk => stderr.push(chunk));
			proc.on('close', code => {
				if (code) {
					let error = Buffer.concat(stderr).toString('utf8');
					error = strip_ansi(error);
					error = error.replaceAll(/^Error:/g, '');
					error = error.trim();
					// 20240916: put more info in message since bun errors are dogshit
					rej(new Error(`${cmd}: ${error} (code=${code})`));
				} else {
					//ful(Buffer.concat(stdout));
					ful(stdout);
				}
			});
		});
		if (!json) {
			return Buffer.concat(stdout);
		}
		try {
			const buf = Buffer.concat(stdout);
			return JSON.parse(buf);
		} catch (bug) {
			if (stdout.length > 1) {
				let v = stdout.slice();
				v[0] = stdout[1];
				v[1] = stdout[0];
				return JSON.parse(Buffer.concat(v));
			}
			throw bug;
		}
	} catch (err) {
		throw Object.assign(err, {cmd, args, env});
	}
}

export async function compile(sol, options = {}) {
	let {
		contract,
		foundry, 
		optimize, 
		autoHeader = true, 
		solcVersion, 
		evmVersion,
		viaIR
	} = options;
	if (Array.isArray(sol)) {
		sol = sol.join('\n');
	}
	if (!contract) {
		let match = sol.match(/(contract|library)\s([a-z$_][0-9a-z$_]*)/i);
		if (!match) throw error_with('expected contract name', {sol});
		contract = match[2];
	}
	if (autoHeader) {
		if (!/^\s*pragma\s+solidity/m.test(sol)) {
			sol = `pragma solidity >=0.0.0;\n${sol}`;
		}
		if (!/^\s*\/\/\s*SPDX-License-Identifier:/m.test(sol)) {
			sol = `// SPDX-License-Identifier: UNLICENSED\n${sol}`;
		}
	}
	
	let root = await mkdtemp(join(await realpath(tmpdir()), 'blocksmith/'));
	
	await rm(root, {recursive: true, force: true}); // better than --force 
	
	let src = join(root, foundry?.config.src ?? 'src');
	await mkdir(src, {recursive: true});
	let file = join(src, `${contract}.sol`);
	await writeFile(file, sol);

	let forge = foundry ? foundry.forge : 'forge';
	let args = [
		'build',
		'--format-json',
		'--root', root,
		'--no-cache',
	];
	
	let profile = DEFAULT_PROFILE;
	let env = {FOUNDRY_PROFILE: profile};
	let config;
	if (foundry) {
		config = JSON.parse(JSON.stringify(foundry.config)); // structuredClone?
		let remappings = [
			['@src', foundry.config.src], // this is nonstandard
			['@test', foundry.config.test],
			...config.remappings.map(s => s.split('='))
		];
		config.remappings = remappings.map(([a, b]) => {
			let pos = a.indexOf(':');
			if (pos >= 0) {
				// support remapping contexts
				a = join(foundry.root, a.slice(0, pos)) + a.slice(pos);
			}
			return `${a}=${join(foundry.root, b)}`;
		});
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
	if (solcVersion) config.solc_version = solcVersion;
	if (evmVersion) config.evm_version = evmVersion;
	if (viaIR !== undefined) config.via_ir = !!viaIR;

	await writeFile(config_file, Toml.encode({profile: {[profile]: config}}));
	args.push('--config-path', config_file);

	const buildInfo = {
		started: new Date(),
		root,
		cmd: [forge, ...args],
		profile,
		mode: foundry ? 'shadow' : 'isolated',
		force: true
	};
	foundry?.emit('building', buildInfo);
	let res = await exec(forge, args, env);
	let errors = filter_errors(res.errors);
	if (errors.length) {
		throw error_with('forge build', {sol, errors});
	}
	buildInfo.sources = Object.keys(res.sources);
	foundry?.emit('built', buildInfo);

	let info = res.contracts[file]?.[contract]?.[0];
	let origin = `InlineCode{${root.slice(-6)}}`;
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
	abi = abi_from_solc_json(abi);
	let bytecode = '0x' + evm.bytecode.object;
	let links = extract_links(evm.bytecode.linkReferences);
	//let deployedBytecode = '0x' + evm.deployedBytecode.object; // TODO: decide how to do this
	//let deployedByteCount = evm.deployedBytecode.object.length >> 1;
	// 20241002: do this is general with a decompiler
	return {abi, bytecode, contract, origin, links, sol, root};
}

// should this be called Foundry?
export class FoundryBase extends EventEmitter {
	constructor() {
		super();
	}
	static profile() {
		return process.env.FOUNDRY_PROFILE ?? DEFAULT_PROFILE;
	}
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
			config = await exec(forge, ['config', '--root', root, '--json'], {FOUNDRY_PROFILE: profile});
		} catch (err) {
			throw error_with(`invalid ${CONFIG_NAME}`, {root, profile}, err);
		}
		return Object.assign(new this, {root, profile, config, forge});
	}
	async version() {
		const buf = await exec(this.forge, ['--version'], {}, false);
		return buf.toString('utf8').trim();
	}
	async exportArtifacts(dir, {force = true, tests = false, scripts = false} = {}) {
		let args = [
			'build',
			'--format-json',
			'--root', this.root,
			'--no-cache',
			// this is gigadangerous if not relative
			// forge will happily just delete your entire computer
			// if you pass: "--out=/"
			'--out', join(this.root, dir),
		];
		if (force) args.push('--force');
		if (!tests) args.push('--skip', 'test');
		if (!scripts) args.push('--skip', 'script');
		//let res = await exec(this.forge, args, {FOUNDRY_PROFILE: this.profile}, this.procLog);
		//return res.errors;
		return args;
	}
	async build(force) {
		if (!force && this.built) return this.built;
		let {root, profile} = this;
		let args = ['build', '--format-json', '--root', root];
		if (force) args.push('--force');
		const buildInfo = {
			started: new Date(),
			root,
			cmd: [this.forge, ...args],
			force,
			profile,
			mode: 'project'
		};
		this.emit('building', buildInfo);
		let res = await exec(this.forge, args, {FOUNDRY_PROFILE: profile});
		let errors = filter_errors(res.errors);
		if (errors.length) {
			throw error_with('forge build', {errors});
		}
		buildInfo.sources = Object.keys(res.sources);
		this.emit('built', buildInfo);
		return this.built = {date: new Date()};
	}
	async find({file, contract}) {
		await this.build();
		file = remove_sol_ext(file); // remove optional extension
		contract ??= basename(file); // derive contract name from file name
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
				if (parent === path) throw error_with(`unknown contract: ${file}:${contract}`, {file, contract});
				path = parent;
			}
		}
	}
	compile(sol, options = {}) {
		return compile(sol, {...options, foundry: this});
	}
	resolveArtifact(arg0) {
		let {import: imported, bytecode, abi, sol, file, contract, ...rest} = arg0;
		if (bytecode) { // bytecode + abi
			contract ??= 'Unnamed';
			abi = iface_from(abi ?? []);
			return {abi, bytecode, contract, origin: 'Bytecode', links: []};
		}
		if (imported) {
			sol = `import "${imported}";`;
			contract ??= remove_sol_ext(basename(imported));
			rest.autoHeader = true; // force it
		}
		if (sol) { // sol code + contract?
			return compile(sol, {contract, foundry: this, ...rest});
		} else if (file) { // file + contract?
			return this.fileArtifact({file, contract});
		}
		throw error_with('unknown artifact', arg0);
	}
	async fileArtifact(arg0) {
		let {file} = arg0;
		let artifact;
		if (typeof file === 'object') { // inline artifact
			artifact = file;
			file = undefined;
		} else {
			if (!file.endsWith('.json')) {
				file = await this.find(arg0);
			}
			artifact = JSON.parse(await readFile(file));
		}
		let [origin, contract] = Object.entries(artifact.metadata.settings.compilationTarget)[0]; // TODO: is this correct?
		let bytecode = artifact.bytecode.object;
		let links = extract_links(artifact.bytecode.linkReferences);
		let abi = abi_from_solc_json(artifact.abi);
		return {abi, bytecode, contract, origin, file, links};
	}
	linkBytecode(bytecode, links, libs) {
		let map = new ContractMap();
		for (let [cid, impl] of Object.entries(libs)) {
			let address = to_address(impl);
			if (!address) throw error_with(`unable to determine library address: ${file}`, {file, impl});
			map.add(cid, address);
		}
		let linked = Object.fromEntries(links.map(link => {
			let cid = `${link.file}:${link.contract}`;
			let [prefix, address] = map.find(cid);
			if (!prefix) throw error_with(`unlinked external library: ${cid}`, link);
			for (let offset of link.offsets) {
				offset = (1 + offset) << 1;
				bytecode = bytecode.slice(0, offset) + address.slice(2) + bytecode.slice(offset + 40);
			}
			return [prefix, address];
		}));
		bytecode = ethers.getBytes(bytecode);
		return {bytecode, linked, libs};
	}
	tomlConfig() {
		return Toml.encode({profile: {[this.profile]: this.config}});
	}
	// async deployArtifact() {
	// 	// create server?
	// 	// create static html?
	// }
}

function has_key(x, key) {
	return typeof x === 'object' && x !== null && key in x;
}

export class Foundry extends FoundryBase {
	static of(x) {
		if (!has_key(x, Symbol_foundry)) throw new TypeError(`expected Contract or Wallet`);
		return x[Symbol_foundry];
	}
	static async launch({
		port = 0,
		wallets = [DEFAULT_WALLET],
		anvil = 'anvil',
		chain,
		infiniteCallGas,
		gasLimit,
		blockSec,
		autoClose = true,
		genesisTimestamp,
		hardfork = 'latest',
		backend = 'ethereum',
		fork, 
		procLog,
		infoLog = true,
		...rest
	} = {}) {
		let self = await this.load(rest);
		if (!infoLog) infoLog = undefined;
		if (infoLog === true) infoLog = console.log.bind(console);
		if (!procLog) procLog = undefined;
		if (backend !== 'ethereum' && backend !== 'optimism') {
			throw error_with(`unknown backend: ${backend}`, {backend});
		}
		hardfork = hardfork.toLowerCase().trim();
		if (hardfork === 'forge') {
			hardfork = this.config.evm_version;
		}
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
				// 20240819: still bugged
				// https://github.com/foundry-rs/foundry/pull/8274
				// 20240827: yet another bug
				// https://github.com/foundry-rs/foundry/issues/8759
				// 20241026: appears fixed
				args.push('--disable-block-gas-limit');
			} else if (gasLimit) {
				args.push('--gas-limit', gasLimit);
			}
			if (fork) {
				fork = String(fork);
				args.push('--fork-url', fork);
			}
			if (genesisTimestamp !== undefined) {
				args.push('--timestamp', genesisTimestamp);
			}
			if (hardfork !== 'latest') {
				args.push('--hardfork', hardfork);
			}
			if (backend === 'optimism') {
				args.push('--optimism');
			}
			let proc = spawn(anvil, args, {
				env: {...process.env, RUST_LOG: 'node=info'},
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			const fail = data => {
				proc.kill();
				let error = strip_ansi(data.toString()).trim();
				let title = 'unknown launch error';
				let match = error.match(/^Error: (.*)/);
				if (match) title = match[1];
				rej(error_with(title, {args, error}));
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
				if (is_pathlike(infoLog)) {
					let console = new Console(createWriteStream(infoLog));
					infoLog = console.log.bind(console);
				}
				if (is_pathlike(procLog)) {
					let out = createWriteStream(procLog);
					out.write(bootmsg + '\n');
					proc.stdout.pipe(out);
					procLog = false;
				} else if (procLog) {
					procLog(bootmsg);
				}
				let show_log = true; // 20240811: foundry workaround for gas estimation spam
				proc.stdout.on('data', on_newline(line => {
					// https://github.com/foundry-rs/foundry/issues/7681
					// https://github.com/foundry-rs/foundry/issues/8591
					// [2m2024-08-02T19:38:31.399817Z[0m [32m INFO[0m [2mnode::user[0m[2m:[0m anvil_setLoggingEnabled
					let match = line.match(/^(\x1B\[\d+m\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\x1B\[0m) \x1B\[\d+m([^\x1B]+)\x1B\[0m \x1B\[\d+m([^\x1B]+)\x1B\[0m\x1B\[2m:\x1B\[0m (.*)$/);
					if (match) {
						let [_, time, _level, kind, line] = match;
						if (kind === 'node::user') {
							// note: this gets all fucky when weaving promises
							// but i dont know of any work around until this is fixed
							show_log = line !== 'eth_estimateGas';
						} else if (kind === 'node::console') {
							if (show_log) {
								self.emit('console', line);
								infoLog?.(TAG_CONSOLE, time, line);
							}
							return;
						}
					}
					procLog?.(line);
				}));
				let endpoint = `ws://${host}`;
				port = parseInt(host.slice(host.lastIndexOf(':') + 1));
				let provider = new ethers.WebSocketProvider(endpoint, chain, {staticNetwork: true});
				//let provider = new ethers.IpcSocketProvider('/tmp/anvil.ipc', chain, {staticNetwork: true});
				chain ??= parseInt(await provider.send('eth_chainId')); // determine chain id
				let automine = !!await provider.send('anvil_getAutomine');
				if (automine) {
					provider.destroy();
					provider = new ethers.WebSocketProvider(endpoint, chain, {staticNetwork: true, cacheTimeout: -1});
				}
				Object.assign(self, {
					anvil, proc, provider,
					infoLog, procLog,
					endpoint, chain, port, fork,
					automine, hardfork, backend,
					started: new Date(),
				});
				wallets = await Promise.all(wallets.map(x => self.ensureWallet(x)));
				infoLog?.(TAG_START, self.pretty({chain, endpoint, wallets}));
				proc.once('exit', () => {
					self.emit('shutdown');
					infoLog?.(TAG_STOP, `${ansi('33', Date.now() - self.started)}ms`); // TODO fix me
				});
				ful(self);
			}
		});
	}
	constructor() {
		super();
		this.accounts = new Map();
		this.write_map = new Map();
		this.event_map = new Map();
		const error_map = this.error_map = new Map();
		this.wallets = {};
		this.error_fixer = function(data, tx) {
			const error0 = this[Symbol_makeErrors](data, tx);
			if (!error0.reason) {
				let bucket = error_map.get(ethers.dataSlice(data, 0, 4));
				if (bucket) {
					for (let abi of bucket.values()) {
						let error = abi.makeError(data, tx);
						if (error.reason) {
							error.invocation ??= error0.invocation;
							return error;
						}
					}
				}
			}
			return error0;
		};
		this.shutdown = () => {
			if (!this.killed) {
				this.killed = new Promise(ful => {
					this.provider.destroy();
					this.proc.once('exit', ful);
					this.proc.kill();
				});
			}
			return this.killed;
		};
	}
	nextBlock({blocks = 1, sec = 1} = {}) {
		return this.provider.send('anvil_mine', [
			ethers.toBeHex(blocks), 
			ethers.toBeHex(sec)
		]);
	}
	setStorageValue(a, slot, value) {
		if (value instanceof Uint8Array) {
			if (value.length != 32) throw new TypeError(`expected exactly 32 bytes`);
			value = ethers.hexlify(value);
		} else {
			value = ethers.toBeHex(value, 32);
		}
		return this.provider.send('anvil_setStorageAt', [to_address(a), ethers.toBeHex(slot, 32), value]);
	}
	setStorageBytes(a, slot, v) {
		// TODO: this does not cleanup (zero higher slots)
		a = to_address(a);
		v = ethers.getBytes(v);
		if (v.length < 32) {
			let u = new Uint8Array(32);
			u.set(v);
			u[31] = v.length << 1;
			return this.setStorageValue(a, slot, u);
		}
		slot = BigInt(slot);
		let ps = [this.setStorageValue(a, slot, (v.length << 1) | 1)];
		let off = BigInt(ethers.solidityPackedKeccak256(['uint256'], [slot]));
		let pos = 0;
		while (pos < v.length) {
			let end = pos + 32;
			if (end > v.length) {
				let u = new Uint8Array(32);
				u.set(v.subarray(pos));
				ps.push(this.setStorageValue(a, off, u));
				break;
			}
			ps.push(this.setStorageValue(a, off++, v.subarray(pos, end)));
			pos = end;
		}
		return Promise.all(ps);
	}
	requireWallet(...xs) {
		for (let x of xs) {
			if (!x) continue;
			if (x instanceof ethers.Wallet) {
				if (x[Symbol_foundry] === this) return x;
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
	randomWallet({prefix = 'random', ...a} = {}) {
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
			wallet[Symbol_name] = x;
			wallet[Symbol_foundry] = this;
			wallet.toString = get_NAME;
			this.wallets[x] = wallet;
			this.accounts.set(wallet.address, wallet);
		}
		return wallet;
	}
	pretty(x) {
		if (x) {
			if (typeof x === 'object') {
				if (Symbol_foundry in x) {
					return {
						[inspect.custom]() { 
							return ansi('35', x[Symbol_name]);
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
	parseTransaction(tx) {
		let bucket = this.write_map.get(tx.data?.slice(0, 10));
		if (!bucket) return;
		for (let abi of bucket.values()) {
			let desc = abi.parseTransaction(tx);
			if (desc) return desc;
		}
	}
	async confirm(p, {silent, confirms, ...extra} = {}) {
		let tx = await p;
		let receipt = await tx.wait(confirms);
		let desc = this.parseTransaction(tx);
		if (!silent && this.infoLog) {
			let args = {gas: receipt.gasUsed, ...extra};
			let action;
			if (desc) {
				Object.assign(args, desc.args.toObject());
				action = desc.signature;
			} else if (tx.data?.length >= 10) {
				action = ansi('90', tx.data.slice(0, 10));
				if (tx.data.length > 10) {
					args.calldata = '0x' + tx.data.slice(10);
				}
			}
			if (tx.value > 0) {
				args.value = tx.value;
			}
			if (action) {
				this.infoLog(TAG_TX, this.pretty(receipt.from), '>>', this.pretty(receipt.to), action, this.pretty(args));
			} else {
				this.infoLog(TAG_TX, this.pretty(receipt.from), '>>', this.pretty(receipt.to), this.pretty(args));
			}
			this._dump_logs(receipt);
		}
		this.emit('tx', tx, receipt, desc);
		return receipt;
	}
	_dump_logs(receipt) {
 		for (let x of receipt.logs) {
			let abi = this.event_map.get(x.topics[0]);
			let event;
			if (abi) {
				event = abi.parseLog(x);
			}
			if (event) {
				if (event.args.length) {
					this.infoLog(TAG_EVENT, event.signature, this.pretty(event.args.toObject()));
				} else {
					this.infoLog(TAG_EVENT, event.signature);
				}
			}
		}
	}
	async deployed({from, at, ...artifactLike}) {
		// TODO: expose this
		let w = await this.ensureWallet(from || DEFAULT_WALLET);
		let {abi, ...artifact} = await this.resolveArtifact(artifactLike);
		let c = new ethers.Contract(at, abi, w);
		c[Symbol_name] = `${artifact.contract}<${smol_addr(c.target)}>`; 
		c[Symbol_foundry] = this;
		c.toString = get_NAME;
		c.__artifact = artifact;
		this.accounts.set(c.target, c);
		return c;
	}
	async deploy(arg0) {
		if (typeof arg0 === 'string') {
			arg0 = arg0.startsWith('0x') ? {bytecode: arg0} : {sol: arg0};
		}
		let {
			from = DEFAULT_WALLET,
			args = [],
			libs = {},
			abis = [],
			confirms,
			silent = false,
			parseAllErrors = true,
			...artifactLike
		} = arg0;
		from = await this.ensureWallet(from);
		let {abi, links, bytecode: bytecode0, origin, contract} = await this.resolveArtifact(artifactLike);
		abi = mergeABI(abi, ...abis);
		if (parseAllErrors) abi = this.parseAllErrors(abi);
		let {bytecode, linked} = this.linkBytecode(bytecode0, links, libs);
		let factory = new ethers.ContractFactory(abi, bytecode, from);
		let unsigned = await factory.getDeployTransaction(...args);
		let tx = await from.sendTransaction(unsigned);
		let receipt = new ethers.ContractTransactionReceipt(abi, this.provider, await tx.wait(confirms));
		let c = new ethers.Contract(receipt.contractAddress, abi, from);
		c[Symbol_name] = `${contract}<${smol_addr(c.target)}>`; // so we can deploy the same contract multiple times
		c[Symbol_foundry] = this;
		c.toString = get_NAME;
		let code = ethers.getBytes(await this.provider.getCode(c.target));
		c.__info = {contract, origin, code, libs: linked, from};
		c.__receipt = receipt;
		this.accounts.set(c.target, c);
		abi.forEachFunction(f => {
			if (f.constant) return;
			let bucket = this.write_map.get(f.selector);
			if (!bucket) {
				bucket = new Map();
				this.write_map.set(f.selector, bucket);
			}
			bucket.set(f.format('sighash'), abi);
		});
		abi.forEachEvent(e => this.event_map.set(e.topicHash, abi));
		abi.forEachError(e => {
			let bucket = this.error_map.get(e.selector);
			if (!bucket) {
				bucket = new Map();
				this.error_map.set(e.selector, bucket);
			}
			bucket.set(ethers.id(e.format('sighash')), abi);
		});
		if (!silent && this.infoLog) {
			let stats = [
				`${ansi('33', receipt.gasUsed)}gas`, 
				`${ansi('33', code.length)}bytes`
			];
			if (Object.keys(linked).length) {
				stats.push(this.pretty(linked));
			}
			this.infoLog(TAG_DEPLOY, this.pretty(from), origin, this.pretty(c), ...stats);
			this._dump_logs(receipt);
		}
		this.emit('deploy', c); // tx, receipt?
		return c;
	}
	parseAllErrors(abi) {
		if (abi.makeError !== this.error_fixer) {
			abi[Symbol_makeErrors] = abi.makeError.bind(abi);
			abi.makeError = this.error_fixer;
		}
		return abi;
	}
	findEvent(event) {
		if (event instanceof ethers.EventFragment) { // solo fragment
			try {
				return this.findEvent(event.topicHash);
			} catch (err) {
				return {
					abi: new ethers.Interface([event]),
					frag: event
				};
			}
		}		
		if (event.includes('(')) { // signature => topicHash
			event = ethers.EventFragment.from(event).topicHash;
		}
		if (/^0x[0-9a-f]{64}$/i.test(event)) { // topicHash
			let topic = event.toLowerCase();
			let abi = this.event_map.get(topic);
			if (abi) {
				return {abi, frag: abi.getEvent(topic)};
			}
		} else { // name
			let matches = [];
			for (let abi of this.event_map.values()) {
				abi.forEachEvent(frag => {
					if (frag.name === event) {
						matches.push({abi, frag});
					}
				});
			}
			if (matches.length > 1) throw error_with(`multiple events[${matches.length}]: ${event}`, {event, matches})
			if (matches.length == 1) {
				return matches[0];
			}
		}	
		throw error_with(`unknown event: ${event}`, {event});
	}
	getEventResults(logs, event) {
		if (logs instanceof ethers.Contract && logs[Symbol_foundry]) {
			logs = logs.__receipt.logs;
		} else if (logs instanceof ethers.TransactionReceipt) {
			logs = logs.logs;
		}
		if (!Array.isArray(logs)) throw new TypeError('unable to coerce logs');
		let {abi, frag} = this.findEvent(event);
		let found = [];
		for (const log of logs) {
			try {
				let desc = abi.parseLog(log);
				if (desc.fragment === frag) {
					found.push(desc.args);
				}
			} catch (err) {
			}
		}
		return found;
		//throw error_with(`missing event: ${frag.name}`, {logs, abi, frag});
	}
}

function abi_from_solc_json(json) {
	// purge stuff that ethers cant parse
	// TODO: check that this is an external library
	// https://github.com/ethereum/solidity/issues/15470
	let v = [];
	for (let x of json) {
		try {
			v.push(ethers.Fragment.from(x));
		} catch (err) {
		}
	}
	return new ethers.Interface(v);
}

function iface_from(x) {
	return x instanceof ethers.BaseContract ? x.interface : ethers.Interface.from(x);
}

export function mergeABI(...a) {
	if (a.length < 2) return iface_from(a[0] ?? []);
	let unique = new Map();
	let extra = [];
	a.forEach((x, i) => {
		for (let f of iface_from(x).fragments) {
			switch (f.type) {
				case 'constructor':
				case 'fallback':
					if (!i) extra.push(f);
					break;
				case 'function':
				case 'event':
				case 'error': // take all
					let key = `${f.type}:${f.format()}`;
					if (key && !unique.has(key)) {
						unique.set(key, f);
					}
					break;
			}
		}
	});
	return new ethers.Interface([...extra, ...unique.values()]);
}

function filter_errors(errors) {
	return errors.filter(x => x.severity === 'error');
}

function extract_links(linkReferences) {
	return Object.entries(linkReferences).flatMap(([file, links]) => {
		return Object.entries(links).map(([contract, ranges]) => {
			let offsets = ranges.map(({start, length}) => {
				if (length != 20) throw error_with(`expected 20 bytes`, {file, contract, start, length});
				return start;
			});
			return {file, contract, offsets};
		});
	});
}
