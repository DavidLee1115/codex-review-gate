import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function command(cwd, file, args) {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${file} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function fixture(t, scripts = { test: 'node -e "process.exit(0)"' }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'review-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  command(dir, 'git', ['init', '-q']);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'gate-fixture', version: '1.0.0', scripts }));
  writeFileSync(path.join(dir, 'README.md'), 'baseline\n');
  command(dir, 'git', ['add', '.']);
  command(dir, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline']);
  return dir;
}

function gate(dir, env = {}) {
  const result = spawnSync(process.execPath, [cli, dir, '--json'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, REVIEW_GATE_JEV_ADAPTER: '', ...env } });
  assert.ok(result.stdout, result.stderr);
  return { ...result, report: JSON.parse(result.stdout) };
}

test('docs-only change is an APPROVE candidate with passing discovered test', (t) => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, 'README.md'), 'clearer instructions\n');
  const { report, status } = gate(dir);
  assert.equal(status, 0);
  assert.equal(report.verdict, 'APPROVE');
  assert.equal(report.riskLevel, 'LOW');
  assert.equal(report.validations.find((x) => x.name === 'test').status, 'PASS');
  assert.equal(report.schemaVersion, 4);
  assert.equal(report.repository, path.basename(dir));
  assert.deepEqual(Object.keys(report).sort(), ['schemaVersion', 'reviewScope', 'recommendedNextStep', 'repository', 'branch', 'head', 'changedFiles', 'diffStats', 'projectFiles', 'validations', 'risks', 'evidence', 'jev', 'verdict', 'riskLevel', 'importantChanges', 'humanReviewItems'].sort());
  for (const bucket of ['positiveEvidence', 'negativeEvidence', 'uncertainty', 'riskSignals']) assert.ok(Array.isArray(report.evidence[bucket]));
});

test('CLI help documents defaults and exit codes', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Repository defaults to the current directory/);
  assert.match(result.stdout, /3 input\/tool error/);
});

test('CSS-only change is an APPROVE candidate', (t) => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, 'styles.css'), 'body { margin: 0; }\n');
  const { report } = gate(dir);
  assert.equal(report.verdict, 'APPROVE');
  assert.equal(report.changedFiles[0].status, 'untracked');
  assert.equal(report.changedFiles[0].additions, 1);
});

test('test failure rejects even low-risk changes', (t) => {
  const dir = fixture(t, { test: 'node -e "process.exit(1)"' });
  writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  const { report, status } = gate(dir);
  assert.equal(status, 2);
  assert.equal(report.verdict, 'REJECT');
  assert.equal(report.validations.find((x) => x.name === 'test').status, 'FAIL');
  assert.match(report.humanReviewItems.join(' '), /rerun npm run test/);
});

test('Jev APPROVE cannot override a failed test', (t) => {
  const dir = fixture(t, { test: 'node -e "process.exit(1)"' });
  writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  const adapterDir = mkdtempSync(path.join(tmpdir(), 'review-gate-adapter-'));
  t.after(() => rmSync(adapterDir, { recursive: true, force: true }));
  const adapter = path.join(adapterDir, 'adapter');
  writeFileSync(adapter, '#!/bin/sh\ncat >/dev/null\nprintf %s \'{"labels":[],"reviewPaths":[],"recommendation":"APPROVE"}\'\n', { mode: 0o755 });
  const { report } = gate(dir, { REVIEW_GATE_JEV_ADAPTER: adapter });
  assert.equal(report.verdict, 'REJECT');
  assert.ok(report.evidence.negativeEvidence.some((x) => /test failed/.test(x.detail)));
});

test('migration change requires review at HIGH risk', (t) => {
  const dir = fixture(t);
  mkdirSync(path.join(dir, 'db', 'migrations'), { recursive: true });
  writeFileSync(path.join(dir, 'db', 'migrations', '001.sql'), 'ALTER TABLE users ADD COLUMN name TEXT;\n');
  const { report } = gate(dir);
  assert.equal(report.verdict, 'REVIEW');
  assert.equal(report.riskLevel, 'HIGH');
  assert.ok(report.risks.some((x) => x.category === 'database-schema'));
  assert.match(report.humanReviewItems.join(' '), /migration compatibility/);
});

test('auth change requires review at HIGH risk', (t) => {
  const dir = fixture(t);
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'auth.ts'), 'export const canAccess = () => true;\n');
  const { report } = gate(dir);
  assert.equal(report.verdict, 'REVIEW');
  assert.ok(report.risks.some((x) => x.category === 'authentication' && x.level === 'HIGH'));
});

test('destructive filesystem operation rejects', (t) => {
  const dir = fixture(t);
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'cleanup.ts'), "import fs from 'node:fs';\nfs.rmSync('/tmp/data', { recursive: true });\n");
  const { report } = gate(dir);
  assert.equal(report.verdict, 'REJECT');
  assert.ok(report.risks.some((x) => x.category === 'destructive-delete'));
});

test('fs.rm call and a credential literal reject', (t) => {
  const dir = fixture(t);
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'cleanup.ts'), "fs.rm('/tmp/data', () => {});\nconst apiKey = 'long-credential-value';\n");
  const { report } = gate(dir);
  assert.equal(report.verdict, 'REJECT');
  assert.ok(report.risks.some((x) => x.category === 'destructive-delete'));
  assert.ok(report.risks.some((x) => x.category === 'secret-exposure'));
});

test('JSON-looking text in code is not a dependency change', (t) => {
  const dir = fixture(t);
  mkdirSync(path.join(dir, 'tests'));
  writeFileSync(path.join(dir, 'tests', 'sample.test.ts'), 'const sample = "version: 1";\n');
  const { report } = gate(dir);
  assert.ok(!report.risks.some((x) => x.category === 'dependency'));
});

test('unrequested CLI Jev adapter does not prevent a complete report', (t) => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  const { report } = gate(dir, { REVIEW_GATE_JEV_ADAPTER: '' });
  assert.equal(report.jev.status, 'not_requested');
  assert.equal(report.verdict, 'APPROVE');
});

test('filesystem write without a test is REVIEW/HIGH with uncertainty, not negative evidence', (t) => {
  const dir = fixture(t, {});
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'save.ts'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('output.json', '{}');\n");
  const { report } = gate(dir);
  assert.equal(report.verdict, 'REVIEW');
  assert.equal(report.riskLevel, 'HIGH');
  assert.equal(report.evidence.negativeEvidence.length, 0);
  assert.ok(report.evidence.uncertainty.some((x) => /No passing test/.test(x.detail)));
  assert.ok(report.evidence.riskSignals.some((x) => /filesystem-write/.test(x.detail)));
});

test('variable-target delete remains REVIEW/HIGH without explicit hard-rule evidence', (t) => {
  const dir = fixture(t, {});
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'cleanup.ts'), "import { rmSync } from 'node:fs';\nrmSync(target, { recursive: true });\n");
  const { report } = gate(dir);
  assert.equal(report.verdict, 'REVIEW');
  assert.equal(report.riskLevel, 'HIGH');
  assert.equal(report.evidence.negativeEvidence.length, 0);
});

test('multiline literal recursive delete triggers the explicit hard rule', (t) => {
  const dir = fixture(t, {});
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'cleanup.ts'), "import { rmSync } from 'node:fs';\nrmSync('/tmp/data', {\n  recursive: true,\n  force: true\n});\n");
  const { report } = gate(dir);
  assert.equal(report.verdict, 'REJECT');
  assert.equal(report.riskLevel, 'HIGH');
  assert.ok(report.evidence.negativeEvidence.some((x) => /explicit-destructive-target/.test(x.detail)));
});

test('visible target guard routes literal recursive delete to REVIEW/HIGH', (t) => {
  const dir = fixture(t, {});
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'cleanup.ts'), "import { rmSync } from 'node:fs';\nif (allowedRoot) rmSync('/tmp/data', { recursive: true });\n");
  const { report } = gate(dir);
  assert.equal(report.verdict, 'REVIEW');
  assert.equal(report.riskLevel, 'HIGH');
  assert.ok(report.risks.some((x) => x.category === 'destructive-delete'));
  assert.ok(!report.risks.some((x) => x.category === 'explicit-destructive-target'));
});

test('non-Git directory returns a clear error', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'review-gate-not-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = gate(dir);
  assert.equal(result.status, 3);
  assert.match(result.report.error, /Not a Git repository/);
  assert.deepEqual(Object.keys(result.report), ['error']);
  assert.ok(!result.stdout.includes(dir));
});

test('missing repository path returns a specific error without leaking the path', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'review-gate-missing-'));
  rmSync(dir, { recursive: true, force: true });
  const result = gate(dir);
  assert.equal(result.status, 3);
  assert.match(result.report.error, /Repository path does not exist/);
  assert.ok(!result.stdout.includes(dir));
});

test('malformed package manifest blocks docs-only APPROVE through uncertainty', (t) => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, 'package.json'), '{ broken json');
  command(dir, 'git', ['add', 'package.json']);
  command(dir, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'broken baseline']);
  writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  const { report } = gate(dir);
  assert.equal(report.verdict, 'REVIEW');
  assert.equal(report.riskLevel, 'LOW');
  assert.ok(report.evidence.uncertainty.some((x) => /manifest/.test(x.detail)));
});

test('credential-like documentation example requires review without hard rejection', (t) => {
  const dir = fixture(t, {});
  writeFileSync(path.join(dir, 'README.md'), "Example: const apiKey = 'example123456789';\n");
  const { report } = gate(dir);
  assert.equal(report.verdict, 'REVIEW');
  assert.equal(report.riskLevel, 'HIGH');
  assert.equal(report.evidence.negativeEvidence.length, 0);
});

test('JSON and text reports redact repository and adapter absolute paths', (t) => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  const adapterDir = mkdtempSync(path.join(tmpdir(), 'review-gate-adapter-'));
  t.after(() => rmSync(adapterDir, { recursive: true, force: true }));
  const adapter = path.join(adapterDir, 'adapter');
  const payload = { labels: [], reviewPaths: [], reason: `Inspect ${dir}/private.txt` };
  writeFileSync(adapter, `#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(JSON.stringify(payload))}));\n`, { mode: 0o755 });
  const jsonResult = gate(dir, { REVIEW_GATE_JEV_ADAPTER: adapter });
  assert.ok(!jsonResult.stdout.includes(dir));
  assert.ok(!jsonResult.stdout.includes(adapterDir));
  assert.equal(jsonResult.report.repository, path.basename(dir));
  const textResult = spawnSync(process.execPath, [cli, dir], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, REVIEW_GATE_JEV_ADAPTER: adapter } });
  assert.equal(textResult.status, 0);
  assert.ok(!textResult.stdout.includes(dir));
  assert.ok(!textResult.stdout.includes(adapterDir));
});

test('validation error excerpts redact the target repository path', (t) => {
  const dir = fixture(t, { test: 'node -e "throw new Error(process.cwd())"' });
  writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  const { report, stdout } = gate(dir);
  assert.equal(report.verdict, 'REJECT');
  assert.ok(!stdout.includes(dir));
  assert.ok(report.validations.find((x) => x.name === 'test').errors.some((x) => x.includes('[repository]')));
});

test('staged and unstaged edits are both inspected', (t) => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, 'README.md'), 'staged\n');
  command(dir, 'git', ['add', 'README.md']);
  writeFileSync(path.join(dir, 'README.md'), 'unstaged\n');
  const { report } = gate(dir);
  assert.equal(report.changedFiles[0].staged, true);
  assert.equal(report.changedFiles[0].unstaged, true);
  assert.equal(report.changedFiles[0].additions, 2);
  assert.equal(report.changedFiles[0].deletions, 2);
});

test('Jev recommendation cannot override deterministic HIGH risk', (t) => {
  const dir = fixture(t);
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'auth.ts'), 'export const canAccess = () => true;\n');
  const adapter = path.join(dir, 'adapter');
  writeFileSync(adapter, '#!/bin/sh\ncat >/dev/null\nprintf %s \'{"labels":["low"],"reviewPaths":[],"recommendation":"APPROVE"}\'\n', { mode: 0o755 });
  const { report } = gate(dir, { REVIEW_GATE_JEV_ADAPTER: adapter });
  assert.equal(report.jev.status, 'available');
  assert.equal(report.jev.disagreement, true);
  assert.equal(report.verdict, 'REVIEW');
});

test('renaming an auth file into docs cannot be approved', (t) => {
  const dir = fixture(t);
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'auth.ts'), 'export const canAccess = () => true;\n');
  command(dir, 'git', ['add', '.']);
  command(dir, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'auth baseline']);
  mkdirSync(path.join(dir, 'docs'));
  command(dir, 'git', ['mv', 'src/auth.ts', 'docs/notes.md']);
  const { report } = gate(dir);
  assert.equal(report.verdict, 'REVIEW');
  assert.equal(report.riskLevel, 'HIGH');
  assert.equal(report.changedFiles[0].oldPath, 'src/auth.ts');
  assert.ok(report.risks.some((x) => x.category === 'authentication'));
});

test('validation-generated changes prevent stale APPROVE', (t) => {
  const dir = fixture(t, { test: 'node -e "require(\'fs\').writeFileSync(\'auth.ts\', \'export const allow = true;\\n\')"' });
  writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  const { report } = gate(dir);
  assert.equal(report.verdict, 'REVIEW');
  assert.ok(report.risks.some((x) => x.category === 'validation-worktree-change'));
  assert.ok(report.changedFiles.some((x) => x.path === 'auth.ts'));
});

test('explicit Jev REVIEW raises low-risk change to REVIEW', (t) => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  const adapterDir = mkdtempSync(path.join(tmpdir(), 'review-gate-adapter-'));
  t.after(() => rmSync(adapterDir, { recursive: true, force: true }));
  const adapter = path.join(adapterDir, 'adapter');
  writeFileSync(adapter, '#!/bin/sh\ncat >/dev/null\nprintf %s \'{"labels":[],"reviewPaths":[],"recommendation":"REVIEW","reason":"Manual wording check"}\'\n', { mode: 0o755 });
  const { report } = gate(dir, { REVIEW_GATE_JEV_ADAPTER: adapter });
  assert.equal(report.verdict, 'REVIEW');
  assert.equal(report.jev.recommendation, 'REVIEW');
  assert.match(report.humanReviewItems.join(' '), /Manual wording check/);
});

test('Jev REJECT is a second opinion and cannot create negative evidence', (t) => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  const adapterDir = mkdtempSync(path.join(tmpdir(), 'review-gate-adapter-'));
  t.after(() => rmSync(adapterDir, { recursive: true, force: true }));
  const adapter = path.join(adapterDir, 'adapter');
  writeFileSync(adapter, '#!/bin/sh\ncat >/dev/null\nprintf %s \'{"labels":["review"],"reviewPaths":[],"recommendation":"REJECT","reason":"Check wording"}\'\n', { mode: 0o755 });
  const { report } = gate(dir, { REVIEW_GATE_JEV_ADAPTER: adapter });
  assert.equal(report.verdict, 'REVIEW');
  assert.equal(report.evidence.negativeEvidence.length, 0);
  assert.ok(report.evidence.riskSignals.some((x) => x.source === 'jev'));
});

test('sensitive patch is omitted from explicit Jev adapter input', (t) => {
  const dir = fixture(t);
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'keys.ts'), "const apiKey = 'long-credential-value';\n");
  const adapterDir = mkdtempSync(path.join(tmpdir(), 'review-gate-adapter-'));
  t.after(() => rmSync(adapterDir, { recursive: true, force: true }));
  const input = path.join(adapterDir, 'input.json');
  const adapter = path.join(adapterDir, 'adapter');
  writeFileSync(adapter, `#!/bin/sh\ncat > '${input}'\nprintf %s '{"labels":[],"reviewPaths":[],"recommendation":"APPROVE"}'\n`, { mode: 0o755 });
  const { report } = gate(dir, { REVIEW_GATE_JEV_ADAPTER: adapter });
  const received = JSON.parse(readFileSync(input, 'utf8'));
  assert.equal(report.verdict, 'REJECT');
  assert.ok(report.jev.omittedPaths.includes('src/keys.ts'));
  assert.equal(received.files.find((f) => f.path === 'src/keys.ts').patch, null);
  assert.ok(!readFileSync(input, 'utf8').includes('long-credential-value'));
});
