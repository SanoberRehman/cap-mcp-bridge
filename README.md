# cap-mcp-bridge

An MCP server that points at any SAP CAP / OData v4 service, reads its `$metadata`, and exposes it
to an LLM as usable tools. No per-service code, no hand-written tool definitions.

Work in progress. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.
