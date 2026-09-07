import { validateHttpsUrl } from '../utils/validate-url.js';

// Fetches the code changes behind a Jira ticket so impact analysis can be grounded
// in files that actually changed, rather than inferred from ticket prose alone.
//
// This module never prints. Everything a caller should surface comes back in
// `warnings[]` — src/commands/analyze.js and mcp/src/tools/get-diff-context.js
// decide what to show, matching how jira.js/confluence.js/csv.js stay console-free
// and leave output to the command handlers.

export const GITHUB_DEFAULTS = Object.freeze({
  apiBaseUrl: 'https://api.github.com',
  // Separate from apiBaseUrl by necessity: the API host (api.github.com, or
  // ghe.corp/api/v3) is never the host that appears in the PR URLs Jira's
  // dev-status panel returns (github.com, ghe.corp). There is no general
  // derivation between the two, so the host check needs its own setting.
  htmlBaseUrl: 'https://github.com',
  tokenEnv: 'GITHUB_TOKEN',
  allowedRepos: [],
  maxRefs: 5,
  maxFiles: 50,
  maxPatchChars: 4000,
  maxDiffChars: 60000,
});

// Patch bodies for these are dropped; the file still appears with its line counts.
// Matched by a small hand-rolled matcher (see isPatchDenied) rather than a glob
// library — the project has no glob dependency and does not need one.
export const DEFAULT_PATCH_DENY_LIST = Object.freeze([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.snap',
  'dist/',
  'build/',
  'vendor/',
]);

const TIMEOUT_MS = 10000;

const REF_PATTERN = /^[A-Za-z0-9._/-]{1,255}$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function settings(config) {
  return { ...GITHUB_DEFAULTS, ...(config.github ?? {}) };
}

/* ------------------------------------------------------------------ *
 * Repo allowlist
 * ------------------------------------------------------------------ */

// Parses owner/repo out of a GitHub URL. Used ONLY for matching against the
// allowlist — its output never becomes the host or path of a request. Request
// URLs are always rebuilt from allowlist-validated segments.
export function parseRepoFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const [owner, repo] = segments;
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;

  let type = null;
  let id = null;
  if (segments[2] === 'pull' && segments[3]) {
    type = 'pr';
    id = segments[3];
  } else if ((segments[2] === 'commit' || segments[2] === 'commits') && segments[3]) {
    type = 'commit';
    id = segments[3];
  }

  return { owner, repo, type, id, host: parsed.host };
}

// Exact, case-insensitive, full-string match on BOTH segments. Deliberately not
// prefix or substring matching: `startsWith` would let `acme-evil/x` through an
// `acme` allowlist. Deliberately case-insensitive: GitHub owner/repo names are,
// so a dev-status URL saying `Acme/Storefront` must match an `acme/storefront`
// config or the whole dev-status tier silently stops working.
export function isRepoAllowed(owner, repo, config) {
  if (!owner || !repo) return false;
  const s = settings(config);
  const candidate = `${owner}/${repo}`.toLowerCase();

  const allowed = [`${s.owner}/${s.repo}`, ...(s.allowedRepos ?? [])];
  return allowed.some(entry => typeof entry === 'string' && entry.toLowerCase() === candidate);
}

// A URL whose host isn't the configured GitHub host is rejected before its
// owner/repo is even considered. Without this, a planted
// https://gitlab.example/acme/storefront/-/merge_requests/1 parses to an
// allowlisted owner/repo and Ripple fetches PR #1 from the real repo — an
// attacker-chosen input steering a real fetch.
function isHostAllowed(host, config) {
  const s = settings(config);
  let expected;
  try {
    expected = new URL(s.htmlBaseUrl).host;
  } catch {
    return false;
  }
  return host.toLowerCase() === expected.toLowerCase();
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function githubToken(config) {
  return process.env[settings(config).tokenEnv]?.trim() || null;
}

function encodeRef(ref) {
  // Branch refs legitimately contain '/', so encode each segment and rejoin
  // rather than encoding the separator away.
  return ref.split('/').map(encodeURIComponent).join('/');
}

async function githubFetch(path, config) {
  const s = settings(config);
  validateHttpsUrl(s.apiBaseUrl, 'GitHub API');

  const token = githubToken(config);
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ripple-qa',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${s.apiBaseUrl.replace(/\/$/, '')}${path}`, {
      headers,
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      const remaining = res.headers?.get?.('x-ratelimit-remaining');
      if (remaining === '0') {
        const retryAfter = res.headers?.get?.('retry-after');
        throw new Error(
          `GitHub rate limit reached${retryAfter ? ` (retry after ${retryAfter}s)` : ''}` +
            `${token ? '' : ' — requests are unauthenticated (60/hour); set GITHUB_TOKEN to raise it'}.`
        );
      }
      throw new Error(
        'GitHub authentication failed or access was denied. Check the token in ' +
          `${s.tokenEnv} — note a token scoped for GitHub Models (models:read) will not grant ` +
          'repository access; use github.tokenEnv to point at a separately-scoped token.'
      );
    }

    if (res.status === 429) {
      throw new Error('GitHub rate limit reached (429).');
    }

    if (res.status === 404) {
      throw new Error('GitHub returned 404 — check the repo, PR/commit reference, and token access.');
    }

    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
    }

    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------------ *
 * Discovery cascade
 * ------------------------------------------------------------------ */

// Exported so the CLI can fail fast on a typo'd --pr/--commit/--compare rather
// than degrading it to a "diff unavailable" warning: bad user input is an error,
// a ref that merely can't be found is not.
export function validateDiffOptions(options) {
  validateExplicitOptions(options);
}

function validateExplicitOptions(options) {
  const { pr, commit, compare } = options ?? {};

  if (pr !== undefined && pr !== null && pr !== '') {
    const n = Number(pr);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`Invalid --pr value "${pr}": must be a positive integer.`);
    }
  }

  if (commit) {
    if (!SHA_PATTERN.test(commit)) {
      throw new Error(`Invalid --commit value "${commit}": must be a 7-40 character hex SHA.`);
    }
  }

  const supplied = [pr, commit, compare].filter(v => v !== undefined && v !== null && v !== '');
  if (supplied.length > 1) {
    throw new Error(
      'Pass only one of --pr, --commit or --compare — combining them would merge unrelated ' +
        'changes into a single Code Changes section.'
    );
  }

  if (compare) {
    const parts = String(compare).split('...');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid --compare value "${compare}": expected the form base...head.`);
    }
    for (const ref of parts) {
      if (
        !REF_PATTERN.test(ref) ||
        ref.includes('..') ||
        ref.includes('%') ||
        ref.startsWith('/') ||
        ref.endsWith('/')
      ) {
        throw new Error(`Invalid --compare ref "${ref}": disallowed characters or path segments.`);
      }
    }
  }
}

function explicitRefs(config, options) {
  const s = settings(config);
  const refs = [];

  if (options?.pr) {
    refs.push({ type: 'pr', owner: s.owner, repo: s.repo, id: String(Number(options.pr)) });
  }
  if (options?.commit) {
    refs.push({ type: 'commit', owner: s.owner, repo: s.repo, id: options.commit });
  }
  if (options?.compare) {
    const [base, head] = String(options.compare).split('...');
    refs.push({ type: 'compare', owner: s.owner, repo: s.repo, id: `${base}...${head}`, base, head });
  }

  return refs;
}

// Jira's Development panel. Populated from ticket content and app integrations,
// so anyone who can create or edit a ticket can influence what lands here —
// every ref it yields goes through the host check and the repo allowlist before
// any fetch is issued.
async function devStatusRefs(ticket, config, warnings) {
  if (!ticket?.id) {
    warnings.push('Jira dev-status skipped: ticket has no numeric id.');
    return [];
  }
  if (!/^\d+$/.test(String(ticket.id))) {
    warnings.push('Jira dev-status skipped: ticket id is not numeric.');
    return [];
  }

  validateHttpsUrl(config.jira.url, 'Jira');
  const url =
    `${config.jira.url}/rest/dev-status/1.0/issue/detail` +
    `?issueId=${encodeURIComponent(ticket.id)}&applicationType=GitHub&dataType=pullrequest`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let data;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(`${config.jira.email}:${process.env.JIRA_API_TOKEN}`).toString('base64'),
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      warnings.push(
        `Jira dev-status unavailable (${res.status}) — the GitHub for Jira app may not be installed.`
      );
      return [];
    }
    data = await res.json();
  } catch {
    warnings.push('Jira dev-status lookup failed — continuing with other discovery methods.');
    return [];
  } finally {
    clearTimeout(timeout);
  }

  const pullRequests = (data?.detail ?? []).flatMap(d => d.pullRequests ?? []);
  if (pullRequests.length === 0) return [];

  const refs = [];
  for (const pr of pullRequests) {
    const parsed = parseRepoFromUrl(pr.url ?? '');
    if (!parsed) {
      warnings.push(`Dev-status entry has an unparseable URL — ignored.`);
      continue;
    }
    if (!isHostAllowed(parsed.host, config)) {
      warnings.push(`Dev-status PR at ${parsed.host} is not the configured GitHub host — ignored.`);
      continue;
    }
    if (!isRepoAllowed(parsed.owner, parsed.repo, config)) {
      warnings.push(`Dev-status PR ${pr.url} is outside the configured repo — ignored.`);
      continue;
    }
    const number = parsed.id ?? String(pr.id ?? '').replace('#', '');
    if (!/^\d+$/.test(number)) continue;

    refs.push({
      type: 'pr',
      owner: parsed.owner,
      repo: parsed.repo,
      id: number,
      title: pr.name ?? '',
      state: pr.status ?? '',
    });
  }

  return refs;
}

async function searchRefs(ticketKey, config, warnings) {
  const s = settings(config);
  if (!s.owner || !s.repo) return [];

  const repoQualifier = `repo:${s.owner}/${s.repo}`;
  const refs = [];

  // Scoped to title/body so a PR that merely mentions the key in a comment
  // doesn't get picked up.
  try {
    const q = `"${ticketKey}" in:title,body ${repoQualifier} is:pr`;
    const data = await githubFetch(`/search/issues?q=${encodeURIComponent(q)}&per_page=10`, config);
    const items = data?.items ?? [];
    // Prefer merged PRs — they represent the change that actually landed.
    const sorted = [...items].sort((a, b) => Number(Boolean(b.pull_request?.merged_at)) - Number(Boolean(a.pull_request?.merged_at)));
    for (const item of sorted) {
      // repository_url is the API field; html_url is presentation. Same
      // "compare, never interpolate" reasoning as the allowlist itself.
      const repoPath = String(item.repository_url ?? '').split('/repos/')[1] ?? '';
      const [owner, repo] = repoPath.split('/');
      if (!isRepoAllowed(owner, repo, config)) {
        warnings.push(`Search result ${item.html_url ?? ''} is outside the configured repo — ignored.`);
        continue;
      }
      refs.push({
        type: 'pr',
        owner,
        repo,
        id: String(item.number),
        title: item.title ?? '',
        state: item.pull_request?.merged_at ? 'merged' : item.state ?? '',
      });
    }
  } catch (err) {
    warnings.push(`GitHub PR search failed: ${err.message}`);
  }

  if (refs.length > 0) return refs;

  try {
    const q = `"${ticketKey}" ${repoQualifier}`;
    const data = await githubFetch(`/search/commits?q=${encodeURIComponent(q)}&per_page=10`, config);
    for (const item of data?.items ?? []) {
      const owner = item.repository?.owner?.login;
      const repo = item.repository?.name;
      if (!isRepoAllowed(owner, repo, config)) {
        warnings.push('Commit search result is outside the configured repo — ignored.');
        continue;
      }
      // Every other tier validates ref shape before use (SHA_PATTERN on
       // explicit --commit, /^\d+$/ on dev-status PR numbers). Search results
       // are no more trusted than those, so they get the same check.
      if (!SHA_PATTERN.test(String(item.sha ?? ''))) {
        warnings.push('Commit search returned a malformed SHA — ignored.');
        continue;
      }
      refs.push({
        type: 'commit',
        owner,
        repo,
        id: item.sha,
        title: (item.commit?.message ?? '').split('\n')[0],
        state: '',
      });
    }
  } catch (err) {
    warnings.push(`GitHub commit search failed: ${err.message}`);
  }

  return refs;
}

export async function resolveChangeRefs(ticket, config, options = {}) {
  const s = settings(config);
  const warnings = [];

  validateExplicitOptions(options);

  const explicit = explicitRefs(config, options);
  if (explicit.length > 0) {
    return { refs: explicit.slice(0, s.maxRefs), source: 'explicit', warnings };
  }

  const fromDevStatus = await devStatusRefs(ticket, config, warnings);
  if (fromDevStatus.length > 0) {
    if (fromDevStatus.length > s.maxRefs) {
      warnings.push(`Found ${fromDevStatus.length} linked PRs; using the first ${s.maxRefs}.`);
    }
    return { refs: fromDevStatus.slice(0, s.maxRefs), source: 'jira-dev-status', warnings };
  }

  const fromSearch = await searchRefs(ticket.key, config, warnings);
  if (fromSearch.length > 0) {
    if (fromSearch.length > s.maxRefs) {
      warnings.push(`Search matched ${fromSearch.length} refs; using the first ${s.maxRefs}.`);
    }
    return { refs: fromSearch.slice(0, s.maxRefs), source: 'github-search', warnings };
  }

  warnings.push(`No GitHub PR or commit found for ${ticket.key}.`);
  return { refs: [], source: 'none', warnings };
}

/* ------------------------------------------------------------------ *
 * Diff fetching and capping
 * ------------------------------------------------------------------ */

export function isPatchDenied(path, denyList = DEFAULT_PATCH_DENY_LIST) {
  const lower = String(path).toLowerCase();
  const basename = lower.split('/').pop();

  return denyList.some(rawPattern => {
    const pattern = String(rawPattern).toLowerCase();
    if (pattern.endsWith('/')) return lower.startsWith(pattern) || lower.includes(`/${pattern}`);
    if (pattern.startsWith('*.')) return basename.endsWith(pattern.slice(1));
    return basename === pattern;
  });
}

async function fetchRefPayload(ref, config) {
  const owner = encodeURIComponent(ref.owner);
  const repo = encodeURIComponent(ref.repo);

  if (ref.type === 'pr') {
    const pr = await githubFetch(`/repos/${owner}/${repo}/pulls/${encodeURIComponent(ref.id)}`, config);
    // per_page=100 with maxFiles<=50 means page 1 always suffices; there is
    // deliberately no pagination. filesChanged therefore comes from the PR
    // object's changed_files, never files.length, which is already truncated
    // by the page size and would make omittedFiles wrong.
    const files = await githubFetch(
      `/repos/${owner}/${repo}/pulls/${encodeURIComponent(ref.id)}/files?per_page=100`,
      config
    );
    return {
      meta: {
        type: 'pr',
        id: `#${ref.id}`,
        url: pr.html_url,
        title: pr.title ?? ref.title ?? '',
        state: pr.merged_at ? 'merged' : pr.state ?? '',
        author: pr.user?.login ?? '',
        mergedAt: pr.merged_at ?? null,
        body: pr.body ?? '',
      },
      files: files ?? [],
      declaredFilesChanged: pr.changed_files,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
    };
  }

  if (ref.type === 'commit') {
    const commit = await githubFetch(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref.id)}`, config);
    return {
      meta: {
        type: 'commit',
        id: String(commit.sha ?? ref.id).slice(0, 12),
        url: commit.html_url,
        title: (commit.commit?.message ?? '').split('\n')[0],
        state: '',
        author: commit.author?.login ?? commit.commit?.author?.name ?? '',
        mergedAt: commit.commit?.author?.date ?? null,
        body: commit.commit?.message ?? '',
      },
      files: commit.files ?? [],
      declaredFilesChanged: undefined,
      additions: commit.stats?.additions ?? 0,
      deletions: commit.stats?.deletions ?? 0,
    };
  }

  const base = encodeRef(ref.base);
  const head = encodeRef(ref.head);
  const cmp = await githubFetch(`/repos/${owner}/${repo}/compare/${base}...${head}`, config);
  return {
    meta: {
      type: 'compare',
      id: `${ref.base}...${ref.head}`,
      url: cmp.html_url,
      title: `${cmp.total_commits ?? 0} commit(s) between ${ref.base} and ${ref.head}`,
      state: cmp.status ?? '',
      author: '',
      mergedAt: null,
      body: '',
    },
    files: cmp.files ?? [],
    declaredFilesChanged: undefined,
    additions: (cmp.files ?? []).reduce((sum, f) => sum + (f.additions ?? 0), 0),
    deletions: (cmp.files ?? []).reduce((sum, f) => sum + (f.deletions ?? 0), 0),
  };
}

export async function fetchDiffContext(ticket, config, options = {}) {
  const s = settings(config);
  const denyList = s.patchDenyList ?? DEFAULT_PATCH_DENY_LIST;

  if (!s.owner || !s.repo) {
    throw new Error(
      'GitHub diff analysis needs github.owner and github.repo in ripple.config.json. ' +
        "Add a github block (see ripple.config.example.json) or re-run 'ripple init'."
    );
  }

  const { refs, source, warnings } = await resolveChangeRefs(ticket, config, options);

  const empty = {
    source: 'none',
    repo: `${s.owner}/${s.repo}`,
    refs: [],
    files: [],
    totals: { filesChanged: 0, additions: 0, deletions: 0, omittedFiles: 0 },
    truncated: false,
    warnings,
    codeChangesFacts: null,
  };

  if (refs.length === 0) return empty;

  const refMetas = [];
  const files = [];
  const bodies = [];
  let filesChanged = 0;
  let additions = 0;
  let deletions = 0;
  let omittedFiles = 0;
  let truncated = false;
  // maxDiffChars is a budget across ALL refs, not per ref.
  let remainingChars = options.diffCharBudget ?? s.maxDiffChars;

  for (const ref of refs) {
    if (!isRepoAllowed(ref.owner, ref.repo, config)) {
      warnings.push(`Ref for ${ref.owner}/${ref.repo} is outside the configured repo — ignored.`);
      continue;
    }

    let payload;
    try {
      payload = await fetchRefPayload(ref, config);
    } catch (err) {
      warnings.push(`Could not fetch ${ref.type} ${ref.id}: ${err.message}`);
      continue;
    }

    refMetas.push({
      type: payload.meta.type,
      id: payload.meta.id,
      // Carried so the reported repo can be derived from what actually
      // resolved rather than assumed to be the primary configured repo.
      owner: ref.owner,
      repo: ref.repo,
      url: payload.meta.url,
      title: payload.meta.title,
      state: payload.meta.state,
      author: payload.meta.author,
      mergedAt: payload.meta.mergedAt,
    });
    if (payload.meta.body) bodies.push(payload.meta.body);

    additions += payload.additions;
    deletions += payload.deletions;
    filesChanged += payload.declaredFilesChanged ?? payload.files.length;

    for (const file of payload.files) {
      if (files.length >= s.maxFiles) {
        omittedFiles += 1;
        truncated = true;
        continue;
      }

      const entry = {
        path: file.filename,
        status: file.status ?? 'modified',
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        patch: '',
        patchOmitted: false,
        truncated: false,
      };

      const patch = file.patch ?? '';
      if (!patch) {
        // GitHub omits `patch` for binary files entirely. Nothing was hidden by
        // a cap, so this is NOT truncation — the file is fully listed with real
        // counts and there simply is no textual diff to show.
        entry.patchOmitted = true;
        entry.patchOmittedReason = 'binary';
      } else if (isPatchDenied(entry.path, denyList)) {
        // Also not truncation: an intentional, complete policy omission. Setting
        // `truncated` here would make the prompt claim the file list is not
        // exhaustive on any PR that merely touches a lockfile — contradicting
        // the "showing N of N files" line in the same sentence.
        entry.patchOmitted = true;
        entry.patchOmittedReason = 'denylist';
      } else if (remainingChars <= 0) {
        // This one IS truncation: the size budget ran out and real diff content
        // is being withheld as a result.
        entry.patchOmitted = true;
        entry.patchOmittedReason = 'budget';
        truncated = true;
      } else {
        const perFileCap = Math.min(s.maxPatchChars, remainingChars);
        if (patch.length > perFileCap) {
          entry.patch = patch.slice(0, perFileCap);
          entry.truncated = true;
          truncated = true;
        } else {
          entry.patch = patch;
        }
        remainingChars -= entry.patch.length;
      }

      files.push(entry);
    }
  }

  // A ref count beyond what actually resolved means every candidate failed.
  if (refMetas.length === 0) {
    return { ...empty, warnings };
  }

  const declaredTotal = filesChanged;
  if (declaredTotal > files.length) {
    omittedFiles = declaredTotal - files.length;
    truncated = true;
  }

  // Derived from the refs that actually resolved, NOT from github.owner/repo.
  // github.allowedRepos exists so a discovered ref can legitimately live in a
  // sibling repo (monorepo split, fork); reporting the primary repo in that case
  // would put a false fact into the one block whose whole purpose is carrying
  // only values Ripple actually fetched.
  const resolvedRepo = [...new Set(refMetas.map(r => `${r.owner}/${r.repo}`))].join(', ');

  return {
    source,
    repo: resolvedRepo,
    refs: refMetas,
    files,
    bodies,
    totals: { filesChanged: declaredTotal, additions, deletions, omittedFiles },
    truncated,
    warnings,
    // The deterministic half of the analysis's codeChanges block. Code owns
    // these; the model contributes only `modules` and `riskSignals`. On the MCP
    // path this is what the skill tells the model to copy verbatim, since
    // ripple__save_report has no diff to re-derive them from.
    //
    // truncated/omittedFiles are included deliberately: without them the only
    // record that the diff was incomplete is prose the model was asked to write
    // into riskReason, and a saved report would look like a complete diff
    // whenever the model skipped that instruction.
    codeChangesFacts: {
      source,
      repo: resolvedRepo,
      refs: refMetas.map(r => ({ type: r.type, id: r.id, url: r.url, title: r.title })),
      filesChanged: declaredTotal,
      additions,
      deletions,
      truncated,
      omittedFiles,
    },
  };
}
