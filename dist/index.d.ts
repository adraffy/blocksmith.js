import {
	WebSocketProvider, BaseWallet, 
	Contract, Interface,
	TransactionReceipt, TransactionResponse, BigNumberish
} from "ethers";
import {ChildProcess} from "node:child_process";

type DevWallet = BaseWallet & {
	readonly __name: string;
};
type DeployedContract = Contract & {
	readonly __receipt: TransactionReceipt;
	readonly __artifact: Artifact;
	//readonly __bytecode: Uint8Array;
	readonly target: string;
};

type PathLike = string | URL;
type WalletLike = string | DevWallet;
type BaseArtifact = {
	readonly abi: Interface;
	readonly bytecode: string;
	readonly contract: string;
	readonly origin: string;
};
type FileArtifact = BaseArtifact & {
	readonly file: string;
};
type InlineArtifact = BaseArtifact & {
	readonly sol: string;
};
type Artifact = FileArtifact | InlineArtifact | BaseArtifact;
type ArtifactLike = {
	import?: string;
	sol?: string;
	file?: string;
	abi?: Interface;
	bytecode?: string,
	contract?: string;
	//[key: string]: any;
};

export function compile(sol: string | string[], options?: {
	contract?: string;
	foundry?: Foundry;
	optimize?: boolean | number;
	//[key: string]: any;
}): Promise<Artifact>;
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
	forge?: string;
};
export class FoundryBase {
	static profile(): string;
	static root(cwd?: PathLike): Promise<string>;
	static load(options?: FoundryBaseOptions): Promise<FoundryBase>;
	build(force?: boolean): Promise<BuildInfo>;
	find(options: {file: string, contract?: string}): Promise<string>;
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
}
export class Foundry extends FoundryBase {
	static launch(options?: {
		port?: number;
		chain?: number;
		anvil?: string;
		gasLimit?: number;
		blockSec?: number;
		accounts?: string[],
		autoClose?: boolean; // default: true
		infoLog?: ToConsoleLog, // default: off
		procLog?: ToConsoleLog; // default: console.log()
		fork?: PathLike;
		infiniteCallGas?: number;
	} & FoundryBaseOptions): Promise<Foundry>;

	readonly proc: ChildProcess;
	readonly provider: WebSocketProvider;
	readonly wallets: {[name: string]: DevWallet};
	readonly accounts: Map<string, DeployedContract | DevWallet>;
	readonly endpoint: string;
	readonly chain: number;
	readonly port: number;
	readonly automine: boolean;

	nextBlock(blocks?: number): Promise<void>;

	// require a wallet
	requireWallet(wallet: WalletLike, backup?: WalletLike): DevWallet;
	createWallet(options?: {prefix?: string} & WalletOptions): Promise<DevWallet>;
	ensureWallet(wallet: WalletLike, options?: WalletOptions): Promise<DevWallet>;

	resolveArtifact(artifact: ArtifactLike): Promise<Artifact>;

	// compile and deploy a contract, returns Contract with ABI
	deploy(options: {
		from?: WalletLike;
		args?: any[];
		silent?: boolean;
	} & ArtifactLike): Promise<DeployedContract>;

	// send a transaction promise and get a pretty print console log
	confirm(call: Promise<TransactionResponse>, options?: {
		silent?: boolean;
		[key: string]: any;
	}): Promise<TransactionReceipt>;

	// kill anvil
	shutdown(): Promise<void>;
}

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

type RecordQuery = {type: 'addr' | 'text' | 'contenthash' | 'pubkey' | 'name', arg?: any};
type RecordResult = {rec: RecordQuery, res?: any, err?: Error};
type TORPrefix =  'on' | 'off' | undefined;
type RecordOptions = {multi?: boolean, ccip?: boolean, tor?: TORPrefix};

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
	records(rec: RecordQuery[], options?: RecordOptions): Promise<[records: RecordResult[], multicalled?: boolean]>;
	profile(rec?: RecordQuery[], options?: RecordOptions): Promise<{[key: string]: any}>;

}

export function error_with(message: string, options: Object, cause?: any): Error;
export function to_address(x: any): string;
export function is_address(x: any): boolean;
