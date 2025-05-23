# blocksmith.js

⚠️ This repo is under active development!

`npm i @adraffy/blocksmith` [&check;](https://www.npmjs.com/package/@adraffy/blocksmith)

* see [**types**](./dist/index.d.mts) / designed for [Foundry](https://github.com/foundry-rs/foundry) + [ethers](https://github.com/ethers-io/ethers.js).
* compatible with any async test runner, including [node:test](https://nodejs.org/api/test.html)
* designed for complex [EIP-3668](https://eips.ethereum.org/EIPS/eip-3668) contracts 
* reads directly from [`foundry.toml`](https://book.getfoundry.sh/reference/config/overview)
* deploy inline contracts with string templates

![Screenshot](./test/deploy/screenshot.png)

### Instructions

1. [`foundryup`](https://book.getfoundry.sh/getting-started/installation)
1. `npm i`
1. `npm run start` &rarr; runs deploy example: [`js`](./test/deploy/test.js) + [`sol`](./test/Deploy.sol)

### Examples

* [./test/deploy/](./test/deploy/)
* [./test/ens-encoded-dns/](./test/ens-encoded-dns/)
* [./test/extlib/](./test/ens-encoded-dns/)
* [resolverworks/**TheOffchainResolver.sol**](https://github.com/resolverworks/TheOffchainResolver.sol/blob/main/test/test.js)
* [resolverworks/**XCTENS.sol**](https://github.com/resolverworks/XCTENS.sol/blob/main/test/test.js)
* [resolverworks/**OffchainNext.sol**](https://github.com/resolverworks/OffchainNext.sol/blob/main/test/test.js)
* [unruggable-labs/**unruggable-gateways**](https://github.com/unruggable-labs/unruggable-gateways/)
* [unruggable-labs/**Storage.sol**](https://github.com/unruggable-labs/Storage.sol)
* [adraffy/**CCIPRewriter.sol**](https://github.com/adraffy/CCIPRewriter.sol)
* [adraffy/**punycode.sol**](https://github.com/adraffy/punycode.sol)

### Additional Tooling

* [`Node`](./src/Node.js) is client-side scaffolding to manage name/label/namehash/labelhash which simplifies many ENS-related functions that require a variety of inputs.
* [`Resolver`](./src/Resolver.js) is a [**TOR**](https://github.com/resolverworks/TheOffchainResolver.sol)-aware [ENSIP-10](https://docs.ens.domains/ensip/10) resolver implementation.

### Funding Support

* Received [GG20 ENS Retro Grant](https://discuss.ens.domains/t/gg20-ens-identity-round-conclusion/19301) from Arbitrum DAO, Gitcoin, SpruceID, and ThankARB
* [GG22 OSS - Developer Tooling and Libraries](https://builder.gitcoin.co/#/chains/8453/registry/0x/projects/0xf1082b71aa913e5749b81b0c1f9c0be7fc94b60c1d34a9d668575a0b141e59e6)
* [GG23 OSS - Developer Tooling and Libraries](https://builder.gitcoin.co/#/chains/42161/registry/0x/projects/0x2b9be3c545fd71f47c0bc1c17c04baeb8f3d4c350b777b1aeff5a093216e47a3)
