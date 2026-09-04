# 90-second demo

An unmodified CAP service, connected and queried in English. Uses the bookshop under
`examples/bookshop`; swap the URL for any CAP or OData v4 service and the script still works,
because nothing below is specific to this service.

## Setup (before the clock starts)

Terminal 1, the service:

```sh
cd examples/bookshop && npm install && npx cds watch
```

Claude Desktop config (`claude_desktop_config.json`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "bookshop": {
      "command": "npx",
      "args": ["-y", "cap-mcp-bridge", "--url", "http://localhost:4004/odata/v4/catalog"]
    }
  }
}
```

(For Claude Code: `claude mcp add bookshop -- npx -y cap-mcp-bridge --url http://localhost:4004/odata/v4/catalog`.)

## Script

**0:00. It read the service.**

> What data is in this service?

Claude calls `list_entity_sets`. Expect a list of Books, Authors, Genres, Reviews, Orders,
OrderItems, Currencies with labels, record counts, and a note that Orders is draft-enabled and
Genres is read-only. None of that was configured; it came from `$metadata`.

**0:20. A real query with a filter it had to get right.**

> Which books cost more than 12, most expensive first? Show the title and price.

Claude calls `query_Books` with `{ filter: { field: "price", op: "gt", value: "12" }, orderBy: [{ field: "price", dir: "desc" }], select: ["title", "price"] }`.
Point out: price is a decimal, sent as a string, and the bridge emitted `price gt 12` unquoted.

**0:40. The "it understands the data model" moment: an `$expand` across an association.**

> For those same books, who wrote them and where was each author born?

Claude adds `expand: ["author"]`. One call, one round trip, joined data. It knew `author` was the
navigation because the tool description lists `author → Authors`. Also point out the author's
`email` field: `[REDACTED]`. It is annotated `@PersonalData.IsPotentiallySensitive` in the CDS
model, and the bridge redacts it inside the expanded record without being told.

**1:00. Self-correction.**

> Find books whose *name* contains "Raven".

Claude will likely try `field: "name"`. The bridge answers, before touching the network:

```
"name" does not exist on Books. validOptions: ID, title, descr, ...
```

Claude retries with `title` and gets *The Raven*. That is the whole point of structured errors.

**1:15. Drafts.**

> How many orders are there?

Claude calls `query_Orders`; the response says `count: 3` with the note *"Draft-enabled entity:
only active records are returned"*. Without the injected `IsActiveEntity eq true`, a draft-enabled
entity returns every record twice.

**1:25. A function.**

> Use the service's own top-books function to get the 2 best-stocked books.

Claude calls `invoke_function` with `{ name: "topBooks", parameters: { n: 2 } }`. Functions and
actions are discovered from `$metadata` like everything else.

**1:30. Done.** Everything above ran read-only. Start the bridge with `--write` and the model
also gets `create_Books`, `update_Orders`, `invoke_action` (for `restock` and `submitOrder`), each
only where the service's `@Capabilities` annotations allow it.

## Same script, public service

No CAP service handy? Point the bridge at Northwind and use these prompts instead:

```sh
npx cap-mcp-bridge --url https://services.odata.org/V4/Northwind/Northwind.svc
```

- "What tables are in this service?" → `list_entity_sets` (26 sets; the bridge picked generic tools)
- "Top 5 orders by freight, with the customer's company name" → `query_entity` with `expand: ["Customer"]`
- "Orders shipped to Germany after 1997-06-01" → date literal handled
- "Filter categories by picture" → `Picture` is not filterable (binary); structured error lists what is
