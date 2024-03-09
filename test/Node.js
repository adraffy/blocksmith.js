import {Node} from '../src/Node.js';

// TODO: fix me

let root = Node.root();

root.create('sub.raffy.eth');
let sub2 = root.create('sub2.raffy.eth');

sub2.unique();
sub2.unique();


root.find('sub3.raffy.eth');

root.find('sub.raffy.eth').create('a.b.c');

root.print();
