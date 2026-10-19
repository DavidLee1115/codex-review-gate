import type { ChangedFile, EvidenceModel, JevResult, Level, Risk, Validation, Verdict } from './types.js';

const order: Record<Level, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const presentationPath = /(?:^|\/)(?:README(?:\..*)?|.*\.(?:md|mdx|txt|rst|css|scss|less))$/i;

export function decide(files: ChangedFile[], risks: Risk[], validations: Validation[], jev: JevResult): { verdict: Verdict; riskLevel: Level; humanReviewItems: string[]; evidence: EvidenceModel } {
  let riskLevel: Level = 'LOW';
  for (const risk of risks) if (order[risk.level] > order[riskLevel]) riskLevel = risk.level;
  const evidence: EvidenceModel = { positiveEvidence: [], negativeEvidence: [], uncertainty: [], riskSignals: [] };
  const items = risks.filter((r) => r.level !== 'LOW').map((r) => `${r.file}: ${r.humanReviewItem}`);
  const failed = validations.filter((v) => v.status === 'FAIL');
  const validationBlocked = validations.some((v) => v.status === 'BLOCKED');
  for (const validation of validations) {
    if (validation.status === 'PASS') evidence.positiveEvidence.push({ source: 'validation', detail: `${validation.name} passed: ${validation.command}; command exit 0, coverage depends on the script` });
    if (validation.status === 'FAIL') {
      evidence.negativeEvidence.push({ source: 'validation', detail: `${validation.name} failed: ${validation.command}` });
      items.push(`Inspect errors and fix or attribute the failure, then rerun ${validation.command ?? validation.name}.`);
    }
  }
  for (const validation of validations.filter((v) => v.status === 'BLOCKED' || v.status === 'NOT_RUN')) {
    evidence.uncertainty.push({ source: 'validation', detail: `${validation.name} ${validation.status}: ${validation.reason}` });
    if (validation.status === 'BLOCKED') items.push(`Unblock ${validation.command ?? validation.name}: ${validation.reason}; rerun the check.`);
  }
  for (const risk of risks) {
    const entry = { source: 'deterministic' as const, detail: `${risk.level} ${risk.category}: ${risk.reason}`, file: risk.file };
    evidence.riskSignals.push(entry);
    if (risk.severe) evidence.negativeEvidence.push(entry);
    if (risk.category === 'uninspected-content' || risk.category === 'validation-worktree-change') evidence.uncertainty.push(entry);
  }
  const noTest = validations.find((v) => v.name === 'test')?.status !== 'PASS';
  const presentationOnly = files.length > 0 && files.every((f) => presentationPath.test(f.path) && (!f.oldPath || presentationPath.test(f.oldPath)));
  if (presentationOnly && riskLevel === 'LOW') evidence.positiveEvidence.push({ source: 'deterministic', detail: 'Only documentation or styling files changed' });
  if (noTest && !presentationOnly && !failed.some((v) => v.name === 'test')) {
    evidence.uncertainty.push({ source: 'validation', detail: 'No passing test was discovered for changed behavior' });
    items.push('Run or add a relevant test for the changed behavior; no passing test script was discovered.');
  }
  if (jev.status === 'available') {
    if (jev.disagreement) items.push('Resolve the difference between Jev triage and deterministic risk rules.');
    if (jev.recommendation === 'REVIEW' || jev.recommendation === 'REJECT') {
      evidence.riskSignals.push({ source: 'jev', detail: `Second opinion ${jev.recommendation}: ${jev.reason}` });
      items.push(`Inspect the change flagged by Jev for ${jev.recommendation}: ${jev.reason}`);
    }
    for (const file of jev.reviewPaths) {
      evidence.riskSignals.push({ source: 'jev', detail: 'Jev prioritized this path for human review', file });
      const focus = risks.find((r) => r.file === file && r.level === 'HIGH') ?? risks.find((r) => r.file === file);
      const existing = focus ? `${file}: ${focus.humanReviewItem}` : null;
      if (existing) {
        const index = items.indexOf(existing);
        if (index >= 0) items.splice(index, 1);
      }
      items.unshift(`${file}: Jev prioritized this file; ${focus?.humanReviewItem ?? 'inspect the changed behavior.'}`);
    }
    for (const label of jev.labels) evidence.riskSignals.push({ source: 'jev', detail: `Jev label: ${label}` });
    if (jev.labels.some((x) => /high|critical|security|review/i.test(x))) items.push(`Inspect changes flagged by Jev: ${jev.labels.join(', ')}.`);
  }
  if (files.length === 0) {
    evidence.uncertainty.push({ source: 'deterministic', detail: 'No changed files to assess' });
    items.push('Provide a worktree diff for code review; use Release Gate for runtime acceptance of an existing candidate.');
  }
  const size = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (size >= 500 || files.length >= 20) {
    evidence.uncertainty.push({ source: 'deterministic', detail: 'Change exceeds the large-diff review threshold' });
    items.push('Review the change in smaller sections because the diff is large.');
  }
  const jevReview = jev.status === 'available' && (jev.disagreement || jev.recommendation === 'REVIEW' || jev.recommendation === 'REJECT' || jev.reviewPaths.length > 0 || jev.labels.some((x) => /high|critical|security|review/i.test(x)));
  let verdict: Verdict = 'APPROVE';
  if (evidence.negativeEvidence.length) verdict = 'REJECT';
  else if (riskLevel !== 'LOW' || validationBlocked || (!presentationOnly && noTest) || files.length === 0 || size >= 500 || files.length >= 20 || jevReview) verdict = 'REVIEW';
  const unique = [...new Set(items)];
  if (verdict !== 'APPROVE' && unique.length === 0) unique.push('Inspect the changed files and confirm the behavior is intended.');
  return { verdict, riskLevel, humanReviewItems: unique, evidence };
}
