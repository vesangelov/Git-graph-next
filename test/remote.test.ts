import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { avatarUrl } from '../src/view/avatarUrl.ts';
import { URL_RULE, commitWebUrl, linkify, parseRemoteUrl, resolveIssueLinks } from '../src/git/remote.ts';

test('parses the remote URL forms git accepts', () => {
	const expected = { host: 'github.com', owner: 'me', repo: 'proj', webUrl: 'https://github.com/me/proj' };
	assert.deepEqual(parseRemoteUrl('https://github.com/me/proj.git'), expected);
	assert.deepEqual(parseRemoteUrl('https://user:token@github.com/me/proj'), expected, 'credentials never reach the link');
	assert.deepEqual(parseRemoteUrl('git@github.com:me/proj.git'), expected);
	assert.deepEqual(parseRemoteUrl('ssh://git@github.com:22/me/proj.git\n'), expected);
	assert.deepEqual(parseRemoteUrl('git@gitlab.example.org:group/sub/proj.git'), {
		host: 'gitlab.example.org', owner: 'group/sub', repo: 'proj', webUrl: 'https://gitlab.example.org/group/sub/proj'
	});
	assert.equal(parseRemoteUrl('/srv/git/proj.git'), null);
	assert.equal(parseRemoteUrl('file:///srv/git/proj.git'), null);
	assert.equal(parseRemoteUrl('https://github.com/onlyowner'), null);
});

test('detects GitHub and GitLab issue links, and fills variables into configured rules', () => {
	const github = parseRemoteUrl('git@github.com:me/proj.git');
	assert.deepEqual(resolveIssueLinks([], true, github).slice(0, -1), [{ pattern: '#(\\d+)\\b', url: 'https://github.com/me/proj/issues/$1' }]);
	assert.deepEqual(resolveIssueLinks([], false, github), [URL_RULE], 'plain web addresses are always linked');

	const gitlab = parseRemoteUrl('https://gitlab.com/g/p');
	assert.deepEqual(resolveIssueLinks([], true, gitlab).slice(0, -1).map((r) => r.url), ['https://gitlab.com/g/p/-/issues/$1', 'https://gitlab.com/g/p/-/merge_requests/$1']);

	const jira = { pattern: '([A-Z]+-\\d+)', url: 'https://jira.example.com/browse/$1' };
	const perRepo = { pattern: 'PR (\\d+)', url: 'https://${host}/${owner}/${repo}/pull/$1' };
	assert.deepEqual(resolveIssueLinks([jira, perRepo], false, github).slice(0, -1).map((r) => r.url), [
		'https://jira.example.com/browse/$1',
		'https://github.com/me/proj/pull/$1'
	]);
	assert.deepEqual(resolveIssueLinks([jira, perRepo], true, null).slice(0, -1).map((r) => r.url), ['https://jira.example.com/browse/$1'], 'rules needing a remote are dropped without one');
});

test('links matches, earliest first, and never anything but http(s)', () => {
	const rules = [
		{ pattern: '#(\\d+)', url: 'https://x.test/issues/$1' },
		{ pattern: '([A-Z]+-\\d+)', url: 'https://jira.test/$1' },
		{ pattern: 'evil', url: 'command:workbench.action.quit' },
		{ pattern: '(unclosed', url: 'https://bad.test' }
	];
	assert.deepEqual(linkify('Fix #12 and ABC-7, not evil', rules), [
		{ text: 'Fix ' },
		{ text: '#12', url: 'https://x.test/issues/12' },
		{ text: ' and ' },
		{ text: 'ABC-7', url: 'https://jira.test/ABC-7' },
		{ text: ', not evil' }
	]);
	assert.deepEqual(linkify('plain', []), [{ text: 'plain' }]);
	assert.deepEqual(linkify('', rules), [{ text: '' }]);
});

test('links plain web addresses without trailing punctuation, and builds commit pages per host', () => {
	assert.deepEqual(linkify('See https://example.com/a?b=1#c. Done', [URL_RULE]), [
		{ text: 'See ' },
		{ text: 'https://example.com/a?b=1#c', url: 'https://example.com/a?b=1#c' },
		{ text: '. Done' }
	]);
	assert.deepEqual(linkify('(https://x.test/y)', [URL_RULE])[1], { text: 'https://x.test/y', url: 'https://x.test/y' });
	const hash = 'a'.repeat(40);
	assert.equal(commitWebUrl(parseRemoteUrl('git@github.com:me/p.git')!, hash), `https://github.com/me/p/commit/${hash}`);
	assert.equal(commitWebUrl(parseRemoteUrl('https://gitlab.com/g/p')!, hash), `https://gitlab.com/g/p/-/commit/${hash}`);
	assert.equal(commitWebUrl(parseRemoteUrl('git@bitbucket.org:t/p.git')!, hash), `https://bitbucket.org/t/p/commits/${hash}`);
});

test('asks GitHub for no-reply addresses and Gravatar, by hash only, for the rest', () => {
	assert.equal(avatarUrl('12345+Octo-Cat@users.noreply.github.com'), 'https://github.com/octo-cat.png?size=36');
	const hash = createHash('md5').update('someone@example.com').digest('hex');
	assert.equal(avatarUrl(' Someone@Example.COM '), `https://www.gravatar.com/avatar/${hash}?s=36&d=404`, 'normalised before hashing');
	assert.ok(!avatarUrl('someone@example.com').includes('someone'), 'the address itself is never sent');
});
