import {compile} from '../src/index.js';

console.log(compile(`
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;
contract Chonk {
	constructor() {

	}
}
`));