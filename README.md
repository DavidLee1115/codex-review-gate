# Codex Review Gate

A local CLI that inspects a Git worktree, runs validation scripts already declared by the repository, and produces an explainable `APPROVE`, `REVIEW`, or `REJECT` code review report. It does not use an LLM for its deterministic risk rules.

## Choose the gate

- Worktree code/diff or PR risk review: use this CLI **before committing**. It has no commit-range input; a clean tree returns REVIEW.
- Existing candidate startup, browser, persistence, restore or export acceptance: use a separate runtime acceptance tool such as `local-app-release-gate` with a reviewed profile. That tool is not included in this repository.
- Preparing an app release after code changes: retain both reports, tied to the reviewed diff and candidate source. **Review Gate APPROVE does not equal Release Gate PASS.**
- Plain documentation or one-off non-executable assets: neither gate is required; use Review Gate when the content itself warrants risk review.

**APPROVE is a rule-based review result, not a guarantee that code has no bugs or is safe to deploy.**

See [responsibility](REVIEW_GATE_RESPONSIBILITY.md) and [validation status semantics](VALIDATION_STATUS_SEMANTICS.md). Neither gate proves human UX acceptance or market value. An npm script may test runtime behavior, but this gate only attests its recorded command result, not application-wide coverage.

## Run

Requires Node.js 22 or newer, npm, and Git. Clone the source and install the locked development dependencies:

```sh
git clone https://github.com/DavidLee1115/codex-review-gate.git
cd codex-review-gate
npm ci
npm run demo
```

The demo prints three scenario summaries with the expected results shown below. To review your own trusted repository from this project directory:

```sh
npm run review -- /absolute/path/to/repository
npm run review -- /absolute/path/to/repository --json
```

After `npm run build`, `node dist/cli.js .` works directly. `npm link` is optional if you want the `review-gate .` command on your PATH; it is not required to use the CLI. The target repository's dependencies are not installed by Review Gate.

The process exits with `0` for APPROVE, `1` for REVIEW, `2` for REJECT, and `3` for an input or tool error. `--help` prints usage; JSON mode prints one JSON object to stdout, including `{ "error": "..." }` on an input/tool error. Schema version 4 includes `repository`, `branch`, `head`, `changedFiles`, `diffStats`, `projectFiles`, `validations`, `risks`, `evidence`, `jev`, `verdict`, `riskLevel`, `importantChanges`, `humanReviewItems`, `reviewScope`, and `recommendedNextStep`. `repository` is the repository name; absolute local paths are redacted from normal reports and errors. Evidence separates `positiveEvidence`, `negativeEvidence`, `uncertainty`, and `riskSignals`.

## What it checks

- Reads the current branch, HEAD, Git status, staged and unstaged diffs, and untracked files. Renames retain the old path for risk checks. Diff line counts are the sum of the staged and unstaged patches plus untracked text lines. Ignored files are outside this scope.
- Discovers root project markers including `package.json`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, and `Makefile`.
- For Node projects, runs only existing `test`, `lint`, `typecheck`, `build`, and `verify` scripts through `npm run`. Missing scripts and unsupported Python/non-Node discovery are `NOT_RUN`. Unreadable/invalid manifests and runner/tool limits are `BLOCKED`. `SKIP` is reserved for explicitly configured non-applicability; this CLI has no skip configuration and does not emit it. Each result records status, `executed`, `reason`, `outputTruncated`, exit code, duration, and short error excerpts. `executed` records the npm process starting, not every test inside it running. It never invents a Python, Rust, or Go command.
- Tags high, medium, and low risks with a file and a concrete reason. A completed failing validation command, a hardcoded credential-like literal in code, a merge conflict, or the explicit hard rule for a literal recursive delete or schema drop is negative evidence and yields REJECT. A credential-like example in documentation is REVIEW / HIGH. HIGH risk, unvalidated code, or a large change yields REVIEW unless negative evidence exists. Documentation or styling alone can be APPROVE / LOW without a test runner; a malformed `package.json` blocks that approval because validation discovery failed. HIGH risk and no tests remains REVIEW / HIGH. Jev output is a second opinion and cannot turn a hard failure into approval or reject by itself.

The inspection itself runs no Git mutation command. Existing project scripts are executed in the target repository and may have their own side effects; inspect those scripts before running the gate on an unfamiliar repository. Review Gate does not commit, push, reset, or install packages in the target.
After validation, the gate inspects the worktree again. If a script changed it, the report uses the resulting state and requires human review.

## Optional Jev adapter

The CLI Jev adapter is not requested by default; this does not describe Jev MCP availability in a Codex session. To opt in, set `REVIEW_GATE_JEV_ADAPTER` to the path of an executable program that accepts one JSON object on stdin and returns one JSON object on stdout. The adapter input has its own `schemaVersion: 1` and contains the absolute repository path for local verification, changed file `path`/`status`/capped `patch`, and deterministic risk summaries. An adapter that sends data remotely must apply its own approved send scope. It should return:

```json
{"labels":["security"],"reviewPaths":["src/auth.ts"],"recommendation":"REVIEW","reason":"Access check changed"}
```

The adapter has a 30-second timeout. Failure, timeout, or invalid output is reported as failed. Patches for files flagged as secrets or possible credential exposure are omitted from the adapter input and listed in `jev.omittedPaths`. Jev labels, paths, or a REVIEW/REJECT recommendation can request more human review, but cannot change a failed validation or a deterministic high/medium risk into APPROVE. The adapter is an explicit opt-in because a particular implementation may send the diff to a paid or remote service. The Codex MCP tools and this CLI adapter are separate; the CLI does not automatically invoke session MCP tools.

## Development

```sh
npm run lint
npm run typecheck
npm test
node benchmark/run.mjs
npm run demo
```

Tests and the 13-case ground-truth benchmark build temporary Git repositories and exercise the real CLI. The benchmark reports exact verdict/risk accuracy, false APPROVE, and false REJECT. It does not infer test coverage, inspect ignored files or full binary contents, execute non-Node validation commands, or prove that an APPROVE is bug-free. Diffs over the per-file read cap are marked for review. Rule matches are conservative and may require human correction.


## Status and report compatibility

Schema v4 extends the validation enum with `BLOCKED` and `NOT_RUN` and adds execution/reason fields and scope/next-step text. Closed v3 consumers must migrate rather than treating an unknown status as PASS or FAIL. Historical v3 dogfood reports are preserved as historical records; their missing-script SKIP wording is superseded by [VALIDATION_STATUS_SEMANTICS.md](VALIDATION_STATUS_SEMANTICS.md).

PASS requires a completed successful command; FAIL records a completed failing command, not proof the diff caused a regression. BLOCKED covers a process that cannot start/finish, a confirmed shell tool-launch failure, and incomplete retained output. NOT_RUN makes no conclusion. Missing optional checks are visible without forcing REJECT; behavior changes without a passing test require REVIEW. Nonzero results with ambiguous causes remain command failures for attribution; arbitrary error keywords do not waive a failing check.

To ensure no optional adapter is inherited when running local checks:

```sh
REVIEW_GATE_JEV_ADAPTER= node dist/cli.js /absolute/path/to/repository --json
```

The original development workspace retains private real-history regression material. It is intentionally excluded from the portable source candidate and npm package. `npm test`, `npm run lint`, the synthetic benchmark, and `npm run demo` work without those materials. Synthetic fixture scores do not establish production accuracy.


## Synthetic end-to-end example

After `npm ci`, run `npm run demo`. It creates a temporary Git repository with a passing Node test and a docs-only edit, invokes the real CLI, then changes that synthetic test to fail. Finally, it reviews a non-Git directory to demonstrate input error handling. The fixture uses only generated text, never user repositories, and is removed on completion. No adapter is used.

The printed summary contains these stable fields (full reports also contain temporary repository names, Git IDs, and timings):

```json
{"scenario":"docs-only","exitCode":0,"verdict":"APPROVE","riskLevel":"LOW","testStatus":"PASS"}
{"scenario":"failing-test","exitCode":2,"verdict":"REJECT","testStatus":"FAIL"}
{"scenario":"not-a-git-repository","exitCode":3,"error":"Not a Git repository"}
```

For your own inputs, keep exit codes 1 and 2 as completed reports requiring attention, and 3 as an invocation/tool problem. Check `validations[].status` and `reason`; `NOT_RUN` or `BLOCKED` never means PASS. Fix the reported cause and rerun on the resulting worktree. A clean tree returns REVIEW because there is no worktree diff to assess.

## Portable packaging and license status

`npm pack` builds the CLI and includes only the declared source/runtime, synthetic checks, and public-facing documents. To install the resulting archive in another empty directory, run `npm install /path/to/codex-review-gate-0.1.0.tgz`, then `npx --no-install review-gate --help`. The source candidate also carries the lockfile, so `npm ci && npm test && npm run lint && npm run demo` reproduces its development checks. Runtime use needs Node and Git, with no npm runtime dependencies or API key.

The original code is licensed under the [MIT License](LICENSE), copyright DavidLee1115. `private: true` prevents accidental npm publication; it does not change the source license. Third-party development dependency license metadata is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). See [SECURITY.md](SECURITY.md) before reviewing unfamiliar code.
