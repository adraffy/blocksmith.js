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

export function is_address(s) {
	return typeof s === 'string' && /^0x[0-9a-f]{40}$/i.test(s);
}

export function to_address(x) {
	if (is_address(x)) return x;
	if (is_address(x.target)) return x.target;
	if (is_address(x.address)) return x.address;
}
