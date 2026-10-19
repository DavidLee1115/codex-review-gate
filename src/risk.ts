import type { ChangedFile, Level, Risk } from './types.js';

interface Rule { category: string; level: Level; path?: RegExp; code?: RegExp; reason: string; item: string; severe?: boolean }
const rules: Rule[] = [
  { category: 'authentication', level: 'HIGH', path: /(?:^|[\/._-])(auth|oauth|login|session|authorization)(?:[\/._-]|$)/i, reason: 'Authentication or authorization file changed', item: 'Check access decisions, session handling, and unauthorized-user cases.' },
  { category: 'permissions', level: 'HIGH', path: /(?:^|[\/._-])(permission|acl|rbac|policy)(?:[\/._-]|$)/i, reason: 'Permissions or policy file changed', item: 'Verify the least-privilege behavior for existing and new users.' },
  { category: 'secrets', level: 'HIGH', path: /(?:^|\/)(\.env(?:\..*)?|.*(?:secret|credential|private.?key).*)$/i, reason: 'Secret or credential file changed', item: 'Check that no credentials are exposed and rotation is handled if needed.' },
  { category: 'database-schema', level: 'HIGH', path: /(?:^|\/)(migrations?|schema)(?:\/|[._-])/i, reason: 'Database schema or migration changed', item: 'Verify migration compatibility, rollback, and existing-data safety.' },
  { category: 'payments', level: 'HIGH', path: /(?:^|[\/._-])(payment|billing|invoice|checkout)(?:[\/._-]|$)/i, reason: 'Payment or billing code changed', item: 'Check amount calculation, duplicate charges, and failure handling.' },
  { category: 'deployment', level: 'HIGH', path: /(?:^|\/)(\.github\/workflows\/|Dockerfile|docker-compose|\.gitlab-ci|.*deploy.*|.*terraform.*|.*\.tf$)/i, reason: 'Deployment or CI configuration changed', item: 'Check release permissions, environment selection, and deployment side effects.' },
  { category: 'destructive-delete', level: 'HIGH', code: /^\+.*(?:\b(?:rmSync|rmdirSync|unlinkSync|shutil\.rmtree|os\.remove|os\.unlink)\b|\b(?:fs\.|Path\.)?(?:rm|unlink|rmdir)\s*\(|\bDROP\s+(?:TABLE|DATABASE)\b|\bDELETE\s+FROM\b)/im, reason: 'Destructive delete operation added', item: 'Confirm the delete target, safeguards, and recovery path.' },
  { category: 'filesystem-write', level: 'HIGH', code: /^\+.*(?:\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|mkdir(?:Sync)?|rename(?:Sync)?|shutil\.move|write_text|write_bytes)\b|\bopen\([^\n]*['"](?:w|a|x)[bt]?['"])/im, reason: 'Filesystem write operation added', item: 'Check destination path, overwrite behavior, and recovery from a partial write.' },
  { category: 'shell-execution', level: 'HIGH', code: /^\+.*(?:\b(?:child_process|execSync|spawnSync|subprocess\.(?:run|Popen|call)|os\.system)\b|\b(?:exec|spawn|execFile)\s*\(|\bshell\s*:\s*true\b)/im, reason: 'Shell or subprocess execution added', item: 'Check command arguments, input handling, and execution scope.' },
  { category: 'external-network', level: 'HIGH', code: /^\+.*(?:\b(?:fetch|https?\.request|requests\.(?:get|post|put|delete))\s*\(|\b(?:axios\.|urllib\.request|http\.Client)\b)/im, reason: 'External network or API call added', item: 'Check destinations, data sent, timeouts, and error handling.' },
  { category: 'persistence', level: 'MEDIUM', path: /(?:^|[\/._-])(storage|persist|sqlite|localstorage)(?:[\/._-]|$)/i, reason: 'Persistence code changed', item: 'Check existing-data compatibility and failure behavior.' },
  { category: 'backup-restore', level: 'MEDIUM', path: /(?:^|[\/._-])(backup|restore|import|export)(?:[\/._-]|$)/i, reason: 'Import, export, backup, or restore code changed', item: 'Check overwrite behavior and round-trip data integrity.' },
  { category: 'parsing-validation', level: 'MEDIUM', path: /(?:^|[\/._-])(parse|parser|validation|validator)(?:[\/._-]|$)/i, reason: 'Parsing or validation code changed', item: 'Check malformed-input and boundary cases.' },
  { category: 'public-api', level: 'MEDIUM', path: /(?:^|[\/._-])(api|routes?|handlers?)(?:[\/._-]|$)/i, reason: 'Public API or route changed', item: 'Check callers, response shape, and backward compatibility.' },
  { category: 'state-management', level: 'MEDIUM', path: /(?:^|[\/._-])(state|store|reducer)(?:[\/._-]|$)/i, reason: 'State management changed', item: 'Check transitions, persistence, and stale-state behavior.' },
  { category: 'configuration', level: 'MEDIUM', path: /(?:^|\/)(.*\.config\.[\w]+|config\.(?:json|ya?ml|toml)|tsconfig\.json)$/i, reason: 'Configuration changed', item: 'Check defaults and behavior in existing environments.' },
  { category: 'error-handling', level: 'MEDIUM', code: /^\+.*\b(?:catch\s*\(|except\s+|throw\s+|raise\s+)\b/m, reason: 'Error handling changed', item: 'Check that errors are surfaced and cleanup remains correct.' },
];

const lowPath = /(?:^|\/)(?:README(?:\..*)?|.*\.(?:md|mdx|txt|rst|css|scss|less))$/i;
const testPath = /(?:^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const codePath = /\.(?:[cm]?[jt]sx?|py|rs|go|java|sh|sql|rb|php|swift)$/i;

export function assessRisks(files: ChangedFile[]): Risk[] {
  const risks: Risk[] = [];
  for (const file of files) {
    const add = (risk: Omit<Risk, 'file'>) => {
      if (!risks.some((existing) => existing.file === file.path && existing.category === risk.category)) risks.push({ ...risk, file: file.path });
    };
    if (file.diffTruncated || file.binary) add({ level: 'HIGH', category: 'uninspected-content', reason: 'Diff could not be fully inspected', humanReviewItem: `Inspect the complete contents of ${file.path}.` });
    if (file.status === 'conflicted') add({ level: 'HIGH', category: 'merge-conflict', reason: 'Unresolved Git conflict', humanReviewItem: `Resolve the conflict in ${file.path} and rerun validation.`, severe: true });
    if (file.status === 'renamed') add({ level: 'MEDIUM', category: 'file-rename', reason: `File renamed from ${file.oldPath ?? 'an unknown path'}`, humanReviewItem: `Check references to ${file.oldPath ?? file.path} and the effect of its new location.` });
    if (/^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(file.path) && file.additions + file.deletions >= 500) {
      add({ level: 'HIGH', category: 'large-lockfile', reason: 'Large package lockfile change', humanReviewItem: 'Check dependency changes and lockfile integrity.' });
    }
    const low = lowPath.test(file.path);
    const code = codePath.test(file.path) || /(?:^|\/)package\.json$/.test(file.path);
    const changedLines = file.patch.split('\n').filter((line) => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))).join('\n');
    const addedText = file.patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1)).join('\n');
    const writeCalls = [...new Set([...changedLines.matchAll(/^\+.*?\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|write_text|write_bytes|mkdirSync|mkdir)\s*\(/gm)].map((m) => m[1]))];
    const writeFlags = ['--output', '--record'].filter((flag) => addedText.includes(flag));
    const publicationChecks = addedText.includes('published_at') && addedText.includes('publication_url');
    const creatorIdChecks = addedText.includes('creator_id') && addedText.includes('channel_id') && addedText.includes('uploader_id');
    // The hard rule needs an explicit destructive target. Variable targets and
    // other delete APIs remain HIGH risk for human review.
    const literalRecursiveDelete = [...addedText.matchAll(/\b(?:rmSync|rmdirSync|shutil\.rmtree|fs\.rm|fs\.rmSync)\s*\(\s*['"][^'"]+['"]([\s\S]{0,400}?)\)/gm)].some((match) => /\brecursive\s*(?::|=)\s*(?:true|True)\b/.test(match[1] ?? ''));
    const explicitDelete = /\bDROP\s+(?:TABLE|DATABASE)\s+[\w"`]+/i.test(addedText) || literalRecursiveDelete;
    const visibleGuard = /^\+.*\b(?:allowlist|allowedRoot|assertSafe|validateDeleteTarget|safeDeleteTarget|dryRun|confirmDeletion)\b/im.test(changedLines);
    if (!low && code && explicitDelete && !visibleGuard) {
      add({ level: 'HIGH', category: 'explicit-destructive-target', reason: 'Recursive delete of a literal target or schema drop added without a visible guard', humanReviewItem: 'Remove the destructive operation or establish a verified target guard and recovery path.', severe: true });
    }
    if (/^\+.*(?:\b(?:password|api[_-]?key|secret|access[_-]?token)\b\s*[:=]\s*['"][^'"\s]{8,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/im.test(changedLines)) {
      add({ level: 'HIGH', category: 'secret-exposure', reason: low ? 'Credential-like literal added to documentation or styling' : 'Possible credential literal added', humanReviewItem: 'Verify the credential is not real; rotate it if it was exposed.', severe: !low });
    }
    const manifest = /(?:^|\/)(?:package\.json|Cargo\.toml|go\.mod|requirements\.txt|pyproject\.toml)$/i.test(file.path);
    const dependencyLine = /^\+.*(?:"(?:dependencies|devDependencies|optionalDependencies)"|"(?!name"|version"|type"|private"|engines"|scripts")[\w@/.-]+"\s*:\s*"[\^~]?\d|\b(?:require\s+[^\s]+|[\w.-]+\s*(?:==|>=|~=)\s*\d))/im.test(changedLines);
    if (manifest && dependencyLine) add({ level: 'HIGH', category: 'dependency', reason: 'Dependency declaration changed', humanReviewItem: 'Review new dependency provenance, versions, and install scripts.' });
    else if (manifest) add({ level: 'MEDIUM', category: 'project-manifest', reason: 'Project manifest changed', humanReviewItem: 'Check changed scripts, configuration, and dependency metadata.' });
    for (const rule of rules) {
      if (rule.path?.test(file.path) || (file.oldPath && rule.path?.test(file.oldPath)) || (!low && code && rule.code?.test(changedLines))) {
        let humanReviewItem = rule.item;
        if (rule.category === 'filesystem-write' && writeCalls.length) humanReviewItem = `Inspect ${writeCalls.join(', ')} for ${writeFlags.length ? `${writeFlags.join(' / ')} ` : ''}destinations, overwrite behavior, and partial-write recovery.`;
        if (rule.category === 'error-handling' && /\b(?:CHECKPOINT_HOURS|checkpoints)\b/.test(addedText) && /\bmetrics\b/i.test(addedText)) humanReviewItem = 'Test T+1h / T+24h / T+72h checkpoint and metrics validation, invalid timestamps, and existing-record compatibility.';
        else if (rule.category === 'error-handling' && publicationChecks) humanReviewItem = 'Test published_at timezone and publication_url HTTPS host validation with invalid values and existing history.';
        add({ level: rule.level, category: rule.category, reason: rule.reason, humanReviewItem, severe: rule.severe });
      }
    }
    if (file.status === 'deleted' && !low) add({ level: 'MEDIUM', category: 'file-deletion', reason: 'Non-documentation file deleted', humanReviewItem: `Confirm removing ${file.path} does not break callers or data access.` });
    if (risks.every((risk) => risk.file !== file.path)) {
      if (low || testPath.test(file.path)) add({ level: 'LOW', category: low ? 'presentation-or-docs' : 'test-only', reason: low ? 'Documentation or styling changed' : 'Test or fixture changed', humanReviewItem: `Spot-check ${file.path}.` });
      else add({ level: 'MEDIUM', category: 'unclassified-code', reason: 'Code changed without a more specific risk rule', humanReviewItem: creatorIdChecks ? 'Check creator_id selection from channel_id / uploader_id in search and preflight, including same-name creators with different IDs.' : `Review behavior changed in ${file.path} and its callers.` });
    }
  }
  return risks;
}
