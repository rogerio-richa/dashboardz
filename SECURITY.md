# Security policy

Please do not file public issues, pull requests, or discussions containing
exploit details, proof-of-concept code, credentials, or other information that
could help someone attack an installation. GitHub Security Advisories are the
preferred private channel: [report a vulnerability privately][advisory].

Include the affected version, deployment shape, steps to reproduce privately,
and any suggested mitigation. We will acknowledge a report as soon as
practical and coordinate a fix or disclosure timeline with the reporter.

This project is pre-release: until the first tagged release, the current
`main` branch is the supported target. Once tagged releases begin, only the
latest release is supported. Older releases may lack security fixes; upgrade
before investigating an issue that is not reproducible on the supported
target.

Dashboardz's security boundaries, credential handling, and known limitations
are documented in the [security model](docs/architecture/security.md). In
particular, replay protection is a documented known limit in the current relay
protocol; it is not implied to be present by this policy.

[advisory]: https://github.com/rogerio-richa/dashboardz/security/advisories/new
