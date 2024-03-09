import {HDNodeWallet, TransactionReceipt, JsonRpcProvider, Contract} from "ethers";
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
	
	resolve(path: string): string;
	wallet(wallet: WalletLike): DevWallet;
	deploy<P>(options: {
		wallet?: WalletLike;
		name?: string;
		file?: string;
		contract?: string;
		args?: any[];		
	}, proto?: P): Promise<DeployedContract & P>;
	shutdown(): void;
}

export class Node extends Map {
	static root(): Node;

	readonly parent: Node;
	readonly nodehash: string;
	readonly label: string;
	readonly labelhash: string;
	readonly info: {wild: boolean, drop: number, tor: boolean};

	find(name: string): Node | undefined;
	create(name: string): Node;
	child(label: string): Node;
	unique(prefix?: string): Node;

	nodes(): Node[];

	get name(): string;
	print(): void;
}

type RecordQuery = {type: 'addr' | 'text' | 'contenthash' | 'pubkey' | 'name', arg?: any};
type RecordResult = {rec: RecordQuery, res?: any, error?: Error};

export class Resolver {
	static get(ens: Contract, node: Node): Promise<Resolver | undefined>;

	readonly node: Node;
	readonly base: Node;
	readonly contract: Contract;
	
	fetch(records: RecordQuery[], options?: {multi?: boolean, tor_prefix?: string}): Promise<RecordResult[]>
}

export function error_with(message: string, options: Object, cause?: any);
export function to_address(thing: Contract | DevWallet | null | undefined): string;
