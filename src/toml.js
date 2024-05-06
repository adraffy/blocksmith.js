import {error_with} from './utils.js';

// https://toml.io/en/v1.0.0

export function encode(obj) {
	let lines = [];
	write(lines, obj, []);
	return lines.join('\n');
}

function write(lines, obj, path) {
	let after = [];
	for (let [k, v] of Object.entries(obj)) {
		if (v === null) continue;
		if (is_basic(v)) {
			lines.push(`${encode_key(k)} = ${format_value(v)}`);
		} else if (Array.isArray(v)) {
			if (v.every(is_basic)) {
				lines.push(`${encode_key(k)} = [${v.map(format_value)}]`);
			} else {
				after.push([k, v]);
			}
		} else if (v?.constructor === Object) {
			after.push([k, v]);
		} else {
			throw error_with(`invalid type: "${k}"`, undefined, {key: k, value: v})
		}
	}
	for (let [k, v] of after) {
		path.push(encode_key(k));
		if (Array.isArray(v)) {
			let header = `[[${path.join('.')}]]`;
			for (let x of v) {
				lines.push(header);
				write(lines, x, path);
			}
		} else {
			lines.push(`[${path.join('.')}]`);
			write(lines, v, path);
		}
		path.pop();
	}
}

function format_value(x) {
	if (typeof x === 'number' && Number.isInteger(x) && x > 9223372036854775000e0) {
		return '9223372036854775000'; // next smallest javascript integer below 2^63-1
	} 
	return JSON.stringify(x);
}

function encode_key(x) {
	return /^[a-z_][a-z0-9_]*$/i.test(x) ? x : JSON.stringify(x);
}

function is_basic(x) {
	//if (x === null) return true;
	switch (typeof x) {
		case 'boolean':
		case 'number':
		case 'string': return true;
	}
}

/*
console.log(encode({
	"fruits": [
		{
			"name": "apple",
			"physical": {
				"color": "red",
				"shape": "round"
			},
			"varieties": [
				{ "name": "red delicious" },
				{ "name": "granny smith" }
			]
		},
		{
			"name": "banana",
			"varieties": [
				{ "name": "plantain" }
			]
		}
	]
}));
*/