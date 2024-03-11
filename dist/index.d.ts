import {HDNodeWallet, TransactionReceipt, TransactionResponse, JsonRpcProvider, Contract} from "ethers";
import {ChildProcess} from "node:child_process";

type DevWallet = HDNodeWallet & {name: string};
type DeployedContract = Contract & {receipt: TransactionReceipt};

type PathLike = string | URL;
type WalletLike = number | string | DevWallet;

export class Foundry {
	static base(dir?: PathLike): string;
	static profile(): string;
	static launch(options: {
		port?: number;
		chain?: number;
		block_sec?: number;
		accounts?: number;
		autoclose?: boolean;
		log: boolean | Function | PathLike;
		fork: PathLike;
		base: PathLike;
	}): Promise<Foundry>;

	readonly proc: ChildProcess;
	readonly provider: JsonRpcProvider;
	readonly wallets: DevWallet[];
	readonly deployed: Map<string, DeployedContract>;
	readonly info: {
		base: string;
		mnemonic: string;
		endpoint: string;
		chain: number;
		port: number;
		config: Object;
	};
	title<T>(x: T): string | T;
	resolve(path: string): string;
	wallet(wallet: WalletLike): DevWallet;
	deploy<P>(options: {
		wallet?: WalletLike;
		name?: string;
		contract?: string;
		args?: any[];		
	}, proto?: P): Promise<DeployedContract & P>;
	confirm(call: Promise<TransactionResponse>, info?: Object): Promise<TransactionReceipt>;

	shutdown(): void;
}

export class Node extends Map {
	static root(): Node;

	readonly parent: Node;
	readonly nodehash: string;
	readonly label: string;
	readonly labelhash: string;
	readonly info: {wild: boolean, drop: number, tor: boolean};
	
	get name(): string;
	get depth(): number;
	get nodes(): number;

	find(name: string): Node | undefined;
	create(name: string): Node;
	child(label: string): Node;
	unique(prefix?: string): Node;

	scan(fn: (node: Node, level: number) => void, level?: number): void;
	flat(): Node[];
	print(): void;
}

type RecordQuery = {type: 'addr' | 'text' | 'contenthash' | 'pubkey' | 'name', arg?: any};
type RecordResult = {rec: RecordQuery, res?: any, error?: Error};
type TORPrefix =  'on' | 'off' | undefined;

export class Resolver {
	static get(ens: Contract, node: Node): Promise<Resolver | undefined>;

	readonly node: Node;
	readonly base: Node;
	readonly contract: Contract;
	
	fetch(records: RecordQuery[], options?: {multi?: boolean, tor?: TORPrefix}): Promise<RecordResult[]>
}

export function error_with(message: string, options: Object, cause?: any);
export function to_address(thing: Contract | DevWallet | undefined): string;
