import {spawn, execSync} from 'node:child_process';
import {ethers} from 'ethers';
import {createWriteStream, accessSync, readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {error_with, is_address, to_address} from './utils.js';
import toml from 'toml';
import { inspect } from 'node:util';

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
		chain,
		block_sec,
		accounts = 5,
		autoclose = true,
		fork, log, base
	} = {}) {
		return new Promise((ful, rej) => {
			if (!base) base = this.base();
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
			let config = toml.parse(readFileSync(join(base, CONFIG_NAME), {encoding: 'utf8'})); // throws
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
			let proc = spawn('anvil', args);
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
					let out = createWriteStream(log);
					out.write(init);
					proc.stdout.pipe(out);
				}
				let endpoint = `ws://${host}`;
				port = parseInt(host.slice(host.lastIndexOf(':') + 1));
				let provider = new ethers.WebSocketProvider(endpoint, chain, {staticNetwork: true});
				//provider.on('block', block => console.log('block'));
				if (!chain) {
					chain = parseInt(await provider.send('eth_chainId')); // determine chain id
				}
				let automine = await provider.send('anvil_getAutomine');
				let wallets = await Promise.all(Array.from({length: accounts}, async (_, i) => {
					let wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, '', derivation + i).connect(provider);
					if (automine) {
						// forked chains have to start from their true nonce
						wallet.__nonce = fork ? await provider.getTransactionCount(wallet.address) : 0;
						wallet.getNonce = function() {
							return this.__nonce;
						};
					}
					wallet.__name = `dev#${i}`;
					wallet[inspect.custom] = function() {
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
		if (contract instanceof ethers.BaseContract) {
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
		let code_path = join(src, `${name}.sol`);
		let artifact_path = join(out, `${name}.sol`, `${impl}.json`);
		let {abi, bytecode} = JSON.parse(await readFile(join(base, artifact_path)));
		abi = new ethers.Interface(abi);
		let factory = new ethers.ContractFactory(abi, bytecode, wallet);
		let unsigned = await factory.getDeployTransaction(args);
		let tx = await wallet.sendTransaction(unsigned);
		let receipt = await this.wait(tx);
		let {contractAddress: address} = receipt;
		let code = ethers.getBytes(await this.provider.getCode(address));
		let contract = new ethers.Contract(address, abi, wallet);
		let __name = `${impl}<${address.slice(2, 6)}>`; // so we can deploy the same contract multiple times
		// store some shit in the ethers contract without conflicting
		let info = {
			__name,
			__contract: impl,
			__file: join(base, code_path), 
			__code: code,
			__tx: receipt,
			[inspect.custom]() {
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
