import { FoundryBase } from "../src/index.js";

const f = await FoundryBase.load();

const solArtifact = await f.resolveArtifact({sol: `contract C {
	function f(uint256 x) external pure returns (uint256) {
		return x + 1;
	}
}`});
console.log(solArtifact.abi);

const fileArtifact = await f.resolveArtifact({file: 'Deploy.sol'});
console.log(fileArtifact.abi);


