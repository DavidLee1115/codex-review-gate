import { readFile, readdir, lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { run } from './process.js';
import type { ChangedFile } from './types.js';

const projectNames = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Makefile', 'Gemfile', 'pom.xml', 'build.gradle', 'CMakeLists.txt']);

async function git(cwd: string, args: string[], maxBytes = 8_000_000) {
  return run('git', ['-c', 'core.quotePath=false', ...args], cwd, { timeoutMs: 30_000, maxBytes });
}

function stats(patch: string): { additions: number; deletions: number; binary: boolean } {
  let additions = 0; let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions, binary: /(?:Binary files .* differ|GIT binary patch)/.test(patch) };
}

function statusName(x: string, y: string): ChangedFile['status'] {
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflicted';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'R' || y === 'R' || x === 'C' || y === 'C') return 'renamed';
  if (x === 'A' || y === 'A') return 'added';
  return 'modified';
}

export interface Inspection { repository: string; branch: string; head: string | null; files: ChangedFile[]; projectFiles: string[]; diffTruncated: boolean }

export async function inspect(target: string): Promise<Inspection> {
  const start = path.resolve(target);
  try {
    if (!(await stat(start)).isDirectory()) throw new Error('Repository path is not a directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Repository path does not exist');
    throw error;
  }
  const rootResult = await git(start, ['rev-parse', '--show-toplevel']);
  if (rootResult.code !== 0) throw new Error('Not a Git repository');
  const repository = rootResult.stdout.trim();
  const [status, branch, head, entries] = await Promise.all([
    git(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(repository, ['symbolic-ref', '--short', '-q', 'HEAD']),
    git(repository, ['rev-parse', '--verify', 'HEAD']),
    readdir(repository)
  ]);
  if (status.code !== 0 || status.truncated) throw new Error('Unable to read complete Git status');
  const projectFiles = entries.filter((name) => projectNames.has(name)).sort();
  const pieces = status.stdout.split('\0');
  const files: ChangedFile[] = [];
  let diffTruncated = false;
  for (let i = 0; i < pieces.length; i++) {
    const record = pieces[i];
    if (!record) continue;
    const x = record[0] ?? ' '; const y = record[1] ?? ' ';
    const filePath = record.slice(3);
    const oldPath = x === 'R' || y === 'R' || x === 'C' || y === 'C' ? pieces[++i] : undefined;
    const statusType = statusName(x, y);
    let patch = ''; let truncated = false; let binary = false;
    if (statusType === 'untracked') {
      const absolute = path.resolve(repository, filePath);
      if (!absolute.startsWith(repository + path.sep)) throw new Error(`Unsafe path from Git status: ${filePath}`);
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) { binary = true; }
      else if (info.size > 512_000) { truncated = true; }
      else {
        const data = await readFile(absolute);
        if (data.includes(0)) binary = true;
        else {
          const lines = data.toString('utf8').split('\n');
          if (lines.at(-1) === '') lines.pop();
          patch = lines.map((line) => `+${line}`).join('\n');
        }
      }
    } else {
      const [staged, unstaged] = await Promise.all([
        git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--unified=0', '--cached', '--', filePath]),
        git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--unified=0', '--', filePath])
      ]);
      if (staged.code !== 0 || unstaged.code !== 0) throw new Error(`Unable to read staged and unstaged diff for ${filePath}`);
      patch = staged.stdout + unstaged.stdout;
      truncated = staged.truncated || unstaged.truncated;
    }
    const count = stats(patch);
    files.push({ path: filePath, oldPath, status: statusType, staged: x !== ' ' && x !== '?', unstaged: y !== ' ' || statusType === 'untracked', additions: count.additions, deletions: count.deletions, binary: binary || count.binary, diffTruncated: truncated, patch });
    diffTruncated ||= truncated;
  }
  return { repository, branch: branch.code === 0 ? branch.stdout.trim() : '(detached HEAD)', head: head.code === 0 ? head.stdout.trim() : null, files, projectFiles, diffTruncated };
}
