/**
 * The helper git runs for two jobs it cannot do by itself here:
 *
 *  --editor  <file>    the interactive-rebase todo list or a commit message
 *                      (`GIT_SEQUENCE_EDITOR` / `GIT_EDITOR`, #757): the
 *                      extension opens it in a VS Code editor and answers when
 *                      the user is done (exit 0) or cancels (exit 1).
 *  --askpass <prompt>  a password or passphrase (`GIT_ASKPASS` / `SSH_ASKPASS`,
 *                      #755, #813): the extension asks in a VS Code input box
 *                      and the answer is printed for git to read.
 *
 * Both talk to the extension over a local socket, carrying a token that proves
 * the request belongs to a command this extension started.
 *
 * Runs under VS Code's own Node (ELECTRON_RUN_AS_NODE), so it must stay a
 * dependency-free script. Bundled to dist/editor.js.
 */
import { connect } from 'node:net';
import { resolve } from 'node:path';

const socketPath = process.env.GIT_GRAPH_NEXT_EDITOR_SOCKET;
const [mode, value] = process.argv.slice(2);
const kind = mode === '--askpass' ? 'prompt' : 'edit';

if (socketPath === undefined || socketPath === '' || value === undefined) {
	process.stderr.write('git-graph-next: not started by Git Graph Next\n');
	process.exit(1);
}

let answered = false;
const socket = connect(socketPath, () => {
	// git runs the editor in the repository and may pass a relative path; a
	// prompt is passed as written.
	socket.write(`${JSON.stringify({ kind, value: kind === 'edit' ? resolve(value) : value, token: process.env.GIT_GRAPH_NEXT_EDITOR_TOKEN })}\n`);
});
let buffer = '';
socket.setEncoding('utf8');
socket.on('data', (chunk: string) => {
	buffer += chunk;
	const end = buffer.indexOf('\n');
	if (end === -1) return;
	answered = true;
	let reply: { ok?: unknown; value?: unknown } = {};
	try {
		reply = JSON.parse(buffer.slice(0, end)) as { ok?: unknown; value?: unknown };
	} catch {
		reply = {};
	}
	socket.end();
	// git reads the answer to a prompt from stdout; an editor answers by exit code.
	if (reply.ok === true && kind === 'prompt') process.stdout.write(`${typeof reply.value === 'string' ? reply.value : ''}\n`);
	process.exit(reply.ok === true ? 0 : 1);
});
// The extension went away (window closed, extension restarted): cancel.
socket.on('error', () => process.exit(1));
socket.on('close', () => {
	if (!answered) process.exit(1);
});
