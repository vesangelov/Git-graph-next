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

/**
 * Opens the diff of one file change. Commits compare `base` with the commit;
 * the Uncommitted Changes row compares HEAD with the working tree file itself,
 * so the right side is the real, editable document.
 */
export async function openChangeDiff(target: ChangeTarget, change: FileChange): Promise<void> {
	const oldPath = change.oldPath ?? change.path;
	const isAdded = change.type === FileChangeType.Added || change.type === FileChangeType.Untracked;
	const isDeleted = change.type === FileChangeType.Deleted;

	const left = revisionUri(target.repo, isAdded || target.base === null ? '' : target.base, oldPath);
	let right: vscode.Uri;
	let rightLabel: string;
	if (target.hash === UNCOMMITTED) {
		right = isDeleted ? revisionUri(target.repo, '', change.path) : vscode.Uri.file(join(target.repo, change.path));
		rightLabel = 'Working Tree';
	} else {
		right = revisionUri(target.repo, isDeleted ? '' : target.hash, change.path);
		rightLabel = short(target.hash);
	}

	const leftLabel = target.base === null ? 'Empty' : short(target.base);
	const name = change.oldPath !== null ? `${basename(change.oldPath)} → ${basename(change.path)}` : basename(change.path);
	await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${leftLabel} ↔ ${rightLabel})`, { preview: true });
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
