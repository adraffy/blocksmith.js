import {ethers} from 'ethers';

export function error_with(message, params, cause) {
	let error;
	if (cause) {
		error = new Error(message, {cause});
		if (!error.cause) error.cause = cause;
	} else {
		error = new Error(message);
	}
	return Object.assign(error, params);
}

// extract an address from ethers objects
export function to_address(x) {
	if (x instanceof ethers.Contract) {
		return x.target;
	} else if (x instanceof ethers.BaseWallet) {
		return x.address;
	} else if (typeof x === 'string') {
		return x;
	} else if (!x) {
		return ethers.ZeroAddress;
	}
	throw error_with('unable to coerce address', {input: x});
}
