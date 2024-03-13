// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract Deploy {
	event Created(address at, address by);
	event Wrote(uint256 x);
	constructor() {
		emit Created(address(this), msg.sender);
	}
	function write(uint256 x) external {
		emit Wrote(x);
	}
	function read() external pure returns (uint256) {
		return 1;
	}
}
