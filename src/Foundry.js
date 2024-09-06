import {spawn} from 'node:child_process';
import {ethers} from 'ethers';
import {createWriteStream, openSync, readFileSync, closeSync, rmSync} from 'node:fs';
import {readFile, writeFile, rm, mkdir, access, realpath/*, utimes*/} from 'node:fs/promises';
import {join, dirname, basename, sep as PATH_SEP} from 'node:path';
import {tmpdir} from 'node:os';
import {error_with, is_address, to_address} from './utils.js';
import {inspect} from 'node:util';
import {Console} from 'node:console';
import * as Toml from './toml.js';

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

const _OWNER = Symbol('blocksmith');
const _NAME  = Symbol('blocksmith.name');
function get_NAME() {
	return this[_NAME];
}

function take_hash(s) {
	return s.slice(2, 10);
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

async function exec_json(cmd, args, env, log) {
	let timer;
	if (log) {
		// TODO: make this customizable
		timer = setTimeout(() => log(cmd, args), 3000);
	}
	return new Promise((ful, rej) => {
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
		let temp_file = join(tmpdir(), 'blocksmith', ethers.id(args.join()));
		let temp_fd = openSync(temp_file, 'w');
		let proc = spawn(cmd, args, {env, encoding: 'utf8', stdio: ['ignore', temp_fd, 'pipe']});
		//let stdout = [];
		//let stderr = [];
		//proc.stdout.on('data', chunk => stdout.push(chunk));
		//proc.stderr.on('data', chunk => stderr.push(chunk));
		let stderr = '';
		proc.stderr.on('data', chunk => stderr += chunk);
		proc.on('exit', code => {
			let stdout;
			try {
				closeSync(temp_fd);
				if (!code) stdout = readFileSync(temp_file);
				rmSync(temp_file);
			} catch (ignored) {
			}
			let error;
			try {
				if (!code) {
					return ful(JSON.parse(stdout));
				}
				//error = strip_ansi(Buffer.concat(stderr).toString('utf8'));
				error = strip_ansi(stderr);
			} catch (err) {
				error = err.message;
			}
			rej(error_with(`expected JSON output: ${error}`, {code, error, cmd, args}));
		});
	}).finally(() => clearTimeout(timer));
}

//export async function evaluate(`return (1)`, ['uint256']);

export async function compile(sol, {contract, foundry, optimize, smart = true} = {}) {
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
	await writeFile(config_file, Toml.encode({profile: {[DEFAULT_PROFILE]: config}}));
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
	let links = extract_links(evm.bytecode.linkReferences);
	//let deployedBytecode = '0x' + evm.deployedBytecode.object; // TODO: decide how to do this
	let deployedByteCount = evm.deployedBytecode.object.length >> 1;
	return {abi, bytecode, contract, origin, links, sol, deployedByteCount};
}

// should this be called Foundry?
export class FoundryBase {
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
			config = await exec_json(forge, ['config', '--root', root, '--json'], {...process.env, FOUNDRY_PROFILE: profile}, this.procLog);
		} catch (err) {
			throw error_with(`invalid ${CONFIG_NAME}`, {root, profile}, err);
		}
		return Object.assign(new this, {root, profile, config, forge});
	}
	async build(force) {
		if (!force && this.built) return this.built;
		let args = ['build', '--format-json', '--root', this.root];
		if (force) args.push('--force');
		let res = await exec_json(this.forge, args, {...process.env, FOUNDRY_PROFILE: this.profile}, this.procLog);
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
		if (bytecode) {
			if (!contract) contract = 'Unnamed';
			abi = ethers.Interface.from(abi);
			return {abi, bytecode, contract, origin: 'Bytecode', links: []}
		} else if (sol) {
			// TODO: should this be .compile?
			return compile(sol, {contract, foundry: this, ...rest});
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
		let links = extract_links(artifact.bytecode.linkReferences);
		let abi = ethers.Interface.from(artifact.abi);
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

export class Foundry extends FoundryBase {
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
		// if (infoLog === true) {
		// 	infoLog = (...a) => console.log(ansi('2', new Date().toISOString()), ...a);
		// }
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
				if (fork) {
					args.push('--disable-block-gas-limit');
				} else {
					args.push('--gas-limit', '99999999999999999999999');
				}
			} else if (gasLimit) {
				args.push('--gas-limit', gasLimit);
			}
			if (fork) args.push('--fork-url', fork);
			let proc = spawn(anvil, args, {env: {...process.env, RUST_LOG: 'node=info'}});
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
					if (infoLog) {
						let match = line.match(/^(\x1B\[\d+m\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\x1B\[0m) \x1B\[\d+m([^\x1B]+)\x1B\[0m \x1B\[\d+m([^\x1B]+)\x1B\[0m\x1B\[2m:\x1B\[0m (.*)$/);
						if (match) {
							let [_, time, _level, kind, line] = match;
							if (kind === 'node::user') {
								show_log = line !== 'eth_estimateGas';
							} else if (kind === 'node::console') {
								if (show_log) {
									infoLog(TAG_CONSOLE, time, line);
								}
								return;
							}
						}
					}
					procLog?.(line);
				}));
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
					proc.once('exit', () => infoLog(TAG_STOP, `${ansi('33', Date.now() - t)}ms`)); // TODO fix me
				}
				ful(self);
			}
		});
	}
	constructor() {
		super();
		this.accounts = new Map();
		this.write_map = new Map();
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
	parseTransaction(tx) {
		let bucket = this.write_map.get(tx.data?.slice(0, 10));
		if (!bucket) return;
		for (let abi of bucket.values()) {
			let desc = abi.parseTransaction(tx);
			if (desc) return desc;
		}
	}
	async confirm(p, {silent, ...extra} = {}) {
		let tx = await p;
		let receipt = await tx.wait();
		let args = {gas: receipt.gasUsed, ...extra};
		if (!silent && this.infoLog) {
			// let contract = this.accounts.get(receipt.to);
			// if (contract instanceof ethers.BaseContract) {

			// }
			let desc = this.parseTransaction(tx);
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
		return receipt;
	}
	_dump_logs(receipt) {
 		for (let x of receipt.logs) {
			let abi = this.event_map.get(x.topics[0]);
			let event;
			if (abi) {
				event = abi.parseLog(x);
			}
			/*
			for (let c of this.accounts.values()) {
				if (c instanceof ethers.BaseContract) {
					log = c.interface.parseLog(x);
					if (log) break;
				}
			}
			*/
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
	async deploy({from, args = [], libs = {}, silent, ...artifactLike}) {
		let w = await this.ensureWallet(from || DEFAULT_WALLET);
		let {abi, links, bytecode: bytecode0, ...artifact} = await this.resolveArtifact(artifactLike);
		let {bytecode, linked} = this.linkBytecode(bytecode0, links, libs);
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
		//c.__bytecode = code;
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
			// let stats = {
			// 	gas: Number(receipt.gasUsed),
			// 	bytes: code.length,
			// };
			let stats = [
				`${ansi('33', receipt.gasUsed)}gas`, 
				`${ansi('33', code.length)}bytes`
			];
			if (Object.keys(linked).length) {
				//stats.links = Object.fromEntries(links.map(x => [x.contract, x.address]));
				stats.push(this.pretty(linked));
			}
			 // {address, gas: receipt.gasUsed, size: code.length});
			this.infoLog(TAG_DEPLOY, this.pretty(w), artifact.origin, this.pretty(c), ...stats);
			this._dump_logs(receipt);
		}
		return c;
	}
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