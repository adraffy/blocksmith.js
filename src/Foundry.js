import {spawn} from 'node:child_process';
import {ethers} from 'ethers';
import {createWriteStream} from 'node:fs';
import {readFile, writeFile, rm, mkdir, access, realpath, mkdtemp, readdir} from 'node:fs/promises';
import {join, dirname, relative, normalize, basename, sep as PATH_SEP} from 'node:path';
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

function is_exact_semver(version) {
	return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version);
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

async function exec({cmd, args = [], env = {}, /*cwd,*/ json = true} = {}) {
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
				//cwd,
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
		throw Object.assign(err, {cmd, args, env/*, cwd*/});
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
		let v = [...sol.matchAll(/(contract|library|interface)\s([a-z$_][0-9a-z$_]*)/ig)];
		if (v.length > 1) v = v.filter(x => x[1] !== 'interface');
		if (v.length != 1) throw error_with('expected contract name', {sol, names: v.map(x => x[2])});
		contract = v[0][2];
	}
	if (autoHeader) {
		if (!/^\s*pragma\s+solidity/m.test(sol)) {
			sol = `pragma solidity >=0.0.0;\n${sol}`;
		}
		if (!/^\s*\/\/\s*SPDX-License-Identifier:/m.test(sol)) {
			sol = `// SPDX-License-Identifier: UNLICENSED\n${sol}`;
		}
	}
	
	let root = await mkdtemp(join(await realpath(tmpdir()), 'blocksmith-'));
	
	await rm(root, {recursive: true, force: true}); // better than --force 
	
	let src = join(root, 'src');
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
		config.src = 'src';
		config.test = 'src';
		config.libs = [];
		let remappings = [
			['@src', foundry.config.src], // this is nonstandard
			['@test', foundry.config.test],
			...config.remappings.map(s => s.split('='))
		];
		config.remappings = remappings.map(([a, b]) => {
			let pos = a.indexOf(':');
			if (pos >= 0) {
				// support remapping contexts
				a = join(foundry.root, a.slice(0, pos) + a.slice(pos));
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
		if (!optimize) {
			config.optimizer = false;
		} else {
			config.optimizer = true;
			config.optimizer_runs = optimize;
		}
	}
	config.extra_output = ['metadata'];
	if (solcVersion) config.solc = solcVersion;
	if (evmVersion) config.evm_version = evmVersion;
	if (viaIR !== undefined) config.via_ir = !!viaIR;

	await writeFile(config_file, Toml.encode({profile: {[profile]: config}}));
	args.push('--config-path', config_file);

	const buildInfo = {
		started: new Date(),
		root,
		cmd: [forge, ...args],
		profile,
		mode: foundry ? 'shadow' : 'compile',
		force: true
	};
	foundry?.emit('building', buildInfo);
	let res = await exec({
		cmd: forge, 
		args, 
		env, 
		//cwd: root,
	});
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

	let {contract: {abi, evm, metadata}} = info;
	abi = abi_from_solc_json(abi);
	let bytecode = '0x' + evm.bytecode.object;
	let links = extract_links(evm.bytecode.linkReferences);
	let cid = `${file}:${contract}`;
	metadata = JSON.parse(metadata);
	let compiler = metadata.compiler.version;
	return {type: 'code', abi, bytecode, contract, origin, links, sol, cid, root, compiler};
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
			config = await exec({
				cmd: forge,
				args: ['config', '--root', root, '--json'],
				env: {FOUNDRY_PROFILE: profile},
				//cwd: root
			});
		} catch (err) {
			throw error_with(`invalid ${CONFIG_NAME}`, {root, profile}, err);
		}
		return Object.assign(new this, {root, profile, config, forge});
	}
	async version() {
		const buf = await exec({
			cmd: this.forge,
			args: ['--version'],
			//cwd: this.root,
			json: false
		});
		return buf.toString('utf8').trim();
	}
	async compiler(solcVersion) {
		// https://book.getfoundry.sh/reference/config/solidity-compiler#solc_version
		if (!is_exact_semver(solcVersion)) throw new TypeError('expected exact semver: x.y.z')
		const {compiler} = await compile('contract C {}', {solcVersion, foundry: this});
		return compiler;
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
		const {forge, root, profile} = this;
		let args = ['build', '--format-json', '--root', root];
		if (force) args.push('--force');
		const buildInfo = {
			started: new Date(),
			root,
			cmd: [forge, ...args],
			force,
			profile,
			mode: 'project'
		};
		this.emit('building', buildInfo);
		let res = await exec({
			cmd: forge, 
			args, 
			env: {FOUNDRY_PROFILE: profile}, 
			//cwd: root
		});
		let errors = filter_errors(res.errors);
		if (errors.length) {
			throw error_with('forge build', {errors});
		}
		buildInfo.sources = Object.keys(res.sources);
		this.emit('built', buildInfo);
		return this.built = {date: new Date()};
	}
	async artifacts() {
		await this.build();
		const {out} = this.config;
		const files = Array.from(await readdir(out, {recursive: true}));
		const artifacts = [];
		await Promise.all(files.map(async frag => {
			if (!frag.endsWith('.json')) return;
			try {
				const artifact = await this.fileArtifact({file: join(out, frag)});
				artifacts.push(artifact);
			} catch (err) {
			}
		}))
		return artifacts;
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
	async resolveArtifact(arg0) {
		let {import: imported, bytecode, abi, sol, contract, ...rest} = artifact_from(arg0);
		if (bytecode) { // bytecode + abi
			contract ??= 'Unnamed';
			abi = iface_from(abi ?? []);
			return {type: 'bytecode', abi, bytecode, contract, origin: 'Bytecode', links: []};
		}
		if (imported) {
			contract ??= remove_sol_ext(basename(imported));
			const artifact = await compile(`import "${imported}";`, {
				...rest,
				contract,
				foundry: this, 
				autoHeader: true
			});
			artifact.origin = imported;
			return artifact;
		}
		if (sol) { // sol code + contract?
			return compile(sol, {contract, foundry: this, ...rest});
		} else {
			return this.fileArtifact({contract, ...rest});
		}
	}
	async fileArtifact(arg0) {
		let {file} = arg0;
		let json, root, type;
		if (typeof file === 'object') { // inline artifact (this might be dumb)
			json = file;
			file = undefined;
			type = 'artifact';
		} else if (file.endsWith('.json')) { // file artifact
			json = JSON.parse(await readFile(file));
			type = 'artifact';
		} else { // source file
			file = await this.find(arg0);
			json = JSON.parse(await readFile(file));
			root = this.root;
			type = 'file';
		}
		let [origin, contract] = Object.entries(json.metadata.settings.compilationTarget)[0]; // TODO: is this correct?
		let cid = `${origin}:${contract}`;
		let bytecode = json.bytecode.object;
		let links = extract_links(json.bytecode.linkReferences);
		let abi = abi_from_solc_json(json.abi);
		let compiler = json.metadata.compiler.version;
		return {type, abi, bytecode, contract, origin, file, links, cid, root, compiler};
	}
	linkBytecode(bytecode, links, libs) {
		let map = new ContractMap();
		for (let [cid, impl] of Object.entries(libs)) {
			let address = to_address(impl);
			if (!address) throw error_with(`unable to determine library address: ${file}`, {file, impl});
			map.add(cid, address);
		}
		let linkedLibs = {};
		let linked = links.map(link => {
			let cid = `${link.file}:${link.contract}`;
			let [prefix, address] = map.find(cid);
			if (!prefix) throw error_with(`unlinked external library: ${cid}`, link);
			for (let offset of link.offsets) {
				offset = (1 + offset) << 1;
				bytecode = bytecode.slice(0, offset) + address.slice(2) + bytecode.slice(offset + 40);
			}
			linkedLibs[prefix] = address;
			return {...link, cid, address};
		});
		bytecode = ethers.getBytes(bytecode);
		return {bytecode, linked, linkedLibs};
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

let _etherscanChains;
async function etherscanChains() {
	return _etherscanChains ??= (async () => {
		try {
			const res = await fetch('https://api.etherscan.io/v2/chainlist');
			if (!res.ok) throw new Error('etherscan: chainlist');
			const {result} = await res.json();
			return new Map(result.map(x => [BigInt(x.chainid), x.blockexplorer]));
		} catch (err) {
			_etherscanChains = undefined;
			throw err;
		}
	})();
}

// let _chainlist;
// async function chainlist() {
// 	return _chainlist ??= (async () => {
// 		try {
// 			const res = await fetch('https://chainid.network/chains_mini.json');
// 			const result = await res.json();
// 			return new Map(result.map(x => [
// 				BigInt(x.chainId),
// 				{
// 					name: x.name,
// 					rpcs: x.rpc.filter(x => x.startsWith('https:') && !x.includes('{')),
// 					isETH: x.nativeCurrency.symbol === 'ETH' && x.nativeCurrency.decimals === 18,
// 				},
// 			].filter(x => x[1].rpcs.length)));
// 		} catch (err) {
// 			_chainlist = undefined;
// 			throw err;
// 		}
// 	});
// }

// TODO: fix this
const PROVIDERS = {
	mainnet: 'https://eth.drpc.org',
	sepolia: 'https://sepolia.drpc.org',
	hoodi: 'https://hoodi.drpc.org',
	base: 'https://mainnet.base.org',
	op: 'https://mainnet.optimism.io',
	arb1: 'https://arb1.arbitrum.io/rpc',
	linea: 'https://rpc.linea.build',
	polygon: 'https://polygon-rpc.com',
};

export class FoundryDeployer extends FoundryBase {
	static etherscanChains = etherscanChains;

	static async load({
		provider,
		privateKey,
		gasToken = 'ETH',
		infoLog = true,
		...rest
	} = {}) {
		if (!provider) provider = 'mainnet';
		if (typeof provider === 'string') {
			provider = new ethers.JsonRpcProvider(PROVIDERS[provider] || provider, null, {staticNetwork: true});
		}
		if (!infoLog) infoLog = undefined;
		if (infoLog === true) infoLog = (...a) => console.log(new Date(), ...a);
		let self = await super.load(rest);
		self._etherscanApiKey = undefined;
		self._privateKey = undefined;
		self.infoLog = infoLog;
		self.gasToken = gasToken;
		self.rpc = provider._getConnection().url;
		self.chain = (await provider.getNetwork()).chainId;
		self.provider = provider;
		self.privateKey = privateKey;
		return self;
	}
	set etherscanApiKey(key) {
		this._etherscanApiKey = key || undefined;
	}
	get etherscanApiKey() {
		return this._etherscanApiKey || this.config.etherscan_api_key;
	}
	set privateKey(key) {
		if (!key) {
			this._privateKey = undefined;
		} else {
			if (!(key instanceof ethers.SigningKey)) {
				key = new ethers.SigningKey(key);
			}
			this._privateKey = key;
			this.infoLog?.(`Deployer: ${ansi('36', this.address)}`);
		}
	}
	get privateKey() {
		return this._privateKey;
	}
	get address() {
		return this._privateKey ? ethers.computeAddress(this._privateKey) : undefined;l
	}
	requireWallet() {
		const key = this.privateKey;
		if (!key) throw new Error('expected private key');
		return new ethers.Wallet(key, this.provider);
	}
	async prepare(arg0) {
		let {
			args = [],
			libs = {},
			confirms,
			...artifactLike
		} = artifact_from(arg0);
		let {type, abi, links, bytecode: bytecode0, cid, root, compiler} = await this.resolveArtifact(artifactLike);
		if (!root) throw new Error('unsupported deployment type');
		if (cid.startsWith('/')) { // if (type === 'code') {
			cid = relative(root, cid);
		}
		let {bytecode, linked} = this.linkBytecode(bytecode0, links, libs);
		const wallet = this._privateKey ? this.requireWallet() : null;
		let factory = new ethers.ContractFactory(abi, bytecode, wallet);
		let unsigned = await factory.getDeployTransaction(...args);
		unsigned.from = wallet ? wallet.address : '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
		let encodedArgs = await abi.encodeDeploy(args);
		let decodedArgs = ethers.AbiCoder.defaultAbiCoder().decode(abi.deploy.inputs, encodedArgs);
		const gas = await this.provider.estimateGas(unsigned);
		const fees = await this.provider.getFeeData();
		const wei = gas * fees.maxFeePerGas;
		const approx_eth = Number(wei) / 1e18;
		const self = this;
		const ret = {
			gas,
			...fees,
			wei,
			eth: ethers.formatEther(wei),
			root,
			cid,
			linked,
			compiler,
			decodedArgs,
			encodedArgs,
			deployArgs(use_private_key) {
				const args = [
					'create',
					this.cid,
					'--root', this.root,
					'--rpc-url', self.rpc,
					'--broadcast',
					'--json'
				];
				if (use_private_key) {
					args.push('--private-key', self.privateKey.privateKey);
				} else {
					args.push('--interactive');
				}
				if (this.linked.length) {
					args.push('--libraries', ...fmt_libraries(this.linked));
				}
				if (this.decodedArgs.length) {
					args.push('--constructor-args', ...fmt_ctor_args(this.decodedArgs, abi.deploy.inputs));
				}
				return args;
			},
			async deploy({confirms} = {}) {
				const wallet = self.requireWallet();
				const t0 = Date.now();
				self.infoLog?.(`Deploying to ${ansi('33', self.chain)}...`);
				const {deployedTo, transactionHash} = await exec({
					cmd: self.forge,
					args: this.deployArgs(true), 
					env: {FOUNDRY_PROFILE: self.profile},
					//cwd: this.root
				});
				this.address = deployedTo;
				self.infoLog?.(`Transaction: ${ansi('36', transactionHash)}`);
				const contract = new ethers.Contract(deployedTo, abi, wallet);
				self.infoLog?.(`Waiting for confirmation...`);
				await self.provider.waitForTransaction(transactionHash, confirms);
				const receipt = await self.provider.getTransactionReceipt(transactionHash);
				self.infoLog?.(`Deployed: ${ansi('36', deployedTo)} (${fmt_dur(Date.now() - t0)})`);
				return {contract, receipt};
			},
			async json() {
				const args = [
					'verify-contract',
					ethers.ZeroAddress,
					this.cid,
					'--root', this.root,
					'--show-standard-json-input',
				];
				if (this.decodedArgs.length) {
					args.push('--constructor-args', encodedArgs);
				}
				if (this.linked.length) {
					args.push('--libraries', ...fmt_libraries(this.linked));
				}
				const json = await exec({
					cmd: self.forge, 
					args, 
					env: {FOUNDRY_PROFILE: self.profile},
					//cwd: this.root
				});
				if (type === 'code') {
					// we gotta unfuck these relatives
					json.sources = Object.fromEntries(Object.entries(json.sources).map(([k, v]) => {
						return [k.startsWith('../') ? normalize(join(this.root, k)) : k, v];
					}));
				}
				return json;
			},
			async verifyEtherscan(a = {}) {
				const {cid, encodedArgs, compiler, address} = this;
				return self.verifyEtherscan({
					address,
					...a,
					cid,
					encodedArgs,
					compiler,
					json: await this.json(),
				});
			}
		};
		if (this.infoLog) {
			// remove contract name if same as file name
			this.infoLog(`Contract: ${ansi('93', cid.replace(/\/(.*)\.sol:\1$/, (_, x) => `/${x}.sol`))} Chain: ${ansi('33', this.chain)}`);
			let stats = [
				`${ansi('33', bytecode.length)}bytes`,
				`${ansi('33', gas)}gas`,
				`${ansi('33', (Number(fees.maxFeePerGas) / 1e9).toFixed(1))}gwei`,
				`${ansi('32', approx_eth.toFixed(4))}eth`,
			];
			if (this.gasToken === 'ETH') {
				try {
					const res = await fetch('https://api.coinbase.com/v2/exchange-rates');
					const {data: {rates: {ETH}}} = await res.json();
					if (ETH > 0) {
						stats.push(`${ansi('32', '$' + (approx_eth / ETH).toFixed(2))} @ ${(1 / ETH).toFixed(2)}`);
					}
				} catch (err) {
				}
			}
			this.infoLog(...stats);
		}
		return ret;
	}
	async verifyEtherscan({json, cid, address, apiKey, encodedArgs, compiler, pollMs = 5000, retry = 10} = {}) {
		const t0 = Date.now();
		
		apiKey ??= this.etherscanApiKey;
		if (!apiKey) throw new Error(`expected etherscan api key`); 
		address = to_address(address);
		if (!address) throw new Error('expected address');
		encodedArgs = encodedArgs ? ethers.hexlify(encodedArgs) : '0x';
		cid ??= Object.keys(json.sources)[0]; // use first contract?

		 // fix this shit
		if (!compiler) throw new Error('expected compiler/version');
		if (is_exact_semver(compiler)) compiler = await this.compiler(compiler);
		if (!compiler.startsWith('v')) compiler = `v${compiler}`;

		const url = new URL('https://api.etherscan.io/v2/api');
		url.searchParams.set('chainid', this.chain.toString());
		url.searchParams.set('module', 'contract');
		url.searchParams.set('action', 'verifysourcecode');
		url.searchParams.set('apikey', apiKey);

		const body = new FormData();
		body.set('chainId', this.chain.toString());
		body.set('sourceCode', JSON.stringify(json));
		body.set('codeformat', 'solidity-standard-json-input');
		body.set('contractaddress', address);
		body.set('contractname', cid);
		body.set('compilerversion', compiler);
		body.set('constructorArguments', encodedArgs.slice(2));

		this.infoLog?.('Requesting verification...');
		let guid;
		while (true) {
			const {message, result} = await fetch(url, {method: 'POST', body}).then(r => r.json());
			if (message === 'OK') {
				guid = result;
				break;
			} else if (/unable to locate contract/i.test(result)) {
				if (retry > 0) {
					--retry;
					this.infoLog?.(`Waiting for indexer...`);
					await new Promise(ful => setTimeout(ful, pollMs));
				} else {
					throw error_with(`expected contract` , {chain: this.chain, address});
				}
			} else {
				throw new Error(`etherscan: ${result}`, {result});
			}
		}
		this.infoLog?.(`Request: ${ansi('33', guid)}`);
		url.searchParams.set('guid', guid);
		url.searchParams.set('action', 'checkverifystatus');
		while (true) {
			const {message, result} = await fetch(url).then(r => r.json());
			if (message === 'OK') {
				break;
			} else if (/already verified/i.test(result)) {
				break;
			} else if (/pending in queue/i.test(result)) {
				this.infoLog?.(`Waiting for verification...`);
				await new Promise(ful => setTimeout(ful, pollMs));
			} else {
				throw error_with(`etherscan: ${result}`, {result, guid, url: url.toString()});
			}
		}
		this.infoLog?.(`Verified: ${ansi('36', address)} (${fmt_dur(Date.now() - t0)})`);
	}
}

function fmt_dur(t) {
	if (t < 600) {
		return `${t.toFixed(0)}ms`;
	} else {
		return `${(t / 1000).toFixed(1)}sec`;
	}
}

function fmt_libraries(linked) {
	return linked.map(({file, contract, address}) => {
		return `${file}:${contract}:${address}`;
	});
}

function fmt_ctor_args(args, params, quote) {
	return args.map((x, i) => {
		const param = params[i];
		if (param.isArray()) {
			if (!Array.isArray(x)) throw new Error(`expected array: ${x}`);
			return `[${fmt_ctor_args(x, Array.from(x, () => param.arrayChildren), true).join(',')}]`;
		} else if (param.isTuple()) {
			if (!Array.isArray(x)) throw new Error(`expected array: ${x}`);
			return `(${fmt_ctor_args(x, param.components, true).join(',')})`;
		} else {
			switch (typeof x) {
				case 'boolean':
				case 'number':
				case 'bigint':
					return String(x);
				case 'string':
					return quote ? JSON.stringify(x) : x;
				default:
					throw new Error(`unexpected arg: ${x}`);
			}
		}
	});
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
					ensRegistry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
				});
				wallets = await Promise.all(wallets.map(x => self.ensureWallet(x)));
				infoLog?.(TAG_START, self.pretty({chain, endpoint, wallets}));
				proc.once('exit', () => {
					self.emit('shutdown');
					infoLog?.(TAG_STOP, `${ansi('33', fmt_dur(Date.now() - self.started))}`);
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
			ethers.toBeHex(sec),
		]);
	}
	async setStorageValue(a, slot, value) {
		if (value instanceof Uint8Array) {
			if (value.length != 32) throw new TypeError(`expected exactly 32 bytes`);
			value = ethers.hexlify(value);
		} else {
			value = ethers.toBeHex(value || 0, 32);
		}
		await this.provider.send('anvil_setStorageAt', [to_address(a), ethers.toBeHex(slot, 32), value]);
	}
	async getStorageBytesLength(a, slot) {
		return parse_bytes_length(await this.provider.getStorage(a, slot));
	}
	async getStorageBytes(a, slot, maxBytes = 4096) {
		slot = BigInt(slot);
		const header = await this.provider.getStorage(a, slot);
		const size = parse_bytes_length(header);
		if (maxBytes && Number(size) > maxBytes) throw new Error(`too large: ${size} > ${maxBytes}`);
		if (size < 32) return ethers.getBytes(header).slice(0, Number(size));
		const v = new Uint8Array(Number(size)); // throws if huge
		let off = BigInt(ethers.solidityPackedKeccak256(['uint256'], [slot]));
		const ps = [];
		for (let i = 0; i < v.length; i += 32) {
			const pos = i;
			ps.push(this.provider.getStorage(a, off++).then(x => {
				let u = ethers.getBytes(x);
				const n = v.length - pos;
				if (n < 32) u = u.subarray(0, n);
				v.set(u, pos);
			}));
		}
		await Promise.all(ps);
		return v;
	}
	async setStorageBytes(a, slot, v, zeroBytes = true) {
		slot = BigInt(slot);
		v = v ? ethers.getBytes(v) : new Uint8Array(0);
		let off = BigInt(ethers.solidityPackedKeccak256(['uint256'], [slot]));
		let offEnd = 0n;
		if (zeroBytes) {
			if (zeroBytes === true) zeroBytes = 4096;
			const size = await this.getStorageBytesLength(a, slot);
			if (Number(size) > zeroBytes) throw new Error(`prior size too large: ${size} > ${zeroBytes}`);
			offEnd = off + ((size + 31n) >> 5n);
		}
		const ps = [];
		if (v.length < 32) {
			const u = new Uint8Array(32);
			u.set(v);
			u[31] = v.length << 1;
			ps.push(this.setStorageValue(a, slot, u));
		} else {
			ps.push(this.setStorageValue(a, slot, (v.length << 1) | 1));
			for (let pos = 0; pos < v.length; ) {
				const end = pos + 32;
				if (end > v.length) {
					const u = new Uint8Array(32);
					u.set(v.subarray(pos));
					ps.push(this.setStorageValue(a, off++, u));
				} else {
					ps.push(this.setStorageValue(a, off++, v.subarray(pos, end)));
				}
				pos = end;
			}
		}
		while (off < offEnd) {
			ps.push(this.setStorageValue(a, off++, 0));
		}
		await Promise.all(ps);
	}
	async overrideENS({name, node, owner, resolver}) {
		// https://etherscan.io/address/0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
		const slot = BigInt(ethers.solidityPackedKeccak256(["bytes32", "uint256"], [node ?? ethers.namehash(name), 0n]));
		function coerce_address(x) {
			if (x === null) return 0;
			const a = to_address(x);
			if (!a) throw new TypeError(`expected address: ${x}`);
			return a;
		}
		owner = coerce_address(owner);
		resolver = coerce_address(resolver);
		if (resolver !== undefined && BigInt(resolver)) {
			// BUG: https://github.com/foundry-rs/foundry/issues/9743
			// for some reason, the owner needs to be nonzero if the resolver is set
			if (owner === undefined) {
				owner = BigInt(await this.provider.getStorage(this.ensRegistry, slot));
			}
			if (!BigInt(owner)) owner = 1;
		} 
		await Promise.all([
			owner !== undefined && this.setStorageValue(this.ensRegistry, slot, owner), 
			resolver !== undefined && this.setStorageValue(this.ensRegistry, slot + 1n, resolver)
		]);
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
	async attach(args0) {
		let {
			to,
			from = DEFAULT_WALLET,
			abis = [],
			parseAllErrors = true,
			...artifactLike
		} = args0;
		from = await this.ensureWallet(from);
		let {abi: abi0, contract} = await this.resolveArtifact(artifactLike);
		let abi = mergeABI(abi0, ...abis);
		this.addABI(abi);
		if (parseAllErrors) abi = this.parseAllErrors(abi);
		let c = new ethers.Contract(to_address(to), abi, from);
		c[Symbol_name] = `${contract}<${smol_addr(c.target)}>`; 
		c[Symbol_foundry] = this;
		c.__info = {contract};
		c.toString = get_NAME;
		this.accounts.set(c.target, c);
		return c;
	}
	async deploy(arg0) {
		let {
			from = DEFAULT_WALLET,
			args = [],
			libs = {},
			abis = [],
			confirms,
			silent = false,
			parseAllErrors = true,
			...artifactLike
		} = artifact_from(arg0);
		from = await this.ensureWallet(from);
		let {abi: abi0, links, bytecode: bytecode0, origin, contract} = await this.resolveArtifact(artifactLike);
		let abi = mergeABI(abi0, ...abis);
		this.addABI(abi);
		if (parseAllErrors) abi = this.parseAllErrors(abi);
		let {bytecode, linkedLibs} = this.linkBytecode(bytecode0, links, libs);
		let factory = new ethers.ContractFactory(abi, bytecode, from);
		let unsigned = await factory.getDeployTransaction(...args);
		let tx = await from.sendTransaction(unsigned);
		let receipt = new ethers.ContractTransactionReceipt(abi, this.provider, await tx.wait(confirms));
		let c = new ethers.Contract(receipt.contractAddress, abi, from);
		c[Symbol_name] = `${contract}<${smol_addr(c.target)}>`; // so we can deploy the same contract multiple times
		c[Symbol_foundry] = this;
		c.toString = get_NAME;
		let code = ethers.getBytes(await this.provider.getCode(c.target));
		c.__info = {contract, origin, code, libs: linkedLibs, from};
		c.__receipt = receipt;
		this.accounts.set(c.target, c);
		if (!silent && this.infoLog) {
			let stats = [
				`${ansi('33', code.length)}bytes`,
				`${ansi('33', receipt.gasUsed)}gas`,
			];
			if (Object.keys(linkedLibs).length) {
				stats.push(this.pretty(linkedLibs));
			}
			this.infoLog(TAG_DEPLOY, this.pretty(from), origin, this.pretty(c), ...stats);
			this._dump_logs(receipt);
		}
		this.emit('deploy', c); // tx, receipt?
		return c;
	}
	addABI(abi) {
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
	}
	async parseArtifacts() {
		for (const {abi} of await this.artifacts()) {
			this.addABI(abi);
		}
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
			let matches = new Set();
			let first;
			for (let abi of this.event_map.values()) {
				abi.forEachEvent(frag => {
					if (frag.name === event) {
						if (!first) first = {abi, frag};
						matches.add(frag.topicHash);
					}
				});
			}
			if (matches.size > 1) throw error_with(`multiple events: ${event}`, {event, matches})
			if (first) {
				return first;
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

function artifact_from(x) {
	 return typeof x === 'string' ? x.startsWith('0x') ? {bytecode: x} : {sol: x} : x;
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

function parse_bytes_length(header) {
	header = BigInt(header);
	let size = header >> 1n;
	if (header & 1n) {
		if (size < 32n) throw new Error(`invalid large bytes encoding: ${size} < 32`);
	} else {
		size &= 255n;
		if (size >= 32n) throw new Error(`invalid small bytes encoding: ${size} > 31`);
	}
	return size;
}
