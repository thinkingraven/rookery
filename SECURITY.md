# Security policy

## Reporting a vulnerability

Please report vulnerabilities in rookery itself privately through [GitHub security advisories](https://github.com/thinkingraven/rookery/security/advisories/new), or email **hello@thinkingraven.com**. Don't open a public issue.

We aim to reply within 3 working days and to ship a fix or mitigation within 30 days, and we'll credit you in the release notes unless you'd rather we didn't.

## In scope

- Any way a scanned file can make rookery execute code, read or write outside the scanned folders, or make a network request.
- Crafted input that hangs rookery (for example catastrophic regex backtracking).
- Secrets leaking unmasked into terminal, JSON, Markdown or HTML reports.
- Script injection through content rendered in the HTML report.
- Problems in `action.yml` that could expose a workflow's secrets.

## Not vulnerabilities

Rookery is a static, heuristic scanner. A risky skill that rookery fails to flag is a detection gap: please report it with the [false positive / missed finding form](https://github.com/thinkingraven/rookery/issues/new?template=false-positive.yml) instead, using a sanitised sample.

## Supported versions

Only the latest release gets security fixes.
