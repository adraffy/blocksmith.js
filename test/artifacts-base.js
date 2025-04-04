import { FoundryBase } from "../src/index.js";

const f = await FoundryBase.load();

console.log('\n[sol shorthand]');
console.log(await f.resolveArtifact('contract C {}'));

console.log(`\n[sol]`)
console.log(await f.resolveArtifact({sol: `contract C {
	function f(uint256 x) external pure returns (uint256) {
		return x + 1;
	}
}`}));

console.log('\n[file]');
const fileArtifact = await f.resolveArtifact({file: 'Deploy'});
console.log(fileArtifact);

console.log('\n[bytecode shorthand]');
console.log(await f.resolveArtifact(fileArtifact.bytecode));

console.log('\n[bytecode]');
console.log(await f.resolveArtifact({bytecode: fileArtifact.bytecode}));

console.log('\n[artifacts]');
console.log((await f.artifacts()).map(x => x.cid));
