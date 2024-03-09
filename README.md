# blocksmith.js

`npm i @adraffy/blocksmith`

* see [**types**](./dist/index.d.ts) / designed for [Foundry](https://github.com/foundry-rs/foundry) + [ethers](https://github.com/ethers-io/ethers.js).
* compatible with [node:test](https://nodejs.org/api/test.html)
* designed for complex [EIP-3668](https://eips.ethereum.org/EIPS/eip-3668) contracts

### Instructions

1. install [`foundryup`](https://book.getfoundry.sh/getting-started/installation)
1. `npm i`
1. `npm run test`

### Example

[example.js](./test/example.js)
```js
import {Foundry} from '@adraffy/blocksmith';
import {before, test, after} from 'node:test';
import assert from 'node:assert/strict';

let foundry;
before(async () => {
	foundry = await Foundry.launch({
		fork: 'https://cloudflare-eth.com', // launch anvil using mainnet fork
		log: true, // print to console.log()
	});
});
after(() => foundry.shutdown());

const raffy = '0x51050ec063d393217B436747617aD1C2285Aeeee';
test('raffy.eth', async () => {
	assert.equal(await foundry.provider.resolveName('raffy.eth'), raffy);
});
test('onchain wildcard: NFTResolver', async () => {
	assert.equal(await foundry.provider.resolveName('331.moo.nft-owner.eth'), raffy);
});
test('offchain wildcard: TheOffchainGateway', async () => {
	assert.equal(await foundry.provider.resolveName('fixed.tog.raffy.eth'), raffy);
});
```
