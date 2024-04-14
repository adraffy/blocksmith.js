import {spawn, execSync} from 'node:child_process';
import {ethers} from 'ethers';
import {createWriteStream, accessSync, realpathSync, readFileSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join, dirname, basename} from 'node:path';
import {tmpdir} from 'node:os';
import {error_with, is_address, to_address} from './utils.js';
import toml from 'toml';
import {inspect} from 'node:util';
import {Console} from 'node:console';

// https://docs.soliditylang.org/en/latest/grammar.html#a4.SolidityLexer.Identifier

function on_newline(fn) {
	let prior = '';
	return buf => {
		prior += buf.toString();
		let v = prior.split('\n');
		prior = v.pop();
		v.forEach(fn);
	};
}

function is_pathlike(x) {
	return typeof x === 'string' || x instanceof URL;
}

const TMP_DIR = realpathSync(join(tmpdir(), 'blocksmith'));

const CONFIG_NAME = 'foundry.toml';

function ansi(c, s) {
	return `\u001b[${c}m${s}\u001b[0m`;
}
function strip_ansi(s) {
	return s.replaceAll(/[\u001b][^m]+m/g, '').split('\n');
}

const TAG_START  =            'LAUNCH'; //ansi('34', 'LAUNCH');
const TAG_DEPLOY = ansi('33', 'DEPLOY');
const TAG_LOG    = ansi('36', 'LOG');
const TAG_TX     = ansi('33', 'TX');
const TAG_STOP   =            'STOP'; // ansi('34', '**STOP');

const DEFAULT_WALLET = 'admin';

const _OWNER = Symbol('blocksmith');
const _NAME  = Symbol('blocksmith.name');
function get_NAME() {
	return this[_NAME];
}

function take_hash(s) {
	return s.slice(2, 10);
}

export function compile(sol, {contract, forge = 'forge', remap = [], smart = true} = {}) {
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
	let hash = take_hash(ethers.id(sol));
	let root = join(TMP_DIR, hash);
	rmSync(root, {recursive: true, force: true});
	let src = join(root, 'src');
	mkdirSync(src, {recursive: true});
	let file = join(src, `${contract}.sol`);
	writeFileSync(file, sol);
	let cmd = `${forge} build --format-json --root ${root}`;
	if (remap.length) {
		cmd = `${cmd} ${remap.map(x => `--remappings ${x}`).join(' ')}`
	}
	let res = JSON.parse(execSync(cmd, {encoding: 'utf8'}));
	let errors = res.errors.filter(x => x.severity!== 'warning');
	if (errors.length) {
		throw error_with('compile error', {sol, errors});
	}
	let info = res.contracts[file]?.[contract]?.[0];
	if (!info) {
		throw error_with('expected contract', {sol, contracts: Object.keys(res.contracts), contract});
	}
	let {contract: {abi, evm: {bytecode: {object: bytecode}}}} = info;
	abi = ethers.Interface.from(abi);
	bytecode = '0x' + bytecode;
	return {abi, bytecode, contract, origin: `InlineCode{${hash}}`, sol};
}

export class Foundry {
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
		port = 0,
		wallets = [DEFAULT_WALLET],
		anvil = 'anvil',
		forge = 'forge',
		chain,
		infiniteCallGas,
		gasLimit,
		blockSec,
		autoclose = true,
		fork, base,
		procLog,
		infoLog = true,
		...unknown
	} = {}) {
		if (Object.keys(unknown).length) {
			throw error_with('unknown options', unknown);
		}
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
					proc.stdout.on('data', on_newline(procLog));
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
				let self = Object.assign(new Foundry, {proc, provider, infoLog, procLog, endpoint, chain, port, automine, bin: {forge, anvil}});
				wallets = await Promise.all(wallets.map(x => self.ensureWallet(x)));
				if (base) {
					await self.ensureBuilt(base);
				}
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
		this.accounts = new Map();
		this.event_map = new Map();
		this.error_map = new Map();
		this.wallets = {};
	}
	async ensureBuilt(base) {
		if (this.built) return this.built;
		if (!base) base = Foundry.base();
		let config = toml.parse(readFileSync(join(base, CONFIG_NAME), {encoding: 'utf8'})); // throws
		let profile = Foundry.profile();
		config = config.profile[profile];
		if (!config) throw error_with('unknown profile', {profile});
		// TODO: get default template
		if (!config.src) config.src = 'src';
		if (!config.out) config.out = 'out';
		// TODO fix me
		try {
			execSync(`${this.bin.forge} build`, {encoding: 'utf8'}); // throws
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
	async shutdown() {
		return new Promise(ful => {
			this.provider.destroy();
			this.proc.once('exit', ful);
			this.proc.kill();
		});
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
	async confirm(p, extra = {}) {
		let tx = await p;
		let receipt = await tx.wait();
		let args = {gas: receipt.gasUsed, ...extra};
		let contract = this.accounts.get(receipt.to);
		if (contract instanceof ethers.BaseContract) {
			let desc = contract.interface.parseTransaction(tx);
			Object.assign(args, desc.args.toObject());
			this.infoLog?.(TAG_TX, this.pretty(receipt.from), `${contract[_NAME]}.${desc.signature}`, this.pretty(args));
			this._dump_logs(contract.interface, receipt);
		} else {
			this.infoLog?.(TAG_TX, this.pretty(receipt.from), '>>', this.pretty(receipt.to), this.pretty(args));
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
	async resolveArtifact(args) {
		let {sol, bytecode, abi, file, contract} = args;
		if (sol) {
			let opts = {contract, forge: this.bin.forge};
			if (/^\s*import/m.test(sol)) { // TODO: this is hacky but useful
				const {base, config} = await this.ensureBuilt();
				opts.remap = [
					`@src=${join(base, config.src)}`,
					...(config.remappings ?? []).map(s => {
						let [a, b] = s.split('=');
						return `${a}=${join(base, b)}`;
					})
				];
			}
			return compile(sol, opts);
		} else if (bytecode) {
			if (!contract) contract = 'Unnamed';
			abi = ethers.Interface.from(abi);
			return {abi, bytecode, contract, origin: 'Bytecode'}
		} else if (file) {
			return this.fileArtifact(file, contract);
		}
		throw error_with('unknown artifact', args);
	}
	async fileArtifact(file, contract) {
		file = file.replace(/\.sol$/, ''); // remove optional extension
		if (!contract) contract = basename(file); // derive contract name from file name
		file += '.sol'; // add extension
		const {base, config: {src, out}} = await this.ensureBuilt(); // compile project
		let artifact_file = join(out, file, `${contract}.json`);
		let {abi, bytecode: {object: bytecode}} = JSON.parse(await readFile(join(base, artifact_file)));
		abi = ethers.Interface.from(abi);
		return {abi, bytecode, contract,
			origin: join(src, file), // relative
			file: join(base, src, file) // absolute
		};
	}
	async deploy({from, args = [], ...artifactLike}) {
		let w = await this.ensureWallet(from || DEFAULT_WALLET);
		let {abi, bytecode, ...artifact} = await this.resolveArtifact(artifactLike);
		bytecode = ethers.getBytes(bytecode);
		if (!bytecode.length) throw error_with('no bytecode', artifact);
		abi.forEachEvent(e => this.event_map.set(e.topicHash, abi)); // remember
		abi.forEachError(e => {
			let bucket = this.error_map.get(e.selector);
			if (!bucket) {
				bucket = new Map();
				this.error_map.set(e.selector, bucket);
			}
			bucket.set(ethers.id(e.format('sighash')), abi);
		});
		let {contract} = artifact;
		let factory = new ethers.ContractFactory(abi, bytecode, w);
		let unsigned = await factory.getDeployTransaction(...args);
		let tx = await w.sendTransaction(unsigned);
		let receipt = await tx.wait();
		let {contractAddress: address} = receipt;
		let code = ethers.getBytes(await this.provider.getCode(address));
		let c = new ethers.Contract(address, abi, w);
		c[_NAME] = `${contract}<${take_hash(address)}>`; // so we can deploy the same contract multiple times
		c[_OWNER] = this;
		c.toString = get_NAME;
		c.__artifact = artifact;
		c.__receipt = tx;
		this.accounts.set(address, c); // remember
		this.infoLog?.(TAG_DEPLOY, this.pretty(w), artifact.origin, this.pretty(c), `${ansi('33', receipt.gasUsed)}gas ${ansi('33', code.length)}bytes`); // {address, gas: receipt.gasUsed, size: code.length});
		this._dump_logs(abi, receipt);
		return c;
	}
}
