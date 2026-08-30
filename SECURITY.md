# Security Policy

## Supported Versions

Oxiquill provides security fixes for the latest released minor line only. Pre-release builds and the `main` branch are supported only as development inputs; users should reproduce reports against the latest release when possible.

| Version          | Supported |
| ---------------- | --------- |
| 0.3.x            | Yes       |
| Earlier versions | No        |

This table is updated as part of every release. If a fix cannot be safely backported within the supported line, maintainers may publish the fix in the next minor release and will explain that decision privately to affected reporters before coordinated disclosure.

## Report a Vulnerability

Use [GitHub private vulnerability reporting](https://github.com/kakune/oxiquill/security/advisories/new). Do not open a public issue for a suspected vulnerability and do not include secrets, exploits, or affected deployments in public discussions.

Include, when available:

- the affected Oxiquill version, operating system, Node.js version, package manager, and browser;
- the affected command, package export, generated artifact, or runtime feature;
- reproduction steps or a minimal repository;
- expected and observed behavior and security impact;
- any known workaround, disclosure deadline, or existing public reference.

Reports should contain only data you are authorized to share. A maintainer may ask you to move large or sensitive artifacts to an agreed private channel.

## Response Process

Maintainers aim to:

1. acknowledge a new report within three business days;
2. provide an initial severity/scope assessment within seven calendar days;
3. send a status update at least every seven calendar days while remediation is active;
4. coordinate a fix, regression tests, release, advisory, credit, and disclosure timing with the reporter;
5. publish an advisory and patched release once supported users can upgrade safely.

Actual remediation time depends on severity, reproducibility, affected dependencies, and release safety. GitHub Security Advisories are the source of truth for private coordination. Maintainers will not knowingly disclose reporter details before the agreed publication unless required by law or necessary to protect users from active exploitation.

## Security Boundaries

Author-provided Rust, Python, and Haskell cells become executable browser content. Mermaid source, helper crates, generated/downloaded Wasm, Pyodide packages, images, and HTML artifacts must be reviewed as content or supply-chain inputs. Browser workers improve responsiveness but are not equivalent to an operating-system sandbox.

HTML artifacts run in an iframe with an empty `sandbox` attribute and intentionally receive no script, same-origin, form, popup, top-navigation, or download permission. The sandbox is not an HTML sanitizer, and passive subresources can still make network requests.

See the public [Support and Security guide](https://kakune.github.io/oxiquill/guides/support-and-security/) for the complete compatibility and trust model.

## Non-Security Support

Use [GitHub Issues](https://github.com/kakune/oxiquill/issues) for ordinary bugs, installation help, feature requests, and documentation problems. A report that only causes a normal build/runtime error without crossing a trust boundary is usually not a vulnerability.
