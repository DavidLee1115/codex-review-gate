import type { Report } from './types.js';

export const reviewScope = 'Worktree code/diff risk review plus declared npm engineering checks only. Review Gate APPROVE does not equal Release Gate PASS; startup, browser, exports, restore, external services, UX and market value are not verified by this gate.';

export function recommendedNextStep(verdict: Report['verdict']): string {
  if (verdict === 'REJECT') return 'Inspect and resolve the negative evidence, then rerun code review. For a release candidate, separately run local-app-release-gate against its declared runtime acceptance scope.';
  if (verdict === 'REVIEW') return 'Complete the required human review and missing or blocked validation, then rerun code review. Use local-app-release-gate for startup, browser, restore and export acceptance.';
  return 'The current code review scope supports approval. If preparing an app release, use local-app-release-gate for runtime acceptance; human UX and market validation remain separate.';
}

export function formatReport(report: Report): string {
  const lines = [
    'REVIEW GATE',
    `Repository: ${report.repository}`,
    `Branch: ${report.branch}`,
    `HEAD: ${report.head ?? '(unborn)'}`,
    `Files changed: ${report.diffStats.files}`,
    `Lines + / -: ${report.diffStats.additions} / ${report.diffStats.deletions}`,
    '',
    `VERDICT: ${report.verdict}`,
    `RISK: ${report.riskLevel}`,
    `SCOPE: ${report.reviewScope}`,
    '',
    'VALIDATION'
  ];
  for (const item of report.validations) {
    const icon = item.status === 'PASS' ? '✓' : item.status === 'FAIL' ? '✗' : '–';
    lines.push(`${icon} ${item.name}: ${item.status} (executed: ${item.executed}, exit: ${item.exitCode ?? 'n/a'}${item.command ? `, ${item.command}, ${item.durationMs} ms` : ''})`);
    lines.push(`    ${item.reason}`);
    for (const error of item.errors) lines.push(`    ${error}`);
  }
  lines.push('', 'MISSING / BLOCKED VALIDATION');
  const missing = report.validations.filter((v) => v.status === 'NOT_RUN' || v.status === 'BLOCKED');
  lines.push(...(missing.length ? missing.map((v) => `- ${v.name}: ${v.status} — ${v.reason}`) : ['- None in discovered checks; see scope limitations.']));
  lines.push('', 'IMPORTANT CHANGES');
  lines.push(...(report.importantChanges.length ? report.importantChanges.map((s) => `- ${s}`) : ['- None']));
  lines.push('', 'RISKS');
  lines.push(...(report.risks.length ? report.risks.map((r) => `- ${r.level} ${r.file}: ${r.reason}`) : ['- None detected']));
  lines.push('', 'EVIDENCE');
  for (const [heading, entries] of [
    ['Positive evidence', report.evidence.positiveEvidence],
    ['Negative evidence', report.evidence.negativeEvidence],
    ['Uncertainty', report.evidence.uncertainty],
    ['Risk signals', report.evidence.riskSignals]
  ] as const) {
    lines.push(`${heading}:`);
    lines.push(...(entries.length ? entries.map((e) => `- [${e.source}]${e.file ? ` ${e.file}:` : ''} ${e.detail}`) : ['- None']));
  }
  lines.push('', report.jev.status === 'available' ? 'JEV ADAPTER RESULT' : report.jev.status === 'failed' ? 'JEV ADAPTER FAILED' : 'JEV ADAPTER NOT USED');
  lines.push(`- ${report.jev.reason}`);
  if (report.jev.labels.length) lines.push(`- Labels: ${report.jev.labels.join(', ')}`);
  if (report.jev.recommendation) lines.push(`- Recommendation: ${report.jev.recommendation}`);
  if (report.jev.reviewPaths.length) lines.push(`- Review paths: ${report.jev.reviewPaths.join(', ')}`);
  if (report.jev.omittedPaths.length) lines.push(`- Patch omitted for sensitive paths: ${report.jev.omittedPaths.join(', ')}`);
  lines.push('', 'REQUIRED HUMAN ACTION');
  lines.push(...(report.humanReviewItems.length ? report.humanReviewItems.map((s, i) => `${i + 1}. ${s}`) : ['None.']));
  lines.push('', 'RECOMMENDED NEXT STEP', report.recommendedNextStep);
  return lines.join('\n');
}
