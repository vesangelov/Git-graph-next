import * as esbuild from 'esbuild';
import { globSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

/** Reports build errors with file/line so they are clickable in the terminal. */
const problemReporter = {
	name: 'problem-reporter',
	setup(build) {
		build.onEnd((result) => {
			for (const err of result.errors) {
				const loc = err.location;
				console.error(loc ? `✘ ${loc.file}:${loc.line}:${loc.column}: ${err.text}` : `✘ ${err.text}`);
			}
			console.log(`[${new Date().toLocaleTimeString()}] build ${result.errors.length ? 'failed' : 'finished'}`);
		});
	}
};

const shared = {
	bundle: true,
	minify: production,
	sourcemap: production ? false : 'inline',
	logLevel: 'silent',
	plugins: [problemReporter]
};

/** The extension host runs in Node and must not bundle the vscode module. */
const extensionConfig = {
	...shared,
	entryPoints: ['src/extension.ts'],
	outfile: 'dist/extension.js',
	format: 'cjs',
	platform: 'node',
	target: 'node20',
	external: ['vscode']
};

/** The editor script git runs for interactive rebases; see src/editor/client.ts. */
const editorConfig = {
	...shared,
	entryPoints: ['src/editor/client.ts'],
	outfile: 'dist/editor.js',
	format: 'cjs',
	platform: 'node',
	target: 'node20'
};

/** The webview runs in a browser sandbox with no module loader, so it is one IIFE. */
const webviewConfig = {
	...shared,
	entryPoints: ['webview/main.ts', 'webview/style.css'],
	outdir: 'dist/webview',
	format: 'iife',
	platform: 'browser',
	target: 'es2022'
};

/** Tests are bundled to plain JS because this Node build cannot strip types itself. */
const testConfig = {
	...shared,
	entryPoints: globSync('test/**/*.test.ts'),
	outdir: 'out/test',
	format: 'cjs',
	platform: 'node',
	target: 'node20',
	sourcemap: 'inline',
	// Test-only dependencies (jsdom) load from node_modules at run time.
	packages: 'external'
};

if (tests) {
	await esbuild.build(testConfig);
} else if (watch) {
	const contexts = await Promise.all([esbuild.context(extensionConfig), esbuild.context(editorConfig), esbuild.context(webviewConfig)]);
	await Promise.all(contexts.map((c) => c.watch()));
} else {
	await Promise.all([esbuild.build(extensionConfig), esbuild.build(editorConfig), esbuild.build(webviewConfig)]);
}
