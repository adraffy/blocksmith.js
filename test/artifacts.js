import {Foundry} from '../src/index.js';
import {ethers} from 'ethers';

const f = await Foundry.launch();

function dump_info(x) {
	const {from, code, ...a} = x.__info;
	console.log({...a, from: String(from), codeSize: ethers.getBytes(code).length});
}

console.log('\n[deployed: sol]');
dump_info(await f.deploy('contract C {}'));

console.log('\n[file]');
dump_info(await f.deploy({file: 'Deploy'}));

console.log('\n[deployed: bytecode]');
const fileArtifact = await f.resolveArtifact({file: 'Deploy'});
dump_info(await f.deploy(fileArtifact.bytecode));

console.log('\n[deployed: artifact]');
dump_info(await f.deploy(fileArtifact));

console.log('\n[parseArtifacts]');
console.log(await f.parseArtifacts());

await f.shutdown();
