import {ethers} from 'ethers';

export class Node extends Map {
	static root() {
		return new this(null, ethers.ZeroHash, '[root]');
	}
	constructor(parent, namehash, label, labelhash) {
		super();
		this.parent = parent;
		this.namehash = namehash;
		this.label = label;
		this.labelhash = labelhash;
	}
	get root() {
		let node = this;
		while (node.parent) {
			node = node.parent;
		}
		return node;
	}
	get name() {
		let v = [];
		for (let node = this; node.parent != null; node = node.parent) {
			v.push(node.label);
		}
		return v.join('.');
	}
	nodes(v = []) {
		v.push(this);
		for (let x of this.values()) x.nodes(v);
		return v;
	}
	find(name) {
		if (!name) return this;
		return name.split('.').reduceRight((n, s) => n?.get(s), this);
	}
	create(name) {
		if (!name) return this;
		return name.split('.').reduceRight((n, s) => n.child(s), this);
	}
	unique(prefix = 'u') {
		for (let i = 1; ; i++) {
			let label = prefix + i;
			if (!this.has(label)) return this.child(label);
		}
	}
	child(label) {
		let c = this.get(label);
		if (!c) {
			let labelhash = ethers.id(label)
			let namehash = ethers.solidityPackedKeccak256(['bytes32', 'bytes32'], [this.namehash, labelhash]);
			c = new this.constructor(this, namehash, label, labelhash);
			this.set(label, c);
		}
		return c;
	}
	print(format = x => x.label, level = 0) {
		console.log('  '.repeat(level++), format(this));
		for (let x of this.values()) {
			x.print(format, level);
		}
	}
	toString() {
		return this.name;
	}
}
