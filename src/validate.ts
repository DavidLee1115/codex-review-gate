import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from './process.js';
import type { Validation } from './types.js';

const names = ['test', 'lint', 'typecheck', 'build', 'verify'] as const;

function conciseErrors(output: string): string[] {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const selected = lines.filter((line) => /error|fail|fatal|exception|not found|timed out|cannot|✗|✖/i.test(line));
  return (selected.length ? selected.slice(-6) : lines.slice(-4)).map((line) => line
    .replace(/\b(password|api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[REDACTED]')
    .slice(0, 240));
}

// Classify runner limits separately from command failures. A shell launch error
// needs both its reserved exit code and a diagnostic; arbitrary test text is not
// enough to erase failing evidence.
export function validationResult(name: string, command: string, result: import('./process.js').RunResult): Validation {
  let status: Validation['status'];
  let reason: string;
  const shellUnavailable = (result.code === 127 && /(?:^|\n)(?:.*sh:|env:).*?(?:not found|No such file or directory)/i.test(result.stderr))
    || (result.code === 126 && /(?:^|\n)(?:.*sh:|env:).*?(?:Permission denied|cannot execute)/i.test(result.stderr));
  if (result.spawnError || !result.spawned) {
    status = 'BLOCKED'; reason = `Validation process could not start (${result.spawnError ?? 'unknown launch error'})`;
  } else if (shellUnavailable) {
    status = 'BLOCKED'; reason = 'The script launcher could not find or execute a required tool; check dependencies and permissions';
  } else if (result.timedOut || result.code === null) {
    status = 'BLOCKED'; reason = 'Validation did not complete: timeout or process termination';
  } else if (result.code !== 0) {
    status = 'FAIL'; reason = 'Validation command completed with a nonzero exit; inspect errors to determine the cause, not necessarily a regression';
  } else if (result.truncated) {
    status = 'BLOCKED'; reason = 'Command exited zero but the runner could not retain complete output (128 KB limit)';
  } else {
    status = 'PASS'; reason = 'Validation command actually completed with exit 0; assertions and coverage depend on the declared script';
  }
  const errors = status === 'PASS' ? [] : conciseErrors(`${result.stdout}\n${result.stderr}`);
  return { name, command, status, executed: result.spawned, reason, outputTruncated: result.truncated, exitCode: result.code, durationMs: result.durationMs, errors };
}

export async function validate(repository: string): Promise<Validation[]> {
  let scripts: Record<string, unknown> = {};
  const unavailable = (name: string, status: 'NOT_RUN' | 'BLOCKED', reason: string): Validation => ({
    name, command: null, status, executed: false, reason, outputTruncated: false, exitCode: null, durationMs: 0, errors: []
  });
  try {
    const contents = await readFile(path.join(repository, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(contents);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid manifest');
    if ('scripts' in parsed) {
      if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) throw new Error('Invalid scripts');
      scripts = parsed.scripts as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return names.map((name) => unavailable(name, 'NOT_RUN', 'No root package.json; this CLI does not discover or execute Python or other non-Node validators'));
    }
    return names.map((name) => unavailable(name, 'BLOCKED', 'Project manifest package.json could not be read or parsed, or scripts configuration is invalid'));
  }
  const results: Validation[] = [];
  for (const name of names) {
    if (!Object.hasOwn(scripts, name)) {
      results.push(unavailable(name, 'NOT_RUN', `No root npm ${name} script is configured; applicability is unknown`));
      continue;
    }
    if (typeof scripts[name] !== 'string' || !(scripts[name] as string).trim()) {
      results.push(unavailable(name, 'BLOCKED', `Configured npm ${name} script is not a nonempty string`));
      continue;
    }
    const result = await run('npm', ['run', name, '--silent'], repository, { timeoutMs: 120_000, maxBytes: 128_000 });
    results.push(validationResult(name, `npm run ${name}`, result));
  }
  return results;
}
