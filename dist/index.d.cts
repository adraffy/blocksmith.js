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
} from "ethers";
import { EventEmitter } from "node:events";
import { ChildProcess } from "node:child_process";

type DevWallet = Omit<Wallet, "connect">;
type DeployedContract = Omit<Contract, "target" | "connect" | "attach"> & {
	readonly __receipt: TransactionReceipt;
	readonly __info: {
		readonly contract: string;
		readonly origin: string;
		readonly bytecode: Uint8Array;
		readonly libs: { [cid: string]: string };
		readonly from: DevWallet;
	};
	// fix ethers
	readonly target: string;
	connect(wallet: DevWallet): DeployedContract;
};
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
	readonly contract: string;
	readonly origin: string;
	readonly abi: Interface;
	readonly bytecode: string;
	readonly links: ExternalLink[];
};
type FileArtifact = CompiledArtifact & {
	readonly file: string;
};
type CodeArtifact = CompiledArtifact & {
	readonly sol: string;
	readonly root: string;
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

type FoundryBaseOptions = {
	root?: PathLike; // default: ancestor w/foundry.toml
	profile?: string; // default: "default"
	forge?: string; // default: "forge" via PATH
};

type FoundryEventMap = {
	built: [];
	shutdown: [uptime: number];
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
		out: string;
		remappings: string[];
	};
	readonly anvil: string;
	readonly forge: string;
	readonly built?: BuildInfo;

	on<E extends keyof FoundryEventMap>(
		name: E,
		fn: (...args: FoundryEventMap[E]) => any
	): this;
	once<E extends keyof FoundryEventMap>(
		name: E,
		fn: (...args: FoundryEventMap[E]) => any
	): this;
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
			infiniteCallGas?: boolean;
		} & FoundryBaseOptions
	): Promise<Foundry>;

	readonly proc: ChildProcess;
	readonly provider: WebSocketProvider;
	readonly wallets: { [name: string]: DevWallet };
	readonly accounts: Map<string, DeployedContract | DevWallet>;
	readonly endpoint: string;
	readonly chain: number;
	readonly port: number;
	readonly automine: boolean;
	readonly fork: string | undefined;

	// note: these are silent fail on forks
	nextBlock(blocks?: number): Promise<void>;
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
	createWallet(
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
					silent?: boolean;
					parseAllErrors?: boolean;
			  } & ArtifactLike)
	): Promise<DeployedContract>;

	// send a transaction promise and get a pretty print console log
	confirm(
		call: Promise<TransactionResponse>,
		options?: {
			silent?: boolean;
			[key: string]: any;
		}
	): Promise<TransactionReceipt>;

	parseAllErrors(iface: Interface): Interface;

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
