import {defineConfig} from 'rollup';

export default defineConfig([
	{
		input: './src/index.js',
		output: [
			{
				file: './dist/index.mjs',
				format: 'es',
			},
			{
				file: './dist/index.cjs',
				format: 'cjs',
			},
		],
		external: /^@|^node:|^[^/]+$/
	}
]);
