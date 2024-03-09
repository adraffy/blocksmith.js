import {spawn, execSync} from 'node:child_process';
import {ethers} from 'ethers';
import {createWriteStream, accessSync, readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join, dirname, basename} from 'node:path';
import {error_with} from './utils.js';
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
		block_sec = 1, 
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
			proc.stdout.once('data', buf => {
				let init = buf.toString();
				let mnemonic, host;
				for (let x of init.split('\n')) {
					let match;
					if (match = x.match(/^Mnemonic:(.*)$/)) {
						mnemonic = match[1].trim();
					} else if (match = x.match(/^Listening on (.*)$/)) {
						host = match[1].trim();
					}
 				}
				if (!mnemonic || !host) {
					proc.kill();
					rej(error_with('init', {mnemonic, host, args, init}));
				}
				if (autoclose) {
					process.on('exit', () => proc.kill());
				}
				if (log === true) log = console.log;
				if (log instanceof Function) {
					log(init);
					proc.stdout.on('data', buf => log(buf.toString()));
				} else if (log) {
					let out = createWriteStream(log);
					out.write(init);
					proc.stdout.pipe(out);
				}
				let endpoint = `http://${host}`;
				let provider = new ethers.JsonRpcProvider(endpoint, chain, {staticNetwork: true, pollingInterval: (block_sec * 1000) >> 1});
				let wallets = Array.from({length: accounts}, (_, i) => {
					let wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, '', `m/44'/60'/0'/0/${i}`).connect(provider);
					wallet.name = `dev#${i}`;
					return wallet;
				});
				proc.stdout.removeListener('data', fail);
				ful(new this(proc, provider, wallets, {base, mnemonic, endpoint, chain, port, config}));
			});
		});
	}
	constructor(proc, provider, wallets, info) {
		this.proc = proc;
		this.provider = provider;
		this.wallets = wallets;
		this.info = info;
		this.deployed = new Map();
	}
	shutdown() {
		this.proc.kill();
		this.provider.destroy();
	}
	wallet(x, optional) {
		let {wallets: v} = this;
		if (Number.isInteger(x)) {
			if (x >= 0 && x < v.length) return v[x];
		} else if (typeof x === 'string') {
			let wallet = v.find(y => y.address === x);
			if (wallet) return wallet;
		} else if (v.includes(x)) {
			return x;
		} 
		if (!optional) {
			throw error_with('expected wallet', {wallet: x});
		}
	}
	resolve(path) {
		let {info: {config: {src, remappings = []}}} = this;
		for (let line of remappings) {
			let pos = line.indexOf('=');
			if (path.startsWith(line.slice(0, pos))) {
				return line.slice(pos +1) + path.slice(pos);
			}
		}
		return `${src}/${path}`;
	}
	async deploy({wallet = 0, file, name, contract: impl, args}, proto = {}) {
		wallet = this.wallet(wallet);
		if (file) {
		} else {
			if (!name) throw Error('expected name or file');
			file = `${name}.sol`;
		}
		if (!impl) impl = basename(file).replace(/\.sol$/, '');
		file = this.resolve(file);
		let cmd = ['forge create', '--rpc-url', this.info.endpoint, '--private-key', wallet.privateKey, `${file}:${impl}`];
		if (args) cmd.push('--constructor-args', ...args);
		let output = execSync(cmd.join(' '), {encoding: 'utf8'});
		let address = output.match(/Deployed to: (0x[0-9a-f]{40}\b)/mi)[1];
		let tx = output.match(/Transaction hash: (0x[0-9a-f]{64}\b)/mi)[1];
		let {abi} = JSON.parse(await readFile(join(this.info.base, `out/${basename(file)}/${impl}.json`)));
		let contract = new ethers.Contract(address, abi, wallet);
		this.deployed.set(address, contract);
		let receipt = await wallet.provider.getTransactionReceipt(tx);
		Object.assign(contract, proto, {receipt, file, filename: impl});
		console.log(`${wallet.name} Deployed: ${impl} @ ${address}`, receipt.gasUsed);
		return contract;
	}
}
