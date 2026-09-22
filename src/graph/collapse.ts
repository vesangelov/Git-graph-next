import { isUncommittedRow, type Commit, type Hash } from '../types.ts';

/** Shorter runs are left alone: folding two rows into one saves nothing. */
export const MIN_RUN = 3;

export interface CollapsedView {
	/** Rows to display: commits, and one stand-in row per collapsed run. */
	readonly commits: Commit[];
	/**
	 * Collapsed runs by the stand-in row's hash, which is the run's first
	 * (newest) commit — so its children still point at it, and the graph needs
	 * no rewriting. Each value lists the run's commits, newest first.
	 */
	readonly runs: Map<Hash, readonly Commit[]>;
}

/**
 * Folds runs of plain linear history into single rows (#387), leaving the
 * shape of the graph — tips, branch points, merges, labelled commits — in view.
 *
 * A commit may be folded when it has exactly one parent and exactly one child
 * among the loaded commits, is not a synthetic row, and is not in `keep`
 * (labelled commits, HEAD, search matches, the selection). A run is a sequence
 * of such commits on adjacent rows, each the first parent of the row before.
 * Runs listed in `expanded` (by their first hash) are shown in full.
 */
export function collapseRuns(commits: readonly Commit[], keep: ReadonlySet<Hash>, expanded: ReadonlySet<Hash>, minRun = MIN_RUN): CollapsedView {
	const children = new Map<Hash, number>();
	for (const commit of commits) {
		for (const parent of commit.parents) children.set(parent, (children.get(parent) ?? 0) + 1);
	}
	const foldable = (commit: Commit) =>
		!isUncommittedRow(commit.hash) &&
		commit.stash === null &&
		commit.parents.length === 1 &&
		children.get(commit.hash) === 1 &&
		!keep.has(commit.hash);

	const rows: Commit[] = [];
	const runs = new Map<Hash, readonly Commit[]>();
	let i = 0;
	while (i < commits.length) {
		if (!foldable(commits[i])) {
			rows.push(commits[i++]);
			continue;
		}
		let end = i;
		while (end + 1 < commits.length && foldable(commits[end + 1]) && commits[end].parents[0] === commits[end + 1].hash) end++;

		const run = commits.slice(i, end + 1);
		if (run.length < minRun || expanded.has(run[0].hash)) {
			rows.push(...run);
		} else {
			const first = run[0];
			const last = run[run.length - 1];
			runs.set(first.hash, run);
			rows.push({ ...first, parents: last.parents, subject: `${run.length} commits`, body: '' });
		}
		i = end + 1;
	}
	return { commits: rows, runs };
}

/** The run (by its first hash) that folds away `hash`, or null when it is visible. */
export function runContaining(runs: ReadonlyMap<Hash, readonly Commit[]>, hash: Hash): Hash | null {
	for (const [first, run] of runs) {
		if (run.some((commit) => commit.hash === hash)) return first;
	}
	return null;
}
