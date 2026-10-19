import { spawn } from 'node:child_process';

export interface RunResult { code: number | null; stdout: string; stderr: string; durationMs: number; truncated: boolean; timedOut: boolean; spawned: boolean; spawnError: string | null }

export async function run(file: string, args: string[], cwd: string, options: { timeoutMs?: number; maxBytes?: number; input?: string } = {}): Promise<RunResult> {
  const started = Date.now();
  const maxBytes = options.maxBytes ?? 2_000_000;
  return new Promise((resolve) => {
    let stdout = ''; let stderr = ''; let bytes = 0; let truncated = false; let timedOut = false; let settled = false; let spawned = false;
    const child = spawn(file, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CI: '1', npm_config_update_notifier: 'false' } });
    const add = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const remaining = Math.max(0, maxBytes - bytes);
      const text = chunk.subarray(0, remaining).toString('utf8');
      if (stream === 'stdout') stdout += text; else stderr += text;
      bytes += chunk.length;
      if (bytes > maxBytes) truncated = true;
    };
    child.stdout.on('data', (b: Buffer) => add('stdout', b));
    child.stderr.on('data', (b: Buffer) => add('stderr', b));
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1_000).unref(); }, options.timeoutMs ?? 120_000);
    const done = (code: number | null, error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) stderr += `\n${error.message}`;
      resolve({ code, stdout, stderr, durationMs: Date.now() - started, truncated, timedOut, spawned, spawnError: error ? (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' : null });
    };
    child.on('error', (error) => done(null, error));
    child.on('spawn', () => { spawned = true; });
    child.on('close', (code) => done(code));
  });
}
