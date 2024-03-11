import {Node} from '../src/Node.js';

// TODO: fix me

let root = Node.root();

root.create('sub.raffy.eth');
let sub2 = root.create('sub2.raffy.eth');

console.log(root.depth);

sub2.unique();
let u2 = sub2.unique();
console.log(u2.name, u2.depth);

root.find('sub3.raffy.eth');

root.find('sub.raffy.eth').create('a.b.c');

root.print();

console.log(root.flat().map(x => x.name));
