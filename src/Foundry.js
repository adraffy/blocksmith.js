import {spawn} from 'node:child_process';
import {ethers} from 'ethers';
import {createWriteStream} from 'node:fs';
import {readFile, writeFile, rm, mkdir, access, realpath/*, utimes*/} from 'node:fs/promises';
import {join, dirname, basename} from 'node:path';
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
	let deployedBytecode = '0x' + evm.deployedBytecode.object; // TODO: decide how to do this
	return {abi, bytecode, deployedBytecode, contract, origin, sol};
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
			config = await exec_json(forge, ['config', '--json', '--root', root], {...process.env, FOUNDRY_PROFILE: profile});
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
		return Toml.encode({profile: {[this.profile]: this.config}});
	}
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
		autoclose = true,
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
				//gasLimit = '99999999999999999999999';
				gasLimit = '922337203685477000';
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
				if (autoclose) {
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
