import {spawn, execSync} from 'node:child_process';
import {ethers} from 'ethers';
import {createWriteStream, accessSync, readFileSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join, dirname, basename} from 'node:path';
import {tmpdir} from 'node:os';
import {error_with, is_address, to_address} from './utils.js';
import toml from 'toml';
import {inspect} from 'node:util';

const TMP_DIR = join(tmpdir(), 'blocksmith');

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

const _OWNER = Symbol('blocksmith');
const _NAME  = Symbol('blocksmith.name');
function toString() {
	return this[_NAME];
}

function take_hash(s) {
	return s.slice(2, 6);
}

export function compile(sol, {contract, smart = true} = {}) {
	if (Array.isArray(sol)) {
		sol = sol.join('\n');
	}
	if (!contract) {
		let match = sol.match(/contract\s(.*)\b/);
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
	let {errors, contracts} = JSON.parse(execSync(`forge build --format-json --root ${root}`, {encoding: 'utf8'}));
	if (errors.length) {
		throw error_with('compile error', {sol, errors});
	}
	let info = contracts[file]?.[contract]?.[0];
	if (!info) {
		throw error_with('expected contract', {sol, contracts, contract});
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
		chain,
		infiniteCallGas,
		gasLimit,
		blockSec,
		autoclose = true,
		fork, log, base, ...unknown
	} = {}) {
		if (Object.keys(unknown).length) {
			throw error_with('unknown options', unknown);
		}
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
			let proc = spawn('anvil', args);
			function fail(data) {
				proc.kill();
				rej(error_with('launch', {args, stderr: data.toString()}));
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
					let out = createWriteStream(log);
					out.write(init);
					proc.stdout.pipe(out);
				}
				let endpoint = `ws://${host}`;
				port = parseInt(host.slice(host.lastIndexOf(':') + 1));
				let provider = new ethers.WebSocketProvider(endpoint, chain, {staticNetwork: true});
				if (!chain) {
					chain = parseInt(await provider.send('eth_chainId')); // determine chain id
				}
				let automine = await provider.send('anvil_getAutomine');
				if (automine) {
					provider.destroy();
					provider = new ethers.WebSocketProvider(endpoint, chain, {staticNetwork: true, cacheTimeout: -1});
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
		let config = toml.parse(readFileSync(join(base, CONFIG_NAME), {encoding: 'utf8'})); // throws
		let profile = Foundry.profile();
		config = config.profile[profile];
		if (!config) {
			throw error_with('unknown profile', {profile});
		}
		// TODO fix me
		try {
			execSync('forge build', {encoding: 'utf8'}); // throws
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
		if (x instanceof ethers.Wallet) {
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
		if (x instanceof ethers.Wallet) {
			if (x[_OWNER] === this) return x;
			throw error_with('unowned wallet', {wallet: x});
		}
		if (!x || typeof x !== 'string' || is_address(x)) {
			throw error_with('expected wallet name', {name: x});
		}
		let wallet = this.wallets[x];
		if (!wallet) {
			wallet = new ethers.Wallet(ethers.id(x), this.provider);
			await this.provider.send('anvil_setBalance', [wallet.address, ethers.toBeHex(10000n * BigInt(1e18))]);
			wallet[_NAME] = x;
			wallet[_OWNER] = this;
			wallet.toString = toString;
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
							return ansi(32, x[_NAME]); 
						}
					};
				} else if (x instanceof ethers.Indexed) {
					return {
						[inspect.custom]() { 
							return ansi(36, `'${x.hash}'`);
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
	async confirm(p, extra = {}) {
		let tx = await p;
		let receipt = await tx.wait();
		let args = {gas: receipt.gasUsed, ...extra};
		let contract = this.accounts.get(receipt.to);
		if (contract instanceof ethers.BaseContract) {
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
			return compile(sol, {contract});
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
	async deploy({from, args = [], ...artifactLike}, proto = {}) {
		let w = await this.ensureWallet(from || DEFAULT_WALLET);
		let {abi, bytecode, ...artifact} = await this.resolveArtifact(artifactLike);
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
		c.toString = toString;
		c.__artifact = artifact;
		c.__receipt = tx;
		Object.assign(c, proto);
		this.accounts.set(address, c); // keep track of it
		console.log(TAG_DEPLOY, this.pretty(w), artifact.origin, this.pretty(c), {address, gas: receipt.gasUsed, size: code.length});
		this._dump_logs(abi, receipt);
		return c;
	}
}
