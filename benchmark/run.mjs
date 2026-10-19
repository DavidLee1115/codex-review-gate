#!/usr/bin/env node
// Ground-truth calibration against the built CLI and real, disposable Git repositories.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const passingTest = 'node -e "process.exit(0)"';

function run(file, args, cwd, options = {}) {
  return spawnSync(file, args, { cwd, encoding: 'utf8', timeout: 120_000, ...options });
}

function requireSuccess(result, command) {
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
}

function write(repo, name, contents) {
  const destination = path.join(repo, name);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function fixture(scripts, packageText) {
  const repo = mkdtempSync(path.join(tmpdir(), 'review-gate-benchmark-'));
  try {
    requireSuccess(run('git', ['init', '-q'], repo), 'git init');
    write(repo, 'package.json', packageText ?? JSON.stringify({ name: 'benchmark-fixture', version: '1.0.0', scripts }));
    write(repo, 'README.md', 'Baseline documentation.\n');
    requireSuccess(run('git', ['add', '.'], repo), 'git add');
    requireSuccess(run('git', ['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.invalid', 'commit', '-qm', 'baseline'], repo), 'git commit');
    return repo;
  } catch (error) {
    rmSync(repo, { recursive: true, force: true });
    throw error;
  }
}

// The labels express desired policy, not predictions from the current implementation.
// A delete with no scope check or recovery guard is an explicit hard-rule REJECT.
const cases = [
  {
    name: 'README only', scripts: { test: passingTest }, expected: ['APPROVE', 'LOW'],
    change: (repo) => write(repo, 'README.md', 'Clearer documentation.\n'),
    evidence: ['positiveEvidence']
  },
  {
    name: 'CSS only', scripts: { test: passingTest }, expected: ['APPROVE', 'LOW'],
    change: (repo) => write(repo, 'styles.css', 'body { margin: 0; }\n'),
    evidence: ['positiveEvidence']
  },
  {
    name: 'Broken baseline package, README only', scripts: {}, packageText: '{ invalid JSON\n', expected: ['REVIEW', 'LOW'],
    change: (repo) => write(repo, 'README.md', 'Clearer documentation.\n'),
    evidence: ['uncertainty']
  },
  {
    name: 'README example credential', scripts: { test: passingTest }, expected: ['REVIEW', 'HIGH'],
    change: (repo) => write(repo, 'README.md', "Baseline documentation.\n\nExample only:\n```ts\nconst apiKey = 'example123456789';\n```\n"),
    evidence: ['riskSignals'], absentEvidence: ['negativeEvidence']
  },
  {
    name: 'Filesystem write, no tests', scripts: {}, expected: ['REVIEW', 'HIGH'],
    change: (repo) => write(repo, 'src/save.ts', "import { writeFileSync } from 'node:fs';\nwriteFileSync('output.txt', 'content');\n"),
    evidence: ['uncertainty', 'riskSignals']
  },
  {
    name: 'Migration', scripts: { test: passingTest }, expected: ['REVIEW', 'HIGH'],
    change: (repo) => write(repo, 'db/migrations/001.sql', 'ALTER TABLE users ADD COLUMN name TEXT;\n'),
    evidence: ['riskSignals']
  },
  {
    name: 'Authentication', scripts: { test: passingTest }, expected: ['REVIEW', 'HIGH'],
    change: (repo) => write(repo, 'src/auth.ts', 'export const canAccess = (user: unknown) => Boolean(user);\n'),
    evidence: ['riskSignals']
  },
  {
    name: 'Test failure', scripts: { test: 'node -e "process.exit(1)"' }, expected: ['REJECT', 'LOW'],
    change: (repo) => write(repo, 'README.md', 'Changed documentation.\n'),
    evidence: ['negativeEvidence']
  },
  {
    name: 'Typecheck failure', scripts: { test: passingTest, typecheck: 'node -e "process.exit(1)"' }, expected: ['REJECT', 'LOW'],
    change: (repo) => write(repo, 'README.md', 'Changed documentation.\n'),
    evidence: ['negativeEvidence']
  },
  {
    name: 'Hardcoded secret', scripts: { test: passingTest }, expected: ['REJECT', 'HIGH'],
    change: (repo) => write(repo, 'src/config.ts', "const apiKey = 'long-credential-value';\n"),
    evidence: ['negativeEvidence', 'riskSignals']
  },
  {
    name: 'Unguarded destructive delete', scripts: { test: passingTest }, expected: ['REJECT', 'HIGH'],
    change: (repo) => write(repo, 'src/cleanup.ts', "import { rmSync } from 'node:fs';\nrmSync('/tmp/customer-data', { recursive: true, force: true });\n"),
    evidence: ['negativeEvidence', 'riskSignals']
  },
  {
    name: 'Multiline unguarded destructive delete', scripts: { test: passingTest }, expected: ['REJECT', 'HIGH'],
    change: (repo) => write(repo, 'src/cleanup.ts', "import { rmSync } from 'node:fs';\nrmSync('/tmp/customer-data', {\n  recursive: true,\n  force: true\n});\n"),
    evidence: ['negativeEvidence', 'riskSignals']
  },
  {
    name: 'Ordinary code, no validation', scripts: {}, expected: ['REVIEW', 'MEDIUM'],
    change: (repo) => write(repo, 'src/format.ts', 'export const format = (value: string) => value.trim();\n'),
    evidence: ['uncertainty']
  }
];

const rows = [];
let errors = 0;
for (const item of cases) {
  const repo = fixture(item.scripts, item.packageText);
  try {
    item.change(repo);
    const result = run(process.execPath, [cli, repo, '--json'], repo, {
      env: { ...process.env, REVIEW_GATE_JEV_ADAPTER: '' }
    });
    if (result.error) throw result.error;
    const report = JSON.parse(result.stdout);
    if (report.error) throw new Error(report.error);
    const actual = [report.verdict, report.riskLevel];
    const missingEvidence = item.evidence.filter((bucket) => !Array.isArray(report.evidence?.[bucket]) || report.evidence[bucket].length === 0);
    const unexpectedEvidence = (item.absentEvidence ?? []).filter((bucket) => !Array.isArray(report.evidence?.[bucket]) || report.evidence[bucket].length !== 0);
    const expectedExit = { APPROVE: 0, REVIEW: 1, REJECT: 2 }[report.verdict];
    const pass = actual[0] === item.expected[0] && actual[1] === item.expected[1] && result.status === expectedExit && missingEvidence.length === 0 && unexpectedEvidence.length === 0;
    rows.push({ name: item.name, expected: item.expected, actual, pass, missingEvidence, unexpectedEvidence, exit: result.status });
  } catch (error) {
    errors++;
    rows.push({ name: item.name, expected: item.expected, actual: ['ERROR', '—'], pass: false, error: error.message });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const exact = rows.filter((row) => row.actual[0] === row.expected[0] && row.actual[1] === row.expected[1]).length;
const falseApprove = rows.filter((row) => row.actual[0] === 'APPROVE' && row.expected[0] !== 'APPROVE').length;
const falseReject = rows.filter((row) => row.actual[0] === 'REJECT' && row.expected[0] !== 'REJECT').length;
console.log(`Ground-truth benchmark (deterministic CLI, ${cases.length} disposable Git repositories)`);
console.log('Case | Expected | Actual | Result');
console.log('--- | --- | --- | ---');
for (const row of rows) {
  const detail = row.error ?? (row.missingEvidence?.length ? `missing evidence: ${row.missingEvidence.join(', ')}` : row.unexpectedEvidence?.length ? `unexpected evidence: ${row.unexpectedEvidence.join(', ')}` : `exit ${row.exit}`);
  console.log(`${row.name} | ${row.expected.join(' / ')} | ${row.actual.join(' / ')} | ${row.pass ? 'PASS' : `FAIL (${detail})`}`);
}
console.log(`Accuracy (exact verdict + risk): ${exact}/${rows.length} (${(100 * exact / rows.length).toFixed(1)}%)`);
console.log(`False APPROVE: ${falseApprove}`);
console.log(`False REJECT: ${falseReject}`);
if (errors || rows.some((row) => !row.pass) || falseApprove !== 0) process.exitCode = 1;
