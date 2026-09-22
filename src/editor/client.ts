/**
 * The editor git runs for interactive rebases and commit messages (#757).
 *
 * git invokes it as `GIT_SEQUENCE_EDITOR` / `GIT_EDITOR` with the file to
 * edit. It hands the file to the extension over a local socket and waits:
 * the extension opens it in a VS Code editor, and answers once the user has
 * finished (exit 0: git continues with the file as saved) or cancelled
 * (exit 1: git aborts a todo list, or stops at a message).
 *
 * Runs under VS Code's own Node (ELECTRON_RUN_AS_NODE), so it must stay a
 * dependency-free script. Bundled to dist/editor.js.
 */
import { connect } from 'node:net';
import { resolve } from 'node:path';

const socketPath = process.env.GIT_GRAPH_NEXT_EDITOR_SOCKET;
const file = process.argv[2];
if (socketPath === undefined || socketPath === '' || file === undefined) {
	process.stderr.write('git-graph-next editor: not started by Git Graph Next\n');
	process.exit(1);
}

let answered = false;
const socket = connect(socketPath, () => {
	// git runs the editor in the repository, and may pass a relative path. The
	// token proves the request comes from a git command this extension started.
	socket.write(`${JSON.stringify({ file: resolve(file), token: process.env.GIT_GRAPH_NEXT_EDITOR_TOKEN })}\n`);
});
let buffer = '';
socket.setEncoding('utf8');
socket.on('data', (chunk: string) => {
	buffer += chunk;
	const end = buffer.indexOf('\n');
	if (end === -1) return;
	answered = true;
	let ok = false;
	try {
		ok = (JSON.parse(buffer.slice(0, end)) as { ok?: unknown }).ok === true;
	} catch {
		ok = false;
	}
	socket.end();
	process.exit(ok ? 0 : 1);
});
// The extension went away (window closed, extension restarted): cancel.
socket.on('error', () => process.exit(1));
socket.on('close', () => {
	if (!answered) process.exit(1);
});
