import {Foundry} from '../src/Foundry.js';
import {ethers} from 'ethers';

const f = await Foundry.launch();

console.log('\[sol]');
const solArtifact = await f.resolveArtifact({sol: 'contract C {}'});
console.log(solArtifact);

console.log('\[file]');
const fileArtifact = await f.resolveArtifact({file: 'Deploy'});
console.log(fileArtifact);

console.log('\[bytecode]');
const bytecodeArtifact = await f.resolveArtifact({bytecode: fileArtifact.bytecode});
console.log(bytecodeArtifact);

function dump_info(x) {
	const {from, code, ...a} = x.__info;
	console.log({...a, from: String(from), codeSize: ethers.getBytes(code).length});
}

console.log('\n[deployed: sol]');
dump_info(await f.deploy('contract C {}'));

console.log('\n[file]');
dump_info(await f.deploy({file: 'Deploy'}));

console.log('\n[deployed: bytecode]');
dump_info(await f.deploy(solArtifact.bytecode));

console.log('\n[deployed: compiled artifact]');
dump_info(await f.deploy(bytecodeArtifact));

await f.shutdown();
