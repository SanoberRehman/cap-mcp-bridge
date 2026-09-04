# Bookshop example

A small CAP service with the annotations the bridge cares about: `@title`, `@Core.Description`,
`@readonly`, `@mandatory`, `@PersonalData.IsPotentiallySensitive`, `@Capabilities` restrictions,
a draft-enabled `Orders` entity, a `Decimal` price, an unbound function and both bound and unbound
actions.

```sh
cd examples/bookshop
npm install
npx cds watch          # http://localhost:4004/odata/v4/catalog
```

Then, from the repo root:

```sh
npx cap-mcp-bridge --config examples/bookshop/cap-mcp.config.json
# or with writes enabled
npx cap-mcp-bridge --config examples/bookshop/cap-mcp.config.json --write
```

Seven entity sets, so the bridge generates typed per-entity tools (`query_Books`, `get_Orders`, ...).
`Currencies_texts` is hidden by the config as an example of the deny list.

Regenerate the test fixture after changing the model:

```sh
npx cds compile srv --to edmx-v4 > ../../test/fixtures/bookshop.xml
```
