import {
	WebSocketProvider, BaseWallet, 
	Contract, Interface,
	TransactionReceipt, TransactionResponse, BigNumberish
} from "ethers";
import {ChildProcess} from "node:child_process";

type DevWallet = BaseWallet & {__name: string};
type DeployedContract = Contract & {
	__receipt: TransactionReceipt;
	__artifact: Artifact;
};

type PathLike = string | URL;
type WalletLike = string | DevWallet;
type BaseArtifact = {
	abi: Interface;
	bytecode: string;
	contract: string;
	origin: string;
}
type FileArtifact = BaseArtifact & {file: string};
type InlineArtifact = BaseArtifact & {sol: string};
type Artifact = FileArtifact | InlineArtifact | BaseArtifact;
type ArtifactLike = {
	import?: string;
	sol?: string;
	file?: string;
	abi?: Interface;
	bytecode?: string,
	contract?: string;
};

export function compile(sol: string | string[], options?: {contract?: string, foundry?: Foundry}): Promise<Artifact>;
type ToConsoleLog = boolean | PathLike | ((line: string) => any);
type WalletOptions = {
	ether: BigNumberish;	
};
type BuildInfo = {
	date: Date;
};
export class Foundry {
	static base(dir?: PathLike): string;
	static profile(): string;
	static launch(options: {
		port?: number;
		chain?: number;
		anvil?: string;
		gasLimit?: number;
		blockSec?: number;
		accounts?: string[],
		autoclose?: boolean; // default: true
		infoLog?: ToConsoleLog, // default: off
		procLog?: ToConsoleLog; // default: console.log()
		fork?: PathLike;
		root?: PathLike; // default: ancestor w/foundry.toml
		profile?: string; // default: "default"
	}): Promise<Foundry>;

	readonly proc: ChildProcess;
	readonly provider: WebSocketProvider;
	readonly wallets: {[name: string]: DevWallet};
	readonly accounts: Map<string, DeployedContract | DevWallet>;
	readonly endpoint: string;
	readonly chain: number;
	readonly port: number;
	readonly automine: boolean;
	readonly root: string;
	readonly profile: string;
	readonly config: {
		src: string;
		out: string;
		remappings: string[];
	};
	readonly bin: {
		anvil: string;
		forge: string;
	};
	readonly built?: {date: Date};

	// require a wallet
	requireWallet(wallet: WalletLike, backup?: WalletLike): DevWallet;
	createWallet(options?: {prefix: string} & WalletOptions): Promise<DevWallet>;
	ensureWallet(wallet: WalletLike, options?: WalletOptions): Promise<DevWallet>;

	resolveArtifact(artifact: ArtifactLike): Promise<Artifact>;

	build(force?: boolean): Promise<BuildInfo>;

	// compile and deploy a contract, returns Contract with ABI
	deploy<P>(options: {
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
	static root(): Node;
	static create(name: string | Node): Node;

	readonly parent: Node;
	readonly nodehash: string;
	readonly label: string;
	readonly labelhash: string;

	get root(): Node;
	get name(): string;
	get dns(): Uint8Array;
	get depth(): number;
	get nodes(): number;
	get isETH2LD(): boolean;

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
	
	readonly base?: Node;
	readonly wild?: boolean;
	readonly tor?: boolean;
	readonly drop?: number;

	get address(): string;

	text(key: string, options?: RecordOptions): Promise<string>;
	addr(type?: number, options?: RecordOptions): Promise<string>;
	contenthash(options?: RecordOptions): Promise<string>;
	record(rec: RecordQuery, options?: RecordOptions): Promise<any>;
	records(rec: RecordQuery[], options?: RecordOptions): Promise<RecordResult[]>;
	profile(rec?: RecordQuery[], options?: RecordOptions): Promise<{[key: string]: any}>;

}

export function error_with(message: string, options: Object, cause?: any): Error;
export function to_address(x: any): string;
export function is_address(x: any): boolean;
