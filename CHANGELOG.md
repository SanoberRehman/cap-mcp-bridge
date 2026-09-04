# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-04

### Added

- Metadata layer: fetches `$metadata` over plain HTTP and parses OData v4 EDMX into a `ServiceModel`, folding CDS annotations (labels, descriptions, readonly, mandatory, personal data, Capabilities) into plain fields, detecting draft-enabled entities, mapping `Edm.Decimal` to string, and rejecting OData v2 with a clear message.
- Tool generation from the model: generic tools (`list_entity_sets`, `describe_entity`, `query_entity`, `get_entity`, `invoke_function`, `refresh_metadata`) or typed per-entity tools when a service has at most 12 entity sets; write tools only with `writeEnabled`; every entity schema as an MCP resource at `cap://entity/{name}`.
- Filters: structured objects and raw `$filter` strings share one AST, validated against the schema (field exists, filterable/sortable, operator legal for the type, literal format) and serialised with type-driven quoting; errors name the field and list valid options; draft entities get `IsActiveEntity eq true` injected.
- Auth (`none`, `basic`, `bearer`, `oauth2-cc` with cached single-flight XSUAA tokens and BTP service-key files) and transports (stdio, streamable HTTP with per-session servers sharing one metadata cache).
- Safety rails: read-only by default, `$top` default 25 / cap 200 with `$count` and `nextSkip`, ~50KB response ceiling with explicit notes, entity allow/deny globs, field redaction, 30s timeout with retries only on 5xx/429 reads.
- Packaging: CLI (`npx cap-mcp-bridge --url ...`, `--print-model`), Dockerfile, CI on Node 20/22 plus a Docker boot check, examples for Northwind, a local CAP bookshop and BTP, DEMO.md and a demo GIF rendered from a real session.

[Unreleased]: https://github.com/SanoberRehman/cap-mcp-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SanoberRehman/cap-mcp-bridge/releases/tag/v0.1.0
