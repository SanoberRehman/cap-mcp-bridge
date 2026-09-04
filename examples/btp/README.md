# BTP-deployed CAP service (XSUAA client credentials)

Two ways to supply the credentials. Prefer the environment: it keeps secrets out of files.

## Option 1: service key file

Download the XSUAA service key from the BTP cockpit (or `cf service-key <xsuaa-instance> <key-name>`)
and point the bridge at it. The token URL, client id and secret are read from the key.

```sh
export CAP_MCP_URL=https://<app>.cfapps.<region>.hana.ondemand.com/odata/v4/catalog
export CAP_MCP_SERVICE_KEY_FILE=./service-key.json
npx cap-mcp-bridge
```

## Option 2: explicit variables

```sh
export CAP_MCP_URL=https://<app>.cfapps.<region>.hana.ondemand.com/odata/v4/catalog
export CAP_MCP_AUTH=oauth2-cc
export CAP_MCP_TOKEN_URL=https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token
export CAP_MCP_CLIENT_ID=sb-...
export CAP_MCP_CLIENT_SECRET=...
npx cap-mcp-bridge --config examples/btp/cap-mcp.config.json
```

The config file in this directory shows the non-secret settings that usually go with a BTP
deployment: a longer timeout, hiding CAP's `DraftAdministrativeData` and `*_texts` entity sets, and
redacting fields that look like contact details. The `${...}` placeholders in the file are
documentation only; the bridge does not expand them, so leave the secret fields to the environment
(environment values take precedence over the file).

The token is cached in memory, refreshed 60 seconds before it expires, and fetched single-flight
so concurrent tool calls never stampede the token endpoint. Nothing about it is ever logged.
