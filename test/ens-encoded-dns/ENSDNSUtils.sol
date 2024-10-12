/// @author raffy.eth
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

library ENSDNSUtils {

	// WARNING: a label that contains a stop (.) will not round-trip
	// dnsDecode("3a.b0) = "a.b"
	// dnsEncode("a.b") = "1a1b0"
	// dnsDecode("1a1b0") = "a.b"
	// only use dnsDecodeUnsafe() if you know the label was encoded correctly

	error InvalidName();

	// [ens]  "aaa.bb.c" 
	// [dns] "3aaa2bb1c0"

	// ens.length = dns.length - 2
	// ens is offset 1-byte with lengths replaced with "."

	function dnsDecode(bytes memory dns) internal pure returns (string memory) {
		unchecked {
			uint256 n = dns.length;
			if (n == 1 && dns[0] == 0) return ''; // only valid answer is root
			if (n < 3) revert InvalidName();
			bytes memory ens = new bytes(n - 2); // always 2-shorter
			uint256 src = 0;
			uint256 dst = 0;
			while (src < n) {
				uint8 len = uint8(dns[src++]);
				if (len == 0) break;
				uint256 end = src + len;
				if (end > dns.length) revert InvalidName(); // overflow
				if (dst > 0) ens[dst++] = '.';
				while (src < end) {
					bytes1 c = dns[src++];
					if (c == '.') revert InvalidName(); // malicious label
					ens[dst++] = c;
				}
			}
			if (src != dns.length) revert InvalidName(); // junk
			return string(ens);
		}
	}

	function dnsDecodeUnsafe(bytes memory dns) internal pure returns (string memory ens) {
		unchecked {
			uint256 n = dns.length;
			if (n == 1 && dns[0] == 0) return ''; // only valid answer is root
			if (n < 3) revert InvalidName();
			ens = new string(n -= 2); // always 2-shorter
			// we clobber 31-=bytes beyond the end
			// it's ok since we don't call anything
			uint256 start;
			assembly { start := add(dns, 32) }
			// we only need one pointer since the diff between ens and dns is constant
			uint256 diff;
			assembly { diff := sub(sub(ens, 1), dns) } // shifted, but mangles length
			uint256 src = start;
			while (true) {
				uint256 word;
				assembly { word := mload(src) }
				uint256 len = word >> 248; // read length from msb
				if (len == 0) break;
				uint256 end = src + len;
				if (end > start + n) revert InvalidName(); // overflow
				word = (46 << 248) | ((word << 8) >> 8); // replace length with "."
				assembly { mstore(add(src, diff), word) }
				for (uint256 p = src + 32; p <= end; p += 32) { // memcpy the rest
					assembly { mstore(add(p, diff), mload(p)) }
				}
				src = 1 + end;
			}
			// we break the loop before adding the last empty label
			// so theres only one extra "."
			if (src - start != n + 1) revert InvalidName();
			assembly { mstore(ens, n) } // fix mangled length
		}
	} 

	function dnsEncode(string memory ens) internal pure returns (bytes memory dns) {
		unchecked {
			uint256 n = bytes(ens).length;
			if (n == 0) return hex'00'; // root
			dns = new bytes(n + 2); // always 2-longer
			uint256 w;
			uint256 e;
			uint256 r;
			assembly {
				e := add(dns, 32)
				r := e // remember start
				ens := add(ens, 32)
				for { let i := 0 } lt(i, n) { i := add(i, 1) } {
					let b := shr(248, mload(add(ens, i))) // read byte
					if eq(b, 46) { // found "."
						w := sub(e, r)
						if or(iszero(w), gt(w, 255)) { break } // something wrong
						mstore8(r, w)
						r := add(e, 1) // update start
					} {
						e := add(e, 1)
						mstore8(e, b)
					}
				}
			}
			w = e - r;
			if (w == 0) revert InvalidName(); // empty label
			if (w > 255) return ''; // label too long
			assembly { mstore8(r, w) } // store final length
		}
	}

}