# Security and review scope

Use Review Gate only on repositories whose validation scripts you have reviewed and trust. It executes the target's existing npm scripts with the current user's permissions and environment. It does not sandbox, restrict network access, or prevent those scripts from reading files, using credentials, or changing data. Use an independently configured isolated environment for unfamiliar code.

Deterministic path and text rules are conservative signals. This is not a comprehensive secret scanner, static analyzer, malware detector, or runtime acceptance test. Ignored files and full binary contents are outside its scope; capped diffs and command output are reported as incomplete. APPROVE does not guarantee absence of bugs or vulnerabilities, sufficient coverage, license clearance, or deployment readiness.

The optional adapter is disabled unless explicitly configured. A configured adapter receives the absolute target repository path and selected patches; its own approved scope governs any remote transmission. Redaction is best effort and does not make arbitrary repository data safe to publish.

Reports may include repository-relative filenames, branch names, code excerpts, or validation error excerpts. Review reports manually before sharing them. Do not put real credentials in reproduction inputs. Keep any suspected credential private and handle it through your existing private security process; do not disclose suspected credentials or private repository content in public GitHub issues.
