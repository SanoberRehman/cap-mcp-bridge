# Security policy

cap-mcp-bridge sits between a language model and a business system. The
safety rails (read-only default, forced pagination, entity allow/deny,
field redaction, token handling) are the product, so a way around any of
them is a security bug, not a feature request.

## Reporting

Use GitHub's private reporting: **[Report a vulnerability](https://github.com/SanoberRehman/cap-mcp-bridge/security/advisories/new)**.
It opens a private advisory that only the maintainer can see. Please do not
open a public issue for anything that could be exploited.

Include the bridge version (`npx cap-mcp-bridge --version`), the config
that reproduces it with secrets removed, and what the model was able to do
that it should not have been able to.

You will get an acknowledgement within a week. Fixes ship as a patch
release with a CHANGELOG entry; credit is given unless you ask otherwise.

## In scope

- Bypassing `writeEnabled: false` to reach a create, update, delete or
  action call.
- Reading an entity or field that `entityDeny`, `entityAllow` or
  `redactFields` should have hidden, including inside `$expand`.
- Getting raw text into `$filter` without going through the AST, or any
  other way to inject OData query syntax the validator did not see.
- Exceeding `maxTop` or `maxResponseBytes` in a way the response does not
  report.
- Tokens, passwords or service-key contents reaching stdout, logs, error
  messages or tool results.
- Auth handling in `oauth2-cc`: token leakage, missing expiry handling,
  sending credentials to the wrong host.

## Out of scope

- Vulnerabilities in the OData service the bridge is pointed at. The
  bridge trusts the service's `$metadata` and data.
- Deployments that expose the HTTP transport on a public interface without
  their own authentication in front of it. The bridge does not authenticate
  MCP clients; that is documented and deliberate.
- Prompt injection through data returned by the service. The bridge cannot
  stop the model from reading a malicious record; it can only keep the
  model from acting on it beyond the configured rails.

## Supported versions

Only the latest published version receives fixes. There is no LTS line.
