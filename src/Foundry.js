import {spawn, execSync} from 'node:child_process';
import {ethers} from 'ethers';
import {createWriteStream, accessSync, readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {error_with, is_address, to_address} from './utils.js';
import toml from 'toml';

const CONFIG_NAME = 'foundry.toml';

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
					wallet.__name = `dev#${i}`;
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
			if (deploy) return deploy.__name;
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
		console.log(`${from.__name} ${contract.__name}.${desc.name}()`, args);
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
			__tx: receipt, 
			__name: impl,
			__file: join(base, code_path), 
			__code: code,
		});
		console.log(`${wallet.name} Deployed: ${impl} @ ${address}`, {gas: receipt.gasUsed, size: code.length});
		//wallet.nonce = tx.nonce + 1; // this didn't go through normal channels
		return contract;
	}
}
