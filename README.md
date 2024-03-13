# blocksmith.js

⚠️ This repo is under active development!

`npm i @adraffy/blocksmith`

* see [**types**](./dist/index.d.ts) / designed for [Foundry](https://github.com/foundry-rs/foundry) + [ethers](https://github.com/ethers-io/ethers.js).
* compatible with [node:test](https://nodejs.org/api/test.html)
* designed for complex [EIP-3668](https://eips.ethereum.org/EIPS/eip-3668) contracts

![Screenshot](./test/deploy.png)

### Instructions

1. [`foundryup`](https://book.getfoundry.sh/getting-started/installation)
1. `npm i`
1. `npm run start` &rarr; [`example.js`](./test/example.js)

### Examples

* [`node test/example.js`](./test/example.js) + [`Example.sol`](./test/Example.sol)
* [`node test/deploy.js`](./test/deploy.js) + [`Deploy.sol`](./test/Deploy.sol)
* [`node test/resolver.js`](./test/resolver.js)
* [resolverworks/**TheOffchainResolver.sol**](https://github.com/resolverworks/TheOffchainResolver.sol/blob/main/test/test.js)
* [resolverworks/**XCTENS.sol**](https://github.com/resolverworks/XCTENS.sol/blob/main/test/test.js)

### Additional Tooling

* [`Node`](./src/Node.js) is client-side scaffolding to manage name/label/namehash/labelhash which simplifies many ENS-related functions that require a variety of inputs.

* [`Resolver`](./src/Resolver.js) is a [**TOR**](https://github.com/resolverworks/TheOffchainResolver.sol)-aware [ENSIP-10](https://docs.ens.domains/ensip/10) resolver implementation.
