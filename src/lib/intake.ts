import type { NormalizedIncident, IntakePayload } from '../types';

function normalizeVercelFailure(payload: IntakePayload = {}): NormalizedIncident {
  return {
    source: 'vercel',
    kind: 'deploy',
    label: 'deploy',
    title: payload.title || payload.name || 'Vercel deploy failure',
    summary: payload.summary || payload.error || payload.message || 'Unknown Vercel failure',
    metadata: payload as Record<string, unknown>,
  };
}

function normalizeSentryIssue(payload: IntakePayload = {}): NormalizedIncident {
  const issue = (payload.data as Record<string, unknown>)?.issue as Record<string, unknown>
    || payload.issue as Record<string, unknown>
    || payload as Record<string, unknown>;
  const action = payload.action || 'created';

  const title = (issue.title as string) || ((issue.metadata as Record<string, unknown>)?.title as string) || payload.title || payload.issueTitle || 'Sentry runtime issue';
  const culprit = (issue.culprit as string) || payload.culprit || '';
  const shortId = (issue.shortId as string) || '';
  const level = (issue.level as string) || 'error';
  const project = (issue.project as Record<string, unknown>)?.slug as string || (issue.project as Record<string, unknown>)?.name as string || payload.project || '';
  const issueUrl = (issue.permalink as string) || '';
  const count = (issue.count as number) || 0;
  const firstSeen = (issue.firstSeen as string) || '';
  const lastSeen = (issue.lastSeen as string) || '';

  const summaryParts: string[] = [];
  if (culprit) summaryParts.push(culprit);
  if (count > 1) summaryParts.push(`${count} occurrences`);
  if (issueUrl) summaryParts.push(issueUrl);
  const summary = summaryParts.join(' | ') || payload.summary || payload.message || 'Unknown Sentry issue';

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
      sentryIssueId: (issue.id as string) || null,
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

function normalizeManualIssue(payload: IntakePayload = {}): NormalizedIncident {
  const kind = payload.kind || 'bug';
  return {
    source: 'manual',
    kind,
    label: payload.label || kind,
    title: payload.title || 'Manual issue',
    summary: payload.summary || payload.description || 'No summary provided',
    metadata: payload as Record<string, unknown>,
  };
}

function slugifyRepo(repo: string | undefined | null): string | null {
  if (!repo) return null;
  const parts = String(repo).split('/').filter(Boolean);
  const tail = parts.slice(-2).join('-') || parts.slice(-1)[0] || 'unknown';
  return tail.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function chooseLinearProjectKey(payload: IntakePayload = {}): string {
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

function buildLinearLabels(payload: IntakePayload = {}): string[] {
  const labels = new Set<string>();
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

export { normalizeVercelFailure, normalizeSentryIssue, normalizeManualIssue, chooseLinearProjectKey, buildLinearLabels, slugifyRepo };
