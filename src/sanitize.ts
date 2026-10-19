import { homedir } from 'node:os';
import path from 'node:path';
import type { Report } from './types.js';

export function sanitizeText(value: string, repository?: string): string {
  let result = value.replace(/[\x00-\x1f]+/g, ' ');
  if (repository) result = result.replaceAll(repository, '[repository]');
  const home = homedir();
  if (home) result = result.replaceAll(home, '[home]');
  return result
    .replace(/\/(?:Users|Volumes|private|var|tmp|etc|opt|Applications|Library)(?:\/[^\s:'")\]}]*)?/g, '[path]')
    .replace(/\b[A-Za-z]:\\[^\s:'")\]}]*/g, '[path]')
    .replace(/\b(password|api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
}

export function sanitizeReport(report: Report, repository: string): Report {
  const safe = JSON.parse(JSON.stringify(report, (_key, value: unknown) => typeof value === 'string' ? sanitizeText(value, repository) : value)) as Report;
  safe.repository = sanitizeText(path.basename(repository));
  return safe;
}
