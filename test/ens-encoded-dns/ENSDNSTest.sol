/// @author raffy.eth
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ENSDNSUtils} from "./ENSDNSUtils.sol";

contract ENSDNSTest {

	function dnsDecode(bytes memory dns) external pure returns (string memory ens) {
		return ENSDNSUtils.dnsDecode(dns);
	}

	function dnsDecodeUnsafe(bytes memory dns) external pure returns (string memory ens) {
		return ENSDNSUtils.dnsDecodeUnsafe(dns);
	}

	function dnsEncode(string memory ens) external pure returns (bytes memory dns) {
		return ENSDNSUtils.dnsEncode(ens);
	}

	function multicheck(string[] memory names) external pure {
		for (uint256 i; i < names.length; i += 1) {
			string memory ens = names[i];
			if (keccak256(bytes(ens)) != keccak256(bytes(ENSDNSUtils.dnsDecode(ENSDNSUtils.dnsEncode(ens))))) {
				revert(ens);
			}
		}
	}

}