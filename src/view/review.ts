import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { GitExecutor } from '../git/executor.ts';
import type { ChangeTarget, FileChange } from '../types.ts';
import type { ChangesService } from './changesView.ts';
import { openAllChanges, openChangeDiff } from './diff.ts';
import type { ReviewSummary } from './protocol.ts';

const STORE_KEY = 'gitGraphNext.codeReviews';
const ACTIVE_CONTEXT = 'gitGraphNext.reviewActive';

/** A code review in progress: what is compared, and which files have been looked at. */
export interface ReviewSession {
	readonly id: string;
	readonly target: ChangeTarget;
	readonly title: string;
	/** The files to review, as they were when the review started. */
	readonly files: readonly FileChange[];
	readonly reviewed: readonly string[];
	/** The file opened last, where Next and Previous count from. */
	readonly current: string | null;
	readonly started: number;
}

const sameTarget = (a: ChangeTarget, b: ChangeTarget) => a.repo === b.repo && a.hash === b.hash && a.base === b.base;

/**
 * Code review mode: go through a commit, a comparison, or a branch against
 * another, file by file. Opening a file marks it reviewed; Next / Previous
 * (Alt+] / Alt+[, usable from the diff editor itself) move between the files
 * not yet reviewed. Reviews are kept per workspace, so one can be resumed
 * after a restart.
 */
export class ReviewManager implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	private sessions: ReviewSession[];
	private activeId: string | null = null;
	private readonly status: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly state: vscode.Memento,
		private readonly git: GitExecutor,
		private readonly changes: ChangesService
	) {
		const stored = state.get<unknown>(STORE_KEY);
		this.sessions = Array.isArray(stored) ? (stored as ReviewSession[]).filter((s) => typeof s?.id === 'string' && Array.isArray(s.files)) : [];
		this.status = vscode.window.createStatusBarItem('gitGraphNext.review', vscode.StatusBarAlignment.Left, 998);
		this.status.name = 'Git Graph Next Code Review';
		this.status.command = 'gitGraphNext.review.next';
		this.disposables.push(this.status, this.changed);
		this.update();
	}

	get active(): ReviewSession | null {
		return this.sessions.find((s) => s.id === this.activeId) ?? null;
	}

	/** The active review, for the views. */
	summary(): ReviewSummary | null {
		const session = this.active;
		if (session === null) return null;
		const { repo, hash, base } = session.target;
		return { repo, hash, base, title: session.title, total: session.files.length, reviewed: session.reviewed, current: session.current };
	}

	/** Paths already reviewed when `target` is the active review's, else null. */
	reviewedFor(target: ChangeTarget): ReadonlySet<string> | null {
		const session = this.active;
		return session !== null && sameTarget(session.target, target) ? new Set(session.reviewed) : null;
	}

	/**
	 * Starts reviewing a commit or comparison, or resumes the existing review
	 * of the same thing, and opens its first file not yet reviewed.
	 */
	async start(target: ChangeTarget, title: string): Promise<string | null> {
		const existing = this.sessions.find((s) => sameTarget(s.target, target));
		if (existing !== undefined) {
			this.activeId = existing.id;
		} else {
			const files = await this.changes.load(target);
			if (files.length === 0) return 'There are no changed files to review.';
			const session: ReviewSession = { id: randomBytes(6).toString('hex'), target, title, files, reviewed: [], current: null, started: Date.now() };
			this.sessions = [...this.sessions, session];
			this.activeId = session.id;
		}
		await this.persist();
		await this.next();
		return null;
	}

	/**
	 * Reviews a branch as a pull request would show it: everything since it
	 * forked from `against` (the merge base), not the difference between tips.
	 */
	async startBranch(repo: string, branch: string, against: string): Promise<string | null> {
		const tip = (await this.git.runOrNull(repo, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]))?.trim();
		if (tip === undefined || tip === '') return `${branch} does not exist.`;
		const base = (await this.git.runOrNull(repo, ['merge-base', against, tip]))?.trim();
		if (base === undefined || base === '') return `${branch} and ${against} have no common history.`;
		if (base === tip) return `${branch} has no commits that are not already in ${against}.`;
		return this.start({ repo, hash: tip, base }, `${branch} against ${against}`);
	}

	/** Opens the next file not yet reviewed, after the current one. */
	async next(): Promise<void> {
		await this.step(1);
	}

	async previous(): Promise<void> {
		await this.step(-1);
	}

	/** Opens one file of the active review and marks it reviewed. */
	async open(path: string): Promise<void> {
		const session = this.active;
		const change = session?.files.find((f) => f.path === path);
		if (session === null || change === undefined) return;
		await openChangeDiff(session.target, change);
		await this.markOpened(session.target, path);
	}

	/** Called whenever a diff is opened anywhere: it counts towards the review of that target. */
	async markOpened(target: ChangeTarget, path: string): Promise<void> {
		const session = this.active;
		if (session === null || !sameTarget(session.target, target) || !session.files.some((f) => f.path === path)) return;
		const reviewed = session.reviewed.includes(path) ? session.reviewed : [...session.reviewed, path];
		this.replace({ ...session, reviewed, current: path });
		await this.persist();
	}

	/** Marks a file reviewed, or not reviewed again. */
	async toggle(path: string): Promise<void> {
		const session = this.active;
		if (session === null) return;
		const reviewed = session.reviewed.includes(path) ? session.reviewed.filter((p) => p !== path) : [...session.reviewed, path];
		this.replace({ ...session, reviewed });
		await this.persist();
	}

	/** Every file of the active review in one scrolling editor. */
	async openAll(): Promise<void> {
		const session = this.active;
		if (session !== null) await openAllChanges(session.target, session.files, `Review: ${session.title}`);
	}

	async end(): Promise<void> {
		const session = this.active;
		if (session === null) return;
		this.sessions = this.sessions.filter((s) => s.id !== session.id);
		this.activeId = null;
		await this.persist();
	}

	async endAll(): Promise<void> {
		this.sessions = [];
		this.activeId = null;
		await this.persist();
	}

	/** Lets the user pick a saved review to continue. */
	async resume(): Promise<void> {
		if (this.sessions.length === 0) {
			void vscode.window.showInformationMessage('There are no code reviews in this workspace.');
			return;
		}
		const picked = await vscode.window.showQuickPick(
			this.sessions.map((s) => ({
				label: s.title,
				description: `${s.reviewed.length} of ${s.files.length} files reviewed`,
				detail: `Started ${new Date(s.started).toLocaleString()}`,
				session: s
			})),
			{ placeHolder: 'Code review to resume' }
		);
		if (picked === undefined) return;
		this.activeId = picked.session.id;
		await this.persist();
		await this.next();
	}

	dispose(): void {
		void vscode.commands.executeCommand('setContext', ACTIVE_CONTEXT, false);
		for (const disposable of this.disposables) disposable.dispose();
	}

	private async step(direction: 1 | -1): Promise<void> {
		const session = this.active;
		if (session === null) return;
		const files = session.files;
		const from = session.current === null ? (direction === 1 ? -1 : files.length) : files.findIndex((f) => f.path === session.current);
		const reviewed = new Set(session.reviewed);
		for (let i = 1; i <= files.length; i++) {
			const candidate = files[(from + direction * i + files.length * 2) % files.length];
			if (!reviewed.has(candidate.path)) {
				await this.open(candidate.path);
				return;
			}
		}
		const choice = await vscode.window.showInformationMessage(`All ${files.length} files of "${session.title}" are reviewed.`, 'End Review', 'Keep Open');
		if (choice === 'End Review') await this.end();
	}

	private replace(session: ReviewSession): void {
		this.sessions = this.sessions.map((s) => (s.id === session.id ? session : s));
	}

	private async persist(): Promise<void> {
		await this.state.update(STORE_KEY, this.sessions);
		this.update();
		this.changed.fire();
	}

	private update(): void {
		const session = this.active;
		void vscode.commands.executeCommand('setContext', ACTIVE_CONTEXT, session !== null);
		if (session === null) {
			this.status.hide();
			return;
		}
		this.status.text = `$(checklist) ${session.reviewed.length}/${session.files.length} reviewed · Next $(arrow-right)`;
		this.status.tooltip = `Code review: ${session.title}\nNext file not yet reviewed (Alt+])`;
		this.status.show();
	}
}
