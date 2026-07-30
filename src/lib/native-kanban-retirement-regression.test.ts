import assert = require('node:assert/strict');
import fs = require('node:fs');
import path = require('node:path');
import test = require('node:test');

const sourceRoot = path.resolve(__dirname, '..', '..', 'src');
const intakeServer = fs.readFileSync(path.join(sourceRoot, 'bin', 'intake-server.ts'), 'utf8');
const intakeRunner = fs.readFileSync(path.join(sourceRoot, 'lib', 'intake-runner.ts'), 'utf8');

function routeSlice(start: string, end: string): string {
  const startAt = intakeServer.indexOf(start);
  const endAt = intakeServer.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing route marker ${start}`);
  assert.notEqual(endAt, -1, `missing route boundary ${end}`);
  return intakeServer.slice(startAt, endAt);
}

test('current-main intake routes remain retired and cannot recreate Linear or repository onboarding', () => {
  assert.doesNotMatch(intakeServer, /intakeToLinear|dispatchLinearIssues|handleLinearWebhook/);

  const vercel = routeSlice("url.pathname === '/ingest/vercel'", "url.pathname === '/ingest/sentry'");
  const sentry = routeSlice("url.pathname === '/ingest/sentry'", "url.pathname === '/ingest/manual'");
  const manual = routeSlice("url.pathname === '/ingest/manual'", "url.pathname === '/api/intake'");
  const app = routeSlice("url.pathname === '/api/intake'", "url.pathname === '/api/onboard'");

  assert.match(vercel, /retiredIntake\(res, 'vercel'/);
  assert.match(sentry, /retiredIntake\(res, 'sentry'/);
  assert.match(manual, /retiredIntake\(res, 'manual'/);
  assert.match(app, /retiredIntake\(res, 'app'/);
  assert.doesNotMatch([vercel, sentry, manual, app].join('\n'), /onboardRepo|createJob|saveStatus|intakeToLinear/);

  const linear = routeSlice("url.pathname === '/webhook/linear'", "json(res, 404");
  assert.match(linear, /verifyLinear/);
  assert.match(linear, /retiredIntake\(res, 'linear'/);
  assert.doesNotMatch(linear, /dispatchLinearIssues|createJob|saveStatus/);

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
