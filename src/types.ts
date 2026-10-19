export type Verdict = 'APPROVE' | 'REVIEW' | 'REJECT';
export type Level = 'LOW' | 'MEDIUM' | 'HIGH';
export type ValidationStatus = 'PASS' | 'FAIL' | 'SKIP' | 'BLOCKED' | 'NOT_RUN';

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  oldPath?: string;
  staged: boolean;
  unstaged: boolean;
  additions: number;
  deletions: number;
  binary: boolean;
  diffTruncated: boolean;
  patch: string;
}
export interface Validation {
  name: string;
  command: string | null;
  status: ValidationStatus;
  executed: boolean;
  reason: string;
  outputTruncated: boolean;
  exitCode: number | null;
  durationMs: number;
  errors: string[];
}
export interface Risk {
  level: Level;
  category: string;
  reason: string;
  file: string;
  humanReviewItem: string;
  severe?: boolean;
}
export interface EvidenceItem {
  source: 'validation' | 'deterministic' | 'jev';
  detail: string;
  file?: string;
}
export interface EvidenceModel {
  positiveEvidence: EvidenceItem[];
  negativeEvidence: EvidenceItem[];
  uncertainty: EvidenceItem[];
  riskSignals: EvidenceItem[];
}
export interface JevResult {
  status: 'available' | 'not_requested' | 'failed';
  source: string | null;
  labels: string[];
  reviewPaths: string[];
  omittedPaths: string[];
  recommendation: Verdict | null;
  reason: string;
  disagreement: boolean;
}
export interface Report {
  schemaVersion: 4;
  reviewScope: string;
  recommendedNextStep: string;
  repository: string;
  branch: string;
  head: string | null;
  changedFiles: Omit<ChangedFile, 'patch'>[];
  diffStats: { additions: number; deletions: number; files: number; truncated: boolean };
  projectFiles: string[];
  validations: Validation[];
  risks: Risk[];
  evidence: EvidenceModel;
  jev: JevResult;
  verdict: Verdict;
  riskLevel: Level;
  importantChanges: string[];
  humanReviewItems: string[];
}
