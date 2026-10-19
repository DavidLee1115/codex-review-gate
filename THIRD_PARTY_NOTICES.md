# Third-party development dependencies

This CLI imports only Node.js built-ins at runtime. No third-party code, dependency installation, or Node/Git runtime is bundled in the release candidate.

The lockfile records these development dependencies:

| Dependency | Locked version | Upstream license |
| --- | --- | --- |
| TypeScript | 5.9.3 | Apache-2.0 |
| @types/node | 26.6.3 | MIT, Microsoft Corporation |
| undici-types (transitive) | 8.9.0 | MIT, Matteo Collina and Undici contributors |

`npm ci` retrieves these packages with their own license files. Their licenses do not grant a license to Review Gate's original code. If you redistribute dependency contents, retain their full upstream license and required notices. This source candidate and the npm archive exclude `node_modules`.

The synthetic demo, benchmark, and CLI tests generate text locally. Credential-looking literals in those checks are deliberately fake canaries for detection/redaction regressions and are not service credentials. Private dogfood reports and real-history replay material are excluded from portable packages.
