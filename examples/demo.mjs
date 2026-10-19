// Synthetic CLI demonstration. No private repositories or optional adapters.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'review-gate-demo-'));
const invalid = mkdtempSync(path.join(tmpdir(), 'review-gate-not-git-'));
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
}
function review(target) {
  const result = spawnSync(process.execPath, [cli, target, '--json'], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, REVIEW_GATE_JEV_ADAPTER: '' }
  });
  assert.ifError(result.error);
  return { exitCode: result.status, report: JSON.parse(result.stdout) };
}
try {
  git('init', '-q');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'synthetic-demo', private: true, scripts: { test: 'node -e "process.exit(0)"' } }));
  writeFileSync(path.join(root, 'README.md'), 'Synthetic baseline.\n');
  git('add', '.');
  git('-c', 'user.name=Synthetic Demo', '-c', 'user.email=demo@example.invalid', 'commit', '-qm', 'Synthetic baseline');
  writeFileSync(path.join(root, 'README.md'), 'Synthetic baseline with clearer instructions.\n');
  const approved = review(root);
  assert.equal(approved.exitCode, 0);
  assert.equal(approved.report.verdict, 'APPROVE');
  assert.equal(approved.report.validations.find(v => v.name === 'test').status, 'PASS');
  console.log(JSON.stringify({ scenario: 'docs-only', exitCode: approved.exitCode, verdict: approved.report.verdict, riskLevel: approved.report.riskLevel, testStatus: 'PASS' }));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'synthetic-demo', private: true, scripts: { test: 'node -e "process.exit(1)"' } }));
  const rejected = review(root);
  assert.equal(rejected.exitCode, 2);
  assert.equal(rejected.report.verdict, 'REJECT');
  assert.equal(rejected.report.validations.find(v => v.name === 'test').status, 'FAIL');
  console.log(JSON.stringify({ scenario: 'failing-test', exitCode: rejected.exitCode, verdict: rejected.report.verdict, testStatus: 'FAIL' }));
  const error = review(invalid);
  assert.equal(error.exitCode, 3);
  assert.match(error.report.error, /Not a Git repository/);
  console.log(JSON.stringify({ scenario: 'not-a-git-repository', exitCode: error.exitCode, error: error.report.error }));
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(invalid, { recursive: true, force: true });
}
