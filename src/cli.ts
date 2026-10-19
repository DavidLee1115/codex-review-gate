#!/usr/bin/env node
import path from 'node:path';
import { inspect } from './inspect.js';
import { assessRisks } from './risk.js';
import { validate } from './validate.js';
import { triageJev } from './jev.js';
import { decide } from './verdict.js';
import { formatReport, reviewScope, recommendedNextStep } from './report.js';
import { sanitizeReport, sanitizeText } from './sanitize.js';
import type { ChangedFile, Report, Risk } from './types.js';

function changedDuringValidation(before: ChangedFile[], after: ChangedFile[]): string[] {
  const left = new Map(before.map((f) => [f.path, JSON.stringify(f)]));
  const right = new Map(after.map((f) => [f.path, JSON.stringify(f)]));
  return [...new Set([...left.keys(), ...right.keys()])].filter((file) => left.get(file) !== right.get(file));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: review-gate [repository] [--json]\n       review-gate --help\nRepository defaults to the current directory.\nExit codes: 0 APPROVE, 1 REVIEW, 2 REJECT, 3 input/tool error.\n' + reviewScope + '\nUse before commit for worktree diff review; use local-app-release-gate for runtime acceptance. Existing npm scripts run in the target repository.');
    return;
  }
  const positional = args.filter((arg) => !arg.startsWith('-'));
  if (positional.length > 1 || args.some((arg) => arg.startsWith('-') && arg !== '--json')) throw new Error('Usage: review-gate [repository] [--json]');
  const target = path.resolve(positional[0] ?? '.');
  const before = await inspect(target);
  const validations = await validate(before.repository);
  const inspection = validations.some((v) => v.command) ? await inspect(before.repository) : before;
  const sideEffects = changedDuringValidation(before.files, inspection.files);
  const risks: Risk[] = assessRisks(inspection.files);
  if (sideEffects.length) risks.push({ level: 'MEDIUM', category: 'validation-worktree-change', reason: `Validation scripts changed the worktree: ${sideEffects.slice(0, 10).join(', ')}`, file: '(repository)', humanReviewItem: 'Inspect the validation-generated edits and rerun the gate on the resulting worktree.' });
  const jev = await triageJev(inspection.repository, inspection.files, risks);
  const decision = decide(inspection.files, risks, validations, jev);
  const changedFiles = inspection.files.map(({ patch: _patch, ...file }) => file);
  const report: Report = {
    schemaVersion: 4,
    reviewScope,
    recommendedNextStep: recommendedNextStep(decision.verdict),
    repository: inspection.repository,
    branch: inspection.branch,
    head: inspection.head,
    changedFiles,
    diffStats: {
      additions: inspection.files.reduce((n, f) => n + f.additions, 0),
      deletions: inspection.files.reduce((n, f) => n + f.deletions, 0),
      files: inspection.files.length,
      truncated: inspection.diffTruncated
    },
    projectFiles: inspection.projectFiles,
    validations,
    risks,
    evidence: decision.evidence,
    jev,
    verdict: decision.verdict,
    riskLevel: decision.riskLevel,
    importantChanges: inspection.files.slice(0, 20).map((f) => `${f.status} ${f.path} (+${f.additions}/-${f.deletions})`),
    humanReviewItems: decision.humanReviewItems
  };
  const publicReport = sanitizeReport(report, inspection.repository);
  console.log(json ? JSON.stringify(publicReport, null, 2) : formatReport(publicReport));
  process.exitCode = report.verdict === 'APPROVE' ? 0 : report.verdict === 'REVIEW' ? 1 : 2;
}

main().catch((error: unknown) => {
  const message = sanitizeText(error instanceof Error ? error.message : String(error));
  if (process.argv.includes('--json')) console.log(JSON.stringify({ error: message }));
  else console.error(`review-gate: ${message}`);
  process.exitCode = 3;
});
