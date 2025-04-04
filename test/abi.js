import { FoundryBase } from "../src/index.js";

const f = await FoundryBase.load();

console.log('\[sol shorthand]');
console.log(await f.resolveArtifact('contract C {}'));

console.log(`\[sol]`)
console.log(await f.resolveArtifact({sol: `contract C {
	function f(uint256 x) external pure returns (uint256) {
		return x + 1;
	}
}`}));

console.log('\[file]');
const fileArtifact = await f.resolveArtifact({file: 'Deploy'});
console.log(fileArtifact);

console.log('\[bytecode shorthand]');
console.log(await f.resolveArtifact(fileArtifact.bytecode));

console.log('\[bytecode]');
console.log(await f.resolveArtifact({bytecode: fileArtifact.bytecode}));
