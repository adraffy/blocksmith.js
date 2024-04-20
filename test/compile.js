import {compile} from '../src/index.js';

// TODO: fix me

console.log(await compile(`
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;
contract Chonk {
	constructor() {

	}
}
`));