# Northwind example

The public OData v4 Northwind service. No auth, 26 entity sets, so the bridge picks the generic
tool set.

```sh
npx cap-mcp-bridge --config examples/northwind/cap-mcp.config.json
```

The config hides the SQL-view style entity sets (`Sales_by_Categories` and friends) so the model
sees the real tables, and redacts phone numbers as a demonstration of the redaction list.

Try:

- "Which customers in Germany placed orders shipped to Berlin? Include the company name."
- "Top 5 orders by freight cost, with the customer's company name." (needs `$expand=Customer`)
