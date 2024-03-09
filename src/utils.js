import {ethers} from 'ethers';

export function error_with(message, options, cause) {
	let error;
	if (cause) {
		error = new Error(message, {cause});
		if (!error.cause) error.cause = cause;
	} else {
		error = new Error(message);
	}
	return Object.assign(error, options);
}

export function to_address(x) {
	if (x instanceof ethers.Contract) {
		return x.target;
	} else if (typeof x === 'string') {
		return x;
	} else if (!x) {
		return ethers.ZeroAddress;
	} 
	throw new Error('expected address');
}
