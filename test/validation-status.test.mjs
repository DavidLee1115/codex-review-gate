import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { decide } from '../dist/verdict.js';
import { run } from '../dist/process.js';
import { validationResult } from '../dist/validate.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const disabledJev = { ...process.env, REVIEW_GATE_JEV_ADAPTER: '' };
const noJev = { status: 'not_requested', source: null, labels: [], reviewPaths: [], omittedPaths: [], recommendation: null, reason: 'Not requested', disagreement: false };

function temporary(t, prefix = 'review-gate-status-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function command(cwd, file, args) {
  const result = spawnSync(file, args, { cwd, env: disabledJev, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${file} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(t, manifest = { scripts: { test: 'node -e "process.exit(0)"' } }) {
  const dir = temporary(t);
  command(dir, 'git', ['init', '-q']);
  if (manifest !== null) writeFileSync(path.join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  writeFileSync(path.join(dir, 'README.md'), 'baseline\n');
  command(dir, 'git', ['add', '.']);
  command(dir, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline']);
  writeFileSync(path.join(dir, 'README.md'), 'updated instructions\n');
  return dir;
}

function gate(dir, env = {}, text = false) {
  const result = spawnSync(process.execPath, [cli, dir, ...(text ? [] : ['--json'])], {
    env: { ...disabledJev, ...env }, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.ok(result.stdout, result.stderr);
  return { ...result, report: text ? null : JSON.parse(result.stdout) };
}

function testValidation(report) {
  return report.validations.find((validation) => validation.name === 'test');
}

function assertNoValidationFailure(report) {
  assert.notEqual(report.verdict, 'REJECT');
  assert.equal(report.evidence.negativeEvidence.filter((entry) => entry.source === 'validation').length, 0);
}

test('Python changes without an execution adapter are NOT_RUN, never inferred PASS or FAIL', (t) => {
  const dir = fixture(t, null);
  writeFileSync(path.join(dir, 'main.py'), 'def add(a, b):\n    return a + b\n');
  const { report, status } = gate(dir);
  assert.equal(status, 1);
  assert.equal(report.verdict, 'REVIEW');
  assert.ok(report.validations.length > 0);
  for (const validation of report.validations) {
    assert.equal(validation.status, 'NOT_RUN');
    assert.equal(validation.executed, false);
    assert.equal(validation.exitCode, null);
    assert.ok(validation.reason.length > 0);
  }
  assert.equal(report.evidence.positiveEvidence.filter((entry) => entry.source === 'validation').length, 0);
  assertNoValidationFailure(report);
  assert.ok(report.humanReviewItems.length > 0);
});

test('missing optional lint is NOT_RUN and does not invalidate a real passing test', (t) => {
  const dir = fixture(t);
  const { report, status } = gate(dir);
  assert.equal(status, 0);
  assert.equal(report.verdict, 'APPROVE');
  const validation = testValidation(report);
  assert.equal(validation.status, 'PASS');
  assert.equal(validation.executed, true);
  assert.equal(validation.exitCode, 0);
  assert.equal(validation.outputTruncated, false);
  const lint = report.validations.find((entry) => entry.name === 'lint');
  assert.equal(lint.status, 'NOT_RUN');
  assert.equal(lint.executed, false);
  assert.equal(lint.exitCode, null);
  assertNoValidationFailure(report);
});

test('unavailable npm executable blocks validation without reporting failed tests', (t) => {
  const dir = fixture(t);
  const bin = temporary(t, 'review-gate-bin-');
  const git = command(dir, '/usr/bin/which', ['git']);
  symlinkSync(git, path.join(bin, 'git'));
  const { report, status } = gate(dir, { PATH: bin });
  assert.equal(status, 1);
  const validation = testValidation(report);
  assert.equal(validation.status, 'BLOCKED');
  assert.equal(validation.executed, false);
  assert.equal(validation.exitCode, null);
  assertNoValidationFailure(report);
  assert.ok(report.humanReviewItems.length > 0);
});

test('a configured but missing validator is BLOCKED after the npm runner starts', (t) => {
  const dir = fixture(t, { scripts: { test: 'review-gate-deliberately-missing-validator-18204' } });
  const { report } = gate(dir);
  const validation = testValidation(report);
  assert.equal(validation.status, 'BLOCKED');
  assert.equal(validation.executed, true);
  assert.equal(validation.exitCode, 127);
  assertNoValidationFailure(report);
});

test('validator permission errors are BLOCKED instead of failing evidence', (t) => {
  const dir = fixture(t, { scripts: { test: './validator-local' } });
  writeFileSync(path.join(dir, 'validator-local'), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(dir, 'validator-local'), 0o644);
  const { report } = gate(dir);
  const validation = testValidation(report);
  assert.equal(validation.status, 'BLOCKED');
  assert.equal(validation.executed, true);
  assert.equal(validation.exitCode, 126);
  assertNoValidationFailure(report);
});

for (const [name, manifest] of [
  ['malformed JSON', '{ broken json'],
  ['non-object manifest', 'null'],
  ['array-valued scripts', { scripts: [] }],
  ['non-string configured command', { scripts: { test: 42 } }],
]) {
  test(`${name} blocks discovery and cannot approve or reject documentation`, (t) => {
    const dir = fixture(t, manifest);
    const { report } = gate(dir);
    assert.equal(report.verdict, 'REVIEW');
    assert.ok(report.validations.some((validation) => validation.status === 'BLOCKED'));
    assert.ok(report.validations.every((validation) => validation.executed === false));
    assertNoValidationFailure(report);
  });
}

test('actual validator nonzero exit remains FAIL and REJECT', (t) => {
  const dir = fixture(t, { scripts: { test: 'node -e "console.error(\'assertion failed\'); process.exit(1)"' } });
  const { report, status } = gate(dir);
  assert.equal(status, 2);
  assert.equal(report.verdict, 'REJECT');
  const validation = testValidation(report);
  assert.equal(validation.status, 'FAIL');
  assert.equal(validation.executed, true);
  assert.equal(validation.exitCode, 1);
  assert.ok(report.evidence.negativeEvidence.some((entry) => entry.source === 'validation'));
});

test('exit 127 alone is not evidence of a missing executable', (t) => {
  const dir = fixture(t, { scripts: { test: 'node -e "console.error(\'assertion failed\'); process.exit(127)"' } });
  const { report } = gate(dir);
  assert.equal(testValidation(report).status, 'FAIL');
  assert.equal(report.verdict, 'REJECT');
});

test('successful command with truncated output is BLOCKED and cannot claim PASS', (t) => {
  const dir = fixture(t, { scripts: { test: 'node -e "process.stdout.write(\'x\'.repeat(140000))"' } });
  const { report } = gate(dir);
  const validation = testValidation(report);
  assert.equal(validation.status, 'BLOCKED');
  assert.equal(validation.executed, true);
  assert.equal(validation.exitCode, 0);
  assert.equal(validation.outputTruncated, true);
  assertNoValidationFailure(report);
});

test('process timeout is distinguishable from a completed failing command', async (t) => {
  const dir = temporary(t);
  const result = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], dir, { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  const validation = validationResult('test', 'local timeout probe', result);
  assert.equal(validation.status, 'BLOCKED');
  assert.equal(validation.executed, true);
});

test('output truncation does not erase a completed failing exit', async (t) => {
  const dir = temporary(t);
  const result = await run(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096)); process.exitCode = 1"], dir, { maxBytes: 100 });
  assert.equal(result.truncated, true);
  const validation = validationResult('test', 'local failing probe', result);
  assert.equal(validation.status, 'FAIL');
  assert.equal(validation.outputTruncated, true);
  assert.equal(validation.exitCode, 1);
});

test('explicitly inapplicable SKIP is neither positive nor negative validation evidence', () => {
  const file = { path: 'README.md', status: 'modified', staged: false, unstaged: true, additions: 1, deletions: 1, binary: false, diffTruncated: false, patch: '+clearer instructions' };
  const validation = { name: 'test', command: null, status: 'SKIP', executed: false, exitCode: null, durationMs: 0, errors: [], outputTruncated: false, reason: 'Explicit policy: no executable content in scope' };
  const result = decide([file], [], [validation], noJev);
  assert.equal(result.verdict, 'APPROVE');
  assert.equal(result.evidence.positiveEvidence.filter((entry) => entry.source === 'validation').length, 0);
  assert.equal(result.evidence.negativeEvidence.length, 0);
});

test('JSON and text explain the review boundary and required next action', (t) => {
  const dir = fixture(t);
  const { report } = gate(dir);
  assert.equal(report.schemaVersion, 4);
  assert.match(report.reviewScope, /review|diff|code/i);
  assert.ok(report.recommendedNextStep.length > 0);
  const { stdout } = gate(dir, {}, true);
  assert.match(stdout, /APPROVE[^\n]*(?:not|≠|does not)[^\n]*PASS/i);
  assert.match(stdout, /POSITIVE EVIDENCE/i);
  assert.match(stdout, /NEGATIVE EVIDENCE/i);
  assert.match(stdout, /MISSING[^\n]*BLOCKED[^\n]*VALIDATION/i);
  assert.match(stdout, /UNCERTAINTY/i);
  assert.match(stdout, /(?:REQUIRED HUMAN ACTION|HUMAN REVIEW REQUIRED)/i);
  assert.match(stdout, /RECOMMENDED NEXT STEP/i);
});

test('default run never discovers or invokes a Jev executable from PATH', (t) => {
  const dir = fixture(t);
  const bin = temporary(t, 'review-gate-jev-bin-');
  const marker = path.join(bin, 'was-invoked');
  writeFileSync(path.join(bin, 'jev'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'invoked');\n`, { mode: 0o755 });
  const { report } = gate(dir, { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` });
  assert.equal(report.jev.status, 'not_requested');
  assert.equal(report.verdict, 'APPROVE');
  assert.equal(existsSync(marker), false);
});

test('unavailable explicitly selected Jev adapter degrades to deterministic review', (t) => {
  const dir = fixture(t);
  const { report } = gate(dir, { REVIEW_GATE_JEV_ADAPTER: path.join(dir, 'nonexistent-local-adapter') });
  assert.equal(report.jev.status, 'failed');
  assert.equal(report.verdict, 'APPROVE');
  assertNoValidationFailure(report);
});

test('invalid local Jev output is invoked once and never supplies a verdict', (t) => {
  const dir = fixture(t);
  const adapterDir = temporary(t, 'review-gate-jev-stub-');
  const marker = path.join(adapterDir, 'invocations');
  const adapter = path.join(adapterDir, 'local-adapter');
  writeFileSync(adapter, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(marker)}, '1\\n');\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.stdout.write('not-json'));\n`, { mode: 0o755 });
  const { report } = gate(dir, { REVIEW_GATE_JEV_ADAPTER: adapter });
  assert.equal(report.jev.status, 'failed');
  assert.equal(report.verdict, 'APPROVE');
  assert.equal(readFileSync(marker, 'utf8'), '1\n');
  assertNoValidationFailure(report);
});
