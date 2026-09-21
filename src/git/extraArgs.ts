/**
 * Extra `git log` arguments supplied by the user (#591), from settings or typed
 * into the filter bar.
 *
 * Most arguments are welcome — `--no-merges`, `--since=…`, `^main`,
 * `--simplify-by-decoration`, `--first-parent` and so on — but some would
 * break the graph or do something no view should do. Those are rejected with
 * a reason rather than silently dropped, so the user knows why.
 *
 * Pure (no Node, no DOM): the webview validates as the user types, and the
 * host validates again before running anything.
 */

interface Rule {
	readonly matches: (arg: string) => boolean;
	readonly reason: string;
}

const option = (...names: string[]) => (arg: string) => names.some((name) => arg === name || arg.startsWith(`${name}=`));

const RULES: readonly Rule[] = [
	{
		matches: option('--format', '--pretty', '--oneline', '-z', '--null', '--graph', '--show-signature', '--raw', '--summary'),
		reason: 'changes the output format the graph is parsed from'
	},
	{
		matches: (arg) =>
			option('--stat', '--shortstat', '--numstat', '--dirstat', '--name-only', '--name-status', '--patch', '--patch-with-stat', '--patch-with-raw', '--compact-summary')(arg) ||
			arg === '-p' || arg === '-u' || /^-U\d*$/.test(arg),
		reason: 'adds diff output to the log; use the commit details for changes'
	},
	{
		matches: (arg) => option('--max-count')(arg) || /^-n\d*$/.test(arg) || /^-\d+$/.test(arg),
		reason: 'the number of commits is controlled by the view (Load More)'
	},
	{ matches: option('--reverse'), reason: 'the graph must list children before their parents' },
	{ matches: (arg) => arg === '-g' || option('--walk-reflogs')(arg), reason: 'reflog walks list commits more than once' },
	{ matches: option('--output'), reason: 'writes to a file' },
	{ matches: option('--ext-diff', '--textconv'), reason: 'runs external programs' },
	{ matches: option('--color', '--colour'), reason: 'adds colour codes to the output' },
	{ matches: (arg) => arg === '--', reason: 'paths are set with the Path filter' }
];

/** The reason an argument is not allowed, or null when it is fine. */
export function rejectArg(arg: string): string | null {
	for (const rule of RULES) if (rule.matches(arg)) return rule.reason;
	return null;
}

/** A readable error for the first rejected argument, or null when all are allowed. */
export function validateArgs(args: readonly string[]): string | null {
	for (const arg of args) {
		const reason = rejectArg(arg);
		if (reason !== null) return `"${arg}" is not allowed: it ${reason}.`;
	}
	return null;
}

/**
 * Splits a command line into arguments the way a POSIX shell would for
 * quoting: whitespace separates, '…' is literal, "…" allows \" and \\, and a
 * backslash outside quotes escapes the next character. Nothing is expanded:
 * there is no shell, and `$(…)` stays text.
 *
 * Throws on an unterminated quote, which would otherwise swallow the rest of
 * the line silently.
 */
export function splitArgs(line: string): string[] {
	const args: string[] = [];
	let current = '';
	let inArg = false;
	let quote: '"' | "'" | null = null;

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			else current += ch;
		} else if (quote === '"') {
			if (ch === '"') quote = null;
			else if (ch === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) current += line[++i];
			else current += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			inArg = true;
		} else if (ch === '\\' && i + 1 < line.length) {
			current += line[++i];
			inArg = true;
		} else if (/\s/.test(ch)) {
			if (inArg) args.push(current);
			current = '';
			inArg = false;
		} else {
			current += ch;
			inArg = true;
		}
	}
	if (quote !== null) throw new Error(`Unterminated ${quote === '"' ? 'double' : 'single'} quote.`);
	if (inArg) args.push(current);
	return args;
}

/** The inverse of `splitArgs`, for showing stored arguments in a text box. */
export function joinArgs(args: readonly string[]): string {
	return args.map((arg) => (arg !== '' && /^[\w@%+=:,./^~-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' ');
}
