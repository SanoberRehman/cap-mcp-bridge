# Contributing

Thanks for looking. This file is the short version of how the project is put
together and what a change needs before it merges. The long version of the
design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Setup

Node 20 or newer.

```sh
npm ci
npm run typecheck && npm run lint && npm test
npm run dev -- --url https://services.odata.org/V4/Northwind/Northwind.svc --print-model
```

Those three checks are exactly what CI runs on Node 20 and 22, so if they pass
locally the PR will be green.

## Where things go

```
src/metadata/   $metadata XML  → ServiceModel      (parse, annotations, drafts, cache)
src/odata/      tool arguments → validated request (filter AST, validate, URL, auth, http)
src/tools/      ServiceModel   → MCP tools/resources (generic or per-entity)
src/server/     transports (stdio, streamable HTTP) and config
```

`ServiceModel` (`src/metadata/model.ts`) is the only contract between layers.
A change that needs two layers to know about each other in some other way is
probably in the wrong place.

Some common changes and where they land:

- **A CAP annotation the bridge should understand.** `parse.ts` reads it into
  a plain field on the model, `model.ts` documents the field, and whatever
  consumes it (`tools/describe.ts`, `odata/validate.ts`) reads the field, never
  the annotation. Add the annotation to `examples/bookshop` and regenerate the
  fixture (below) so the test proves it end to end.
- **A new `$filter` operator or function.** `odata/filter/ast.ts` for the node,
  `parse.ts` and `structured.ts` for both input forms, `validate.ts` for which
  types it is legal on, `serialize.ts` for the output. One AST, two parsers,
  one validator, one serialiser.
- **A new safety rail.** Config in `server/config.ts` with an env var and a
  README row, enforcement in `tools/handlers.ts` or `odata/response.ts`, and
  the response must say what it did (a dropped row, a clamped `$top`) rather
  than doing it silently.

## Tests

`npm test` runs everything under `test/` with `fetch` stubbed. The end-to-end
suites in `test/tools` and `test/server` run a real `McpServer` and `Client`
over an in-memory transport, so a change to a tool's schema or behaviour is
exercised the way a client sees it.

Fixtures live in `test/fixtures`:

- `northwind.xml` is a plain OData v4 service with no CAP annotations.
- `bookshop.xml` is compiled from `examples/bookshop` and carries every
  annotation the bridge understands, drafts included. Regenerate it after
  changing the CDS:

  ```sh
  cd examples/bookshop && npx cds compile srv --to edmx-v4 > ../../test/fixtures/bookshop.xml
  ```

  `examples/bookshop` is pinned to `@sap/cds ^8`; see its README before bumping.

`npm run test:live` additionally hits the public Northwind service. It is not
part of CI and is there to catch the things a stub cannot, like a serialiser
change that the real server rejects.

## Pull requests

`main` is protected: required checks on Node 20 and 22, linear history,
squash merge. Every change goes through a PR, including the maintainer's.

- Branch from `main`. If `main` moves while your PR is open, rebase; the
  required checks have to run against the current base.
- Commit messages are sentence case, imperative, no type prefix. Put the
  *why* in the body. The squash commit takes the PR title, so make the title
  the message you want in history.
- User-facing changes get a line under `[Unreleased]` in `CHANGELOG.md`
  (Keep a Changelog headings: Added, Changed, Fixed, Removed).
- If it changes a flag, an env var or a config key, update the README table
  and the `--help` text in `src/cli.ts`.
- If it changes what the model sees (a tool description, a schema, an error
  message), say what the old and new text are in the PR. Those strings are
  the product.

Releases are cut by tag through GitHub Actions; the steps are in the README
under "Cutting a release".

## Security

Anything that gets around a safety rail is a security bug. Please use the
private route in [SECURITY.md](SECURITY.md) rather than a public issue.
