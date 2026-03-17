function normalizeVercelFailure(payload = {}) {
  return {
    source: 'vercel',
    kind: 'deploy',
    label: 'deploy',
    title: payload.title || payload.name || 'Vercel deploy failure',
    summary: payload.summary || payload.error || payload.message || 'Unknown Vercel failure',
    metadata: payload,
  };
}

function normalizeSentryIssue(payload = {}) {
  // Sentry internal integration sends { action, data: { issue }, installation }
  // or a flat issue object depending on how it's called
  const issue = payload.data?.issue || payload.issue || payload;
  const action = payload.action || 'created'; // created, resolved, assigned, etc.

  const title = issue.title || issue.metadata?.title || payload.title || payload.issueTitle || 'Sentry runtime issue';
  const culprit = issue.culprit || payload.culprit || '';
  const shortId = issue.shortId || '';
  const level = issue.level || 'error';
  const project = issue.project?.slug || issue.project?.name || payload.project || '';
  const issueUrl = issue.permalink || '';
  const count = issue.count || 0;
  const firstSeen = issue.firstSeen || '';
  const lastSeen = issue.lastSeen || '';

  const summaryParts = [];
  if (culprit) summaryParts.push(culprit);
  if (count > 1) summaryParts.push(`${count} occurrences`);
  if (issueUrl) summaryParts.push(issueUrl);
  const summary = summaryParts.join(' | ') || payload.summary || payload.message || 'Unknown Sentry issue';

  // Try to map Sentry project to a repo
  const repoHint = project || culprit;

  return {
    source: 'sentry',
    kind: 'runtime',
    label: level === 'fatal' ? 'critical' : 'runtime',
    title: `[${shortId || 'Sentry'}] ${title}`,
    summary,
    repo: repoHint || payload.repo,
    metadata: {
      sentryAction: action,
      sentryIssueId: issue.id || null,
      sentryShortId: shortId,
      sentryUrl: issueUrl,
      sentryProject: project,
      sentryLevel: level,
      sentryCount: count,
      sentryFirstSeen: firstSeen,
      sentryLastSeen: lastSeen,
      ...(payload.metadata || {}),
    },
  };
}

function normalizeManualIssue(payload = {}) {
  const kind = payload.kind || 'bug';
  return {
    source: 'manual',
    kind,
    label: payload.label || kind,
    title: payload.title || 'Manual issue',
    summary: payload.summary || payload.description || 'No summary provided',
    metadata: payload,
  };
}

function slugifyRepo(repo) {
  if (!repo) return null;
  const parts = String(repo).split('/').filter(Boolean);
  const tail = parts.slice(-2).join('-') || parts.slice(-1)[0] || 'unknown';
  return tail.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function chooseLinearProjectKey(payload = {}) {
  const source = String(payload.source || '').toLowerCase();
  const kind = String(payload.kind || '').toLowerCase();
  const repo = String(payload.repo || '').toLowerCase();
  const goal = String(payload.goal || payload.title || '').toLowerCase();

  if (repo.includes('coding-control-plane') || repo.includes('/control-plane') || goal.includes('control plane')) {
    return 'controlPlane';
  }
  if (source === 'sentry' || source === 'vercel') {
    return 'reliability';
  }
  if (['deploy', 'runtime', 'regression', 'incident', 'bug'].includes(kind)) {
    return 'reliability';
  }
  return 'product';
}

function buildLinearLabels(payload = {}) {
  const labels = new Set();
  if (payload.label) labels.add(String(payload.label).toLowerCase());
  if (payload.kind) labels.add(String(payload.kind).toLowerCase());
  if (payload.source) labels.add(`source:${String(payload.source).toLowerCase()}`);
  const repoSlug = slugifyRepo(payload.repo);
  if (repoSlug) labels.add(`repo:${repoSlug}`);
  return [...labels].filter(Boolean);
}

module.exports = {
  normalizeVercelFailure,
  normalizeSentryIssue,
  normalizeManualIssue,
  chooseLinearProjectKey,
  buildLinearLabels,
  slugifyRepo,
};
