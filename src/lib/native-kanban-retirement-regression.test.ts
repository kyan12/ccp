import assert = require('node:assert/strict');
import fs = require('node:fs');
import path = require('node:path');
import test = require('node:test');

const sourceRoot = path.resolve(__dirname, '..', '..', 'src');
const repoRoot = path.resolve(sourceRoot, '..');
const intakeServer = fs.readFileSync(path.join(sourceRoot, 'bin', 'intake-server.ts'), 'utf8');
const intakeRunner = fs.readFileSync(path.join(sourceRoot, 'lib', 'intake-runner.ts'), 'utf8');

function routeSlice(start: string, end: string): string {
  const startAt = intakeServer.indexOf(start);
  const endAt = intakeServer.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing route marker ${start}`);
  assert.notEqual(endAt, -1, `missing route boundary ${end}`);
  return intakeServer.slice(startAt, endAt);
}

test('current-main legacy intake routes remain retired while Sentry targets native Kanban', () => {
  assert.doesNotMatch(intakeServer, /intakeToLinear|dispatchLinearIssues|handleLinearWebhook/);

  const vercel = routeSlice("url.pathname === '/ingest/vercel'", "url.pathname === '/ingest/sentry'");
  const sentry = routeSlice("url.pathname === '/ingest/sentry'", "url.pathname === '/ingest/manual'");
  const manual = routeSlice("url.pathname === '/ingest/manual'", "url.pathname === '/api/intake'");
  const app = routeSlice("url.pathname === '/api/intake'", "url.pathname === '/api/onboard'");
  const onboard = routeSlice("url.pathname === '/api/onboard'", "json(res, 404");

  assert.match(vercel, /retiredIntake\(res, 'vercel'/);
  assert.match(sentry, /submitSentryToKanban/);
  assert.doesNotMatch(sentry, /retiredIntake|createJob|saveStatus|intakeToLinear/);
  assert.match(manual, /retiredIntake\(res, 'manual'/);
  assert.match(app, /retiredIntake\(res, 'app'/);
  assert.doesNotMatch([vercel, manual, app].join('\n'), /onboardRepo|createJob|saveStatus|intakeToLinear/);
  assert.match(onboard, /retiredIntake\(res, 'onboard'/);
  assert.doesNotMatch(onboard, /onboardRepo|require|createJob|saveStatus/);
  assert.equal(fs.existsSync(path.join(sourceRoot, 'lib', 'onboard-repo.ts')), false);

  const linear = routeSlice("url.pathname === '/webhook/linear'", '// ── Dashboard');
  assert.match(linear, /json\(res, 410/);
  assert.doesNotMatch(linear, /parseBody|verifyLinear|dispatchLinearIssues|createJob|saveStatus/);

  assert.doesNotMatch(intakeRunner, /Linear|GraphQL|mutation|createIssue|updateIssue/);
  assert.equal(fs.existsSync(path.join(sourceRoot, 'lib', 'linear.ts')), false);
  assert.equal(fs.existsSync(path.join(sourceRoot, 'lib', 'linear-dispatch.ts')), false);
});

test('retired GitHub webhook has one terminal route and no legacy mutation machinery', () => {
  const routeMarkers = intakeServer.match(/url\.pathname === '\/webhook\/github'/g) || [];
  assert.equal(routeMarkers.length, 1);
  assert.doesNotMatch(
    intakeServer,
    /verifyGitHub|collectPrReviewFeedback|maybeEnqueueReviewRemediation|saveStatus: ss|sendDiscordMessage/,
  );
});

test('operator guidance does not advertise retired PR remediation producers', () => {
  const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  const plannerDoc = fs.readFileSync(path.join(repoRoot, 'docs', 'planner.md'), 'utf8');
  const jobsSource = fs.readFileSync(path.join(sourceRoot, 'lib', 'jobs.ts'), 'utf8');

  assert.doesNotMatch(envExample, /failing smoke[\s\S]{0,160}spawn a __deployfix/i);
  assert.match(envExample, /bounded PR drain never runs smoke, changes job state, or spawns remediation/);
  assert.match(plannerDoc, /Historical remediation records/);
  assert.match(jobsSource, /Historical smoke-remediation constructor retained for isolated compatibility/);
});

test('repository operational docs route current work only to native Hermes Kanban', () => {
  const docNames = [
    'routing.md',
    'incident-jobs.md',
    'nightly-compound.md',
    'worktrees.md',
    'agents.md',
    'coding-control-plane-spec.md',
    'pr-policy.md',
  ];
  const docs = docNames.map((name) => fs.readFileSync(path.join(repoRoot, 'docs', name), 'utf8'));
  const combined = docs.join('\n');
  const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

  for (const [index, content] of docs.entries()) {
    assert.match(content, /Native Hermes Kanban|native Hermes Kanban/, `${docNames[index]} lacks current ownership`);
  }

  assert.doesNotMatch(combined, /Linear is the source of truth|All coding work lands in the single Linear team/);
  assert.doesNotMatch(combined, /Attach a Linear label|all route into Linear|creates a CCP job per repo/);
  assert.doesNotMatch(combined, /notifications \+ Linear sync|PR URL recovery/);
  assert.doesNotMatch(combined, /"autoMerge"\s*:\s*true|maps directly to GitHub's merge strategies/);
  assert.doesNotMatch(envExample, /^LINEAR_API_KEY=|^# CCP_LINEAR_DISABLED=false|CCP_PR_REMEDIATE_ENABLED=true/m);
  assert.doesNotMatch(envExample, /CCP_DISCORD_STATUS_CHANNEL=.*Full lifecycle/);
});
