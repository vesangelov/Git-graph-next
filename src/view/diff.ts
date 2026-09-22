import * as vscode from 'vscode';
import { basename, join } from 'node:path';
import type { GitExecutor } from '../git/executor.ts';
import { emptySideContent, readBlobAtRevision } from '../git/changes.ts';
import { FileChangeType, UNCOMMITTED, type ChangeTarget, type FileChange } from '../types.ts';

/** URI scheme for read-only file contents at a revision. */
export const REVISION_SCHEME = 'git-graph-next';

interface RevisionQuery {
	readonly repo: string;
	/** Commit to read from; '' stands for "no such file", i.e. an empty side. */
	readonly revision: string;
	readonly path: string;
}

/**
 * A URI for a file at a revision. The path component is the repo-relative
 * path, so the editor tab shows the file name and picks the right language;
 * everything needed to read it travels in the query.
 */
export function revisionUri(repo: string, revision: string, path: string): vscode.Uri {
	const query: RevisionQuery = { repo, revision, path };
	return vscode.Uri.from({ scheme: REVISION_SCHEME, path: `/${path}`, query: JSON.stringify(query) });
}

/** Blobs are immutable, so a few recent reads can be served again without git. */
const BLOB_CACHE_SIZE = 20;

/**
 * Serves `git-graph-next:` URIs as a read-only file system.
 *
 * A file system rather than a text content provider, because VS Code opens
 * notebooks (#598), images and other custom editors only from a file system:
 * with plain text content, a `.ipynb` diff shows raw JSON. It also hands over
 * bytes, so nothing is lost to a text decoding.
 */
export class RevisionFileSystem implements vscode.FileSystemProvider {
	private readonly cache = new Map<string, Uint8Array>();
	private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	/** Never fires: a file at a revision cannot change. */
	readonly onDidChangeFile = this.changed.event;

	constructor(private readonly git: GitExecutor) {}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const content = await this.readFile(uri);
		return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: content.byteLength, permissions: vscode.FilePermission.Readonly };
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const cached = this.cache.get(uri.toString());
		if (cached !== undefined) return cached;

		let query: RevisionQuery;
		try {
			query = JSON.parse(uri.query) as RevisionQuery;
		} catch {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		const blob = query.revision === '' ? null : await readBlobAtRevision(this.git, query.repo, query.revision, query.path);
		// A side that does not exist is shown empty, as the other half of an add or delete.
		const content = blob ?? Buffer.from(emptySideContent(query.path), 'utf8');

		this.cache.set(uri.toString(), content);
		if (this.cache.size > BLOB_CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
		return content;
	}

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}

	readDirectory(): never {
		throw vscode.FileSystemError.NoPermissions('Revisions are read-only');
	}
	createDirectory(): never {
		throw vscode.FileSystemError.NoPermissions('Revisions are read-only');
	}
	writeFile(): never {
		throw vscode.FileSystemError.NoPermissions('Revisions are read-only');
	}
	delete(): never {
		throw vscode.FileSystemError.NoPermissions('Revisions are read-only');
	}
	rename(): never {
		throw vscode.FileSystemError.NoPermissions('Revisions are read-only');
	}
}

const short = (hash: string) => hash.slice(0, 8);

/** The two sides of one file change, and a title naming both. */
export interface ChangeSides {
	/** Before the change; null when the file was added. */
	readonly left: vscode.Uri | null;
	/** After the change; null when the file was deleted. */
	readonly right: vscode.Uri | null;
	readonly title: string;
}

/**
 * The URIs a file change compares. Commits compare `base` with the commit;
 * the Uncommitted Changes row compares with the working tree file itself, so
 * the right side is the real, editable document.
 */
export function changeSides(target: ChangeTarget, change: FileChange): ChangeSides {
	const oldPath = change.oldPath ?? change.path;
	const isAdded = change.type === FileChangeType.Added || change.type === FileChangeType.Untracked;
	const isDeleted = change.type === FileChangeType.Deleted;

	const left = isAdded || target.base === null ? null : revisionUri(target.repo, target.base, oldPath);
	let right: vscode.Uri | null = null;
	let rightLabel: string;
	if (target.hash === UNCOMMITTED) {
		if (!isDeleted) right = vscode.Uri.file(join(target.repo, change.path));
		rightLabel = 'Working Tree';
	} else {
		if (!isDeleted) right = revisionUri(target.repo, target.hash, change.path);
		rightLabel = short(target.hash);
	}
	const leftLabel = target.base === null ? 'Empty' : short(target.base);
	const name = change.oldPath !== null ? `${basename(change.oldPath)} → ${basename(change.path)}` : basename(change.path);
	return { left, right, title: `${name} (${leftLabel} ↔ ${rightLabel})` };
}

/** Opens the diff of one file change. */
export async function openChangeDiff(target: ChangeTarget, change: FileChange): Promise<void> {
	const { left, right, title } = changeSides(target, change);
	// `vscode.diff` needs both sides: an absent one is shown empty.
	const empty = (path: string) => revisionUri(target.repo, '', path);
	await vscode.commands.executeCommand('vscode.diff', left ?? empty(change.oldPath ?? change.path), right ?? empty(change.path), title, { preview: true });
}

/** True when this VS Code has the multi-file changes editor (1.86+). */
async function hasChangesEditor(): Promise<boolean> {
	return (await vscode.commands.getCommands(true)).includes('vscode.changes');
}

/**
 * Opens every changed file in one scrolling editor (#807, #841, #916), the
 * quickest way to read a whole commit or comparison. Falls back to the first
 * file's diff on VS Code builds without the changes editor.
 */
export async function openAllChanges(target: ChangeTarget, changes: readonly FileChange[], title: string): Promise<void> {
	if (changes.length === 0) return;
	if (!(await hasChangesEditor())) {
		void vscode.window.showInformationMessage('This version of VS Code cannot show all changes in one editor; opening the first file.');
		await openChangeDiff(target, changes[0]);
		return;
	}
	const resources = changes.map((change) => {
		const { left, right } = changeSides(target, change);
		// The label URI names the entry; it is the file as it is after the change.
		const label = right ?? left ?? vscode.Uri.file(join(target.repo, change.path));
		return [label, left, right] as const;
	});
	await vscode.commands.executeCommand('vscode.changes', title, resources);
}

/** Opens a file as it was at a revision, read-only. */
export async function openFileAtRevision(repo: string, hash: string, path: string): Promise<void> {
	await vscode.window.showTextDocument(revisionUri(repo, hash, path), { preview: true });
}

/** Compares a file at a revision with its working tree version (editable). */
export async function compareWithWorkingFile(repo: string, hash: string, path: string): Promise<void> {
	const working = vscode.Uri.file(join(repo, path));
	try {
		await vscode.workspace.fs.stat(working);
	} catch {
		void vscode.window.showWarningMessage(`"${path}" does not exist in the working tree.`);
		return;
	}
	await vscode.commands.executeCommand('vscode.diff', revisionUri(repo, hash, path), working, `${basename(path)} (${short(hash)} ↔ Working Tree)`, { preview: true });
}

/** Opens the working tree version of a file, if it still exists. */
export async function openWorkingFile(repo: string, path: string): Promise<void> {
	const uri = vscode.Uri.file(join(repo, path));
	try {
		await vscode.workspace.fs.stat(uri);
	} catch {
		void vscode.window.showWarningMessage(`"${path}" does not exist in the working tree.`);
		return;
	}
	await vscode.window.showTextDocument(uri, { preview: true });
}
