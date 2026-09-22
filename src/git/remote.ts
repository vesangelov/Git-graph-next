/**
 * Remote URL parsing and issue-link rules (#313). Pure: no Node, no vscode.
 */

export interface RemoteInfo {
	/** e.g. `github.com`, `gitlab.example.org` (no port). */
	readonly host: string;
	/** Owner or group path, e.g. `mhutchie`, `group/subgroup`. */
	readonly owner: string;
	/** Repository name without `.git`. */
	readonly repo: string;
	/** Browser URL of the repository, e.g. `https://github.com/owner/repo`. */
	readonly webUrl: string;
}

/** A link rule as configured: a regular expression, and a URL with `$1`… and `${…}` variables. */
export interface IssueLinkSetting {
	readonly pattern: string;
	readonly url: string;
}

/** A rule ready for the view: `${…}` variables resolved, `$n` left for each match. */
export interface IssueLinkRule {
	readonly pattern: string;
	readonly url: string;
}

/**
 * Parses the URL forms git accepts for a remote: `https://host/owner/repo.git`,
 * `ssh://git@host:22/owner/repo.git` and the scp-like `git@host:owner/repo.git`.
 * Returns null for anything else, such as a local path.
 */
export function parseRemoteUrl(url: string): RemoteInfo | null {
	const trimmed = url.trim();
	let host: string;
	let path: string;

	const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			return null;
		}
		if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(parsed.protocol)) return null;
		host = parsed.hostname;
		path = decodeURIComponent(parsed.pathname);
	} else if (scpLike !== null) {
		host = scpLike[1];
		path = scpLike[2];
	} else {
		return null;
	}

	const parts = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/').filter((p) => p !== '');
	if (host === '' || parts.length < 2) return null;
	const repo = parts[parts.length - 1];
	const owner = parts.slice(0, -1).join('/');
	return { host, owner, repo, webUrl: `https://${host}/${owner}/${repo}` };
}

/** Links git hosts write themselves, so `#123` works with no configuration. */
export function detectedRules(remote: RemoteInfo): IssueLinkSetting[] {
	if (remote.host === 'github.com') {
		// GitHub redirects /issues/N to the pull request when N is one.
		return [{ pattern: '#(\\d+)\\b', url: '${repoUrl}/issues/$1' }];
	}
	if (remote.host.includes('gitlab')) {
		return [
			{ pattern: '#(\\d+)\\b', url: '${repoUrl}/-/issues/$1' },
			{ pattern: '!(\\d+)\\b', url: '${repoUrl}/-/merge_requests/$1' }
		];
	}
	return [];
}

/**
 * The rules for a repository: its detected host rules (when enabled), then
 * the configured ones, with `${host}`, `${owner}`, `${repo}` and `${repoUrl}`
 * filled in from its remote. A rule that needs a remote variable the
 * repository cannot supply is dropped rather than producing broken links.
 */
export function resolveIssueLinks(settings: readonly IssueLinkSetting[], autoDetect: boolean, remote: RemoteInfo | null): IssueLinkRule[] {
	const variables: Record<string, string> | null =
		remote === null ? null : { host: remote.host, owner: remote.owner, repo: remote.repo, repoUrl: remote.webUrl };
	const rules: IssueLinkRule[] = [];
	for (const setting of [...(autoDetect && remote !== null ? detectedRules(remote) : []), ...settings]) {
		if (typeof setting?.pattern !== 'string' || typeof setting.url !== 'string' || setting.pattern === '') continue;
		let missing = false;
		const url = setting.url.replace(/\$\{(\w+)\}/g, (_, name: string) => {
			const value = variables?.[name];
			if (value === undefined) missing = true;
			return value ?? '';
		});
		if (!missing) rules.push({ pattern: setting.pattern, url });
	}
	return rules;
}

export interface TextSegment {
	readonly text: string;
	/** Set for a segment that is a link. */
	readonly url?: string;
}

/**
 * Splits text into plain and linked segments. Where rules overlap, the match
 * that starts first wins (then the longer one). Only http(s) links are made,
 * so a rule can never produce a `command:` or `file:` link.
 */
export function linkify(text: string, rules: readonly IssueLinkRule[]): TextSegment[] {
	const found: { start: number; end: number; url: string }[] = [];
	for (const rule of rules) {
		let regex: RegExp;
		try {
			regex = new RegExp(rule.pattern, 'gu');
		} catch {
			continue; // An invalid pattern in the settings links nothing.
		}
		for (const match of text.matchAll(regex)) {
			if (match[0] === '') continue;
			const url = rule.url.replace(/\$(\d)/g, (_, n: string) => match[Number(n)] ?? '');
			if (!/^https?:\/\//i.test(url)) continue;
			found.push({ start: match.index!, end: match.index! + match[0].length, url });
		}
	}
	found.sort((a, b) => a.start - b.start || b.end - a.end);

	const segments: TextSegment[] = [];
	let cursor = 0;
	for (const link of found) {
		if (link.start < cursor) continue;
		if (link.start > cursor) segments.push({ text: text.slice(cursor, link.start) });
		segments.push({ text: text.slice(link.start, link.end), url: link.url });
		cursor = link.end;
	}
	if (cursor < text.length || segments.length === 0) segments.push({ text: text.slice(cursor) });
	return segments;
}
