import {
	WebSocketProvider,
	Wallet,
	Contract,
	Interface,
	Fragment,
	JsonFragment,
	TransactionReceipt,
	TransactionResponse,
	TransactionDescription,
	BigNumberish,
	BytesLike,
	BaseContract,
	ContractInterface,
	ContractEventName,
	EventEmitterable,
	Log,
	Result,
	EventFragment,
} from "ethers";
import { EventEmitter } from "node:events";
import { ChildProcess } from "node:child_process";
import { SigningKey } from "ethers";

type DevWallet = Omit<Wallet, "connect">;
type DeployedBaseContract = Omit<
	BaseContract,
	"target" | "connect" | "attach"
> & {
	target: string;
	connect(...args: Parameters<Contract["connect"]>): Contract;
	attach(...args: Parameters<Contract["attach"]>): Contract;
	waitForDeployment(): Promise<Contract>;
} & {
	readonly __receipt: TransactionReceipt;
	readonly __info: {
		readonly contract: string;
		readonly origin: string;
		readonly bytecode: Uint8Array;
		readonly libs: { [cid: string]: string };
		readonly from: DevWallet;
	};
};
type DeployedContract = DeployedBaseContract &
	Omit<ContractInterface, keyof DeployedBaseContract> &
	EventEmitterable<ContractEventName>;

type EventLike = string | EventFragment;
type InterfaceLike =
	| Interface
	| Contract
	| (Fragment | JsonFragment | string)[];

type ExternalLink = {
	file: string;
	contract: string;
	offsets: number[];
};

type PathLike = string | URL;
type WalletLike = string | DevWallet;
type CompiledArtifact = {
	readonly type: string;
	readonly contract: string;
	readonly origin: string;
	readonly abi: Interface;
	readonly bytecode: string;
	readonly links: ExternalLink[];
};
type CompiledFromSourceArtifact = CompiledArtifact & {
	readonly cid: string;
	readonly root: string;
	readonly compiler: string;
};
type FileArtifact = CompiledFromSourceArtifact & {
	readonly file: string;
};
type CodeArtifact = CompiledFromSourceArtifact & {
	readonly sol: string;
};
type Artifact = CompiledArtifact | FileArtifact | CodeArtifact;
type CompileOptions = {
	optimize?: boolean | number;
	solcVersion?: string;
	evmVersion?: string;
	viaIR?: boolean;
	autoHeader?: boolean;
	contract?: string;
};

export function compile(
	sol: string | string[],
	options?: { foundry?: Foundry } & CompileOptions
): Promise<CodeArtifact>;

type ArtifactLike =
	| { import: string; contract?: string }
	| { bytecode: string; abi?: InterfaceLike; contract?: string }
	| ({ sol: string } & CompileOptions)
	| { file: string; contract?: string };

type ToConsoleLog = boolean | PathLike | ((line: string) => any);
type WalletOptions = {
	ether?: BigNumberish;
};
type BuildInfo = {
	date: Date;
};

type ConfirmOptions = {
	silent?: boolean;
	confirms?: number;
};

type Backend = "ethereum" | "optimism";

type FoundryBaseOptions = {
	root?: PathLike; // default: ancestor w/foundry.toml
	profile?: string; // default: "default"
	forge?: string; // default: "forge" via PATH
};

type BuildEvent = {
	started: Date;
	root: string;
	cmd: string[];
	force: boolean;
	profile: string;
	mode: "project" | "shadow" | "compile";
};

type FoundryEventMap = {
	building: [event: BuildEvent];
	built: [event: BuildEvent & { sources: string[] }];
	shutdown: [];
	tx: [
		tx: TransactionResponse,
		receipt: TransactionReceipt,
		desc?: TransactionDescription
	];
	console: [line: string];
	deploy: [contract: DeployedContract];
};

export class FoundryBase extends EventEmitter {
	// <FoundryEventMap> {
	static profile(): string;
	static root(cwd?: PathLike): Promise<string>;
	static load(options?: FoundryBaseOptions): Promise<FoundryBase>;
	build(force?: boolean): Promise<BuildInfo>;
	compile(
		sol: string | string[],
		options?: CompileOptions
	): Promise<CodeArtifact>;
	find(options: { file: string; contract?: string }): Promise<string>;
	readonly root: string;
	readonly profile: string;
	readonly config: {
		src: string;
		test: string;
		out: string;
		libs: string[];
		remappings: string[];
	};
	readonly forge: string;
	readonly built?: BuildInfo;
	version(): Promise<string>;

	on<E extends keyof FoundryEventMap>(
		name: E,
		fn: (...args: FoundryEventMap[E]) => any
	): this;
	once<E extends keyof FoundryEventMap>(
		name: E,
		fn: (...args: FoundryEventMap[E]) => any
	): this;
}

type SolidityStandardJSONInput = {
	language: string;
	sources: { [cid: string]: { content: string } };
	optimizer: {
		enabled: boolean;
		runs?: number;
	};
	settings: {
		remappings: string[];
		metadata: Record<string, any>;
		evmVersion: string;
		viaIR: boolean;
		libraries: { [cid: string]: { [contract: string]: string } };
	};
};

export type Deployable = {
	gas: bigint;
	wei: bigint;
	eth: string;
	root: string;
	linked: (ExternalLink & { cid: string; address: string })[];
	compiler: string;
	decodedArgs: any[];
	encodedArgs: string;
	deployArgs(injectPrivateKey?: boolean): string[];
	deploy(options?: {
		confirms?: number;
	}): Promise<{ contract: Contract; receipt: TransactionReceipt }>;
	json(): Promise<Readonly<SolidityStandardJSONInput>>;
	verifyEtherscan(address?: string): Promise<void>;
};

type FoundryDeployerOptions = FoundryBaseOptions & {
	infoLog?: ToConsoleLog; // default: true
};

export class FoundryDeployer extends FoundryBase {
	static etherscanChains(): Promise<Map<bigint, string>>;

	static mainnet(
		privateKey?: BytesLike | SigningKey,
		options?: FoundryDeployerOptions
	): Promise<FoundryDeployer>;
	static sepolia(
		privateKey?: BytesLike | SigningKey,
		options?: FoundryDeployerOptions
	): Promise<FoundryDeployer>;

	static load(
		options: {
			wallet: Wallet;
		} & FoundryDeployerOptions
	): Promise<FoundryDeployer>;

	readonly rpc: string;
	readonly chain: bigint;
	readonly wallet: Wallet;

	prepare(
		options:
			| string
			| ({
					args?: any[];
					libs?: { [cid: string]: string };
					confirms?: number;
			  } & ArtifactLike)
	): Promise<Readonly<Deployable>>;

	verifyEtherscan(options: {
		json: SolidityStandardJSONInput;
		address: string; // 0x...
		cid?: string; // "src/File.sol:Contract"
		apiKey?: string; // foundry.toml => ETHERSCAN_API_KEY
		encodedArg?: string | Uint8Array;
		compiler?: string; // can be semver
		pollMs?: number; // default: 5sec
		retry?: number; // default: 3
	}): Promise<void>;
}

export class Foundry extends FoundryBase {
	static of(x: DevWallet | DeployedContract): Foundry;
	static launch(
		options?: {
			port?: number;
			chain?: number;
			anvil?: string;
			gasLimit?: number;
			blockSec?: number;
			accounts?: string[];
			autoClose?: boolean; // default: true
			infoLog?: ToConsoleLog; // default: true = console.log()
			procLog?: ToConsoleLog; // default: off
			fork?: PathLike;
			infiniteCallGas?: boolean; // default: false
			genesisTimestamp?: number; // default: now
			backend?: Backend; // default: 'ethereum'
			hardfork?: string; // default: latest
		} & FoundryBaseOptions
	): Promise<Foundry>;

	readonly anvil: string;
	readonly proc: ChildProcess;
	readonly provider: WebSocketProvider;
	readonly wallets: Record<string, DevWallet>;
	readonly accounts: Map<string, DeployedContract | DevWallet>;
	readonly endpoint: string;
	readonly chain: number;
	readonly port: number;
	readonly automine: boolean;
	readonly backend: Backend;
	readonly hardfork: string;
	readonly started: Date;
	readonly fork: string | undefined;

	// note: these are silent fail on forks
	nextBlock(options?: { blocks?: number; sec?: number }): Promise<void>;
	setStorageValue(
		address: string | DeployedContract,
		slot: BigNumberish,
		value: BigNumberish | Uint8Array
	): Promise<void>;
	setStorageBytes(
		address: string | DeployedContract,
		slot: BigNumberish,
		value: BytesLike
	): Promise<void>;

	// require a wallet
	requireWallet(...wallets: (WalletLike | undefined)[]): DevWallet;
	randomWallet(
		options?: { prefix?: string } & WalletOptions
	): Promise<DevWallet>;
	ensureWallet(
		wallet: WalletLike,
		options?: WalletOptions
	): Promise<DevWallet>;

	resolveArtifact(artifact: ArtifactLike): Promise<Artifact>;

	// compile and deploy a contract, returns Contract with ABI
	deploy(
		options:
			| string
			| ({
					from?: WalletLike;
					args?: any[];
					libs?: { [cid: string]: string | DeployedContract };
					abis?: InterfaceLike[];
					parseAllErrors?: boolean;
			  } & ConfirmOptions &
					ArtifactLike)
	): Promise<DeployedContract>;

	// send a transaction promise and get a pretty print console log
	confirm(
		call: TransactionResponse | Promise<TransactionResponse>,
		options?: ConfirmOptions & Record<string, any>
	): Promise<TransactionReceipt>;

	addABI(abi: Interface): void;
	parseAllErrors(iface: Interface): Interface;

	findEvent(event: EventLike): { abi: Interface; frag: EventFragment };
	getEventResults(
		logs: Log[] | TransactionReceipt | DeployedContract,
		event: EventLike
	): Result[];

	// kill anvil (this is a bound function)
	shutdown: () => Promise<void>;
}

export function mergeABI(...abis: InterfaceLike[]): Interface;

export class Node extends Map {
	static root(tag?: string): Node;
	static create(name: string | Node): Node;

	readonly label: string;
	readonly parent: Node;

	readonly namehash: string;
	readonly labelhash: string;
	get dns(): Uint8Array;

	get name(): string;
	get isETH2LD(): boolean;

	get depth(): number;
	get nodeCount(): number;
	get root(): Node;
	path(includeRoot?: boolean): Node[];

	find(name: string): Node | undefined;
	create(name: string): Node;
	child(label: string): Node;
	unique(prefix?: string): Node;

	scan(fn: (node: Node, level: number) => void, level?: number): void;
	flat(): Node[];
	print(): void;
}

type RecordQuery = {
	type: "addr" | "text" | "contenthash" | "pubkey" | "name";
	arg?: any;
};
type RecordResult = { rec: RecordQuery; res?: any; err?: Error };
type TORPrefix = "on" | "off" | undefined;
type RecordOptions = { multi?: boolean; ccip?: boolean; tor?: TORPrefix };

export class Resolver {
	static readonly ABI: Interface;
	static get(ens: Contract, node: Node): Promise<Resolver | undefined>;

	constructor(node: Node, contract: Contract);

	readonly node: Node;
	readonly contract: Contract;

	readonly base: Node;
	readonly drop: number;

	wild: boolean;
	tor: boolean;

	get address(): string;

	text(key: string, options?: RecordOptions): Promise<string>;
	addr(type?: number, options?: RecordOptions): Promise<string>;
	contenthash(options?: RecordOptions): Promise<string>;
	record(rec: RecordQuery, options?: RecordOptions): Promise<any>;
	records(
		rec: RecordQuery[],
		options?: RecordOptions
	): Promise<[records: RecordResult[], multicalled?: boolean]>;
	profile(
		rec?: RecordQuery[],
		options?: RecordOptions
	): Promise<{ [key: string]: any }>;
}

export function error_with(
	message: string,
	options: Object,
	cause?: any
): Error;
export function to_address(x: any): string;
export function is_address(x: any): boolean;
