import { run } from './process.js';
import path from 'node:path';
import type { ChangedFile, JevResult, Risk } from './types.js';

export async function triageJev(repository: string, files: ChangedFile[], risks: Risk[]): Promise<JevResult> {
  const executable = process.env.REVIEW_GATE_JEV_ADAPTER;
  const omittedPaths = files.filter((file) => risks.some((risk) => risk.file === file.path && (risk.category === 'secrets' || risk.category === 'secret-exposure'))).map((file) => file.path);
  if (!executable) return { status: 'not_requested', source: null, labels: [], reviewPaths: [], omittedPaths: [], recommendation: null, reason: 'CLI Jev adapter was not requested; set REVIEW_GATE_JEV_ADAPTER to opt in.', disagreement: false };
  const source = path.basename(executable);
  const input = JSON.stringify({ schemaVersion: 1, repository, files: files.map((f) => ({ path: f.path, status: f.status, patch: omittedPaths.includes(f.path) ? null : f.patch.slice(0, 12_000), patchOmitted: omittedPaths.includes(f.path) })), deterministicRisks: risks.map((r) => ({ file: r.file, level: r.level, category: r.category })) });
  const result = await run(executable, [], repository, { timeoutMs: 30_000, maxBytes: 64_000, input });
  if (result.code !== 0 || result.timedOut || result.truncated) return { status: 'failed', source, labels: [], reviewPaths: [], omittedPaths, recommendation: null, reason: result.timedOut ? 'Jev adapter timed out; skipped.' : 'Jev adapter failed; skipped.', disagreement: false };
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    const value = parsed as Record<string, unknown>;
    if (!Array.isArray(value.labels) || !Array.isArray(value.reviewPaths)) throw new Error('invalid schema');
    const paths = new Set(files.map((f) => f.path));
    const labels = value.labels.filter((x): x is string => typeof x === 'string').slice(0, 20).map((x) => x.replace(/[\r\n]/g, ' ').slice(0, 100));
    const reviewPaths = value.reviewPaths.filter((x): x is string => typeof x === 'string' && paths.has(x)).slice(0, 20);
    const recommendation = value.recommendation === 'APPROVE' || value.recommendation === 'REVIEW' || value.recommendation === 'REJECT' ? value.recommendation : null;
    const disagreement = recommendation === 'APPROVE' && risks.some((r) => r.level !== 'LOW');
    return { status: 'available', source, labels, reviewPaths, omittedPaths, recommendation, reason: typeof value.reason === 'string' ? value.reason.replace(/[\r\n]/g, ' ').slice(0, 300) : 'Jev triage completed.', disagreement };
  } catch {
    return { status: 'failed', source, labels: [], reviewPaths: [], omittedPaths, recommendation: null, reason: 'Jev adapter returned invalid JSON; skipped.', disagreement: false };
  }
}
