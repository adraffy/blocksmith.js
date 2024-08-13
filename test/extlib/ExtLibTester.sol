// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ExtLib} from "./ExtLib.sol";

contract ExtLibTester {

	function chonk() external pure returns (uint256) {
		return ExtLib.chonk();
	}

}
