<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 911-927) -->
<!-- Index: docs/core/prompt/README.md -->

## Compliance Checker

### `proxypilot compliance check [--framework soc2|hipaa|all]`

Checks every control against actual system state.

**SOC 2 controls:** CC6.1 access controls, CC6.5 encryption, CC7.1 monitoring, CC7.3-7.4 incident response, CC8.1 change management, A1.1 availability.

**HIPAA controls:** §164.308(a)(1) risk assessment, §164.308(a)(3) workforce security, §164.308(a)(5) training records, §164.308(a)(6) incident response, §164.312(a)(2)(iv) encryption at rest, §164.312(b) audit controls (6-year retention), §164.312(d) authentication, §164.312(e) transmission security.

Output: per-control pass/fail with actionable fix commands. Overall score. Stored in `compliance_checks` table for trend tracking.

```
proxypilot compliance check
proxypilot compliance history [--since <datetime>]
```
