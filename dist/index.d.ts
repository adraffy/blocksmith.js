import {HDNodeWallet, TransactionReceipt, TransactionResponse, JsonRpcProvider, Contract} from "ethers";
import {ChildProcess} from "node:child_process";

type DevWallet = HDNodeWallet & {__name: string};
type DeployedContract = Contract & {
	__tx: TransactionReceipt;
	__name: string;
	__file: string;
	__code: Uint8Array;
};

type PathLike = string | URL;
type WalletLike = number | string | DevWallet;

export class Foundry {
	static base(dir?: PathLike): string;
	static profile(): string;
	static launch(options: {
		port?: number;
		chain?: number;
		block_sec?: number;
		accounts?: number; // default: 5
		autoclose?: boolean; // default: true
		log?: boolean | PathLike | ((chunk: string) => any);
		fork?: PathLike;
		base?: PathLike;
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

	// get the name of a contract or wallet
	desc<T>(x: T): string | T;

	// require a wallet
	wallet(wallet: WalletLike): DevWallet;

	// compile and deploy a contract, returns Contract with ABI
	deploy<P>(options: {
		wallet?: WalletLike;
		name?: string;
		contract?: string;
		args?: any[];
	}, proto?: P): Promise<DeployedContract & P>;

	// send a transaction promise and get a pretty print console log
	confirm(call: Promise<TransactionResponse>, info?: Object): Promise<TransactionReceipt>;

	// kill anvil
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
type RecordResult = {rec: RecordQuery, res?: any, err?: Error};
type TORPrefix =  'on' | 'off' | undefined;
type RecordOptions = {multi?: boolean, ccip?: boolean, tor?: TORPrefix};

export class Resolver {
	static get(ens: Contract, node: Node): Promise<Resolver | undefined>;

	readonly node: Node;
	readonly base: Node;
	readonly contract: Contract;
	readonly info: {wild: boolean, drop: number, tor: boolean};

	get address(): string;

	text(key: string, options?: RecordOptions): Promise<string>;
	addr(type?: number, options?: RecordOptions): Promise<string>;
	contenthash(options?: RecordOptions): Promise<string>;
	record(rec: RecordQuery, options?: RecordOptions): Promise<any>;
	records(rec: RecordQuery[], options?: RecordOptions): Promise<RecordResult[]>;
}

export function error_with(message: string, options: Object, cause?: any): Error;
export function to_address(x: any): string;
export function is_address(x: any): boolean;
