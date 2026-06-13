# App Router with D1 application objects

A minimal vinext App Router example that calls a SQLite-backed Durable Object through the generated `vinext:d1` client module.

The route code never grabs a Durable Object namespace or object stub directly. It imports `src/db/client.ts`, calls methods on `posts`, and vinext handles the request-scoped Durable Object session.

## Run Locally

```sh
pnpm install
pnpm dev
```

## Build

```sh
pnpm build
```

## Deploy

```sh
pnpm wrangler deploy --config dist/server/wrangler.json
```

This example uses a tiny local object-session adapter so it builds against the current workspace dependencies. A Drizzle version can keep the same `vite.config.ts`, `src/db/client.ts`, and route code, then replace `src/db/posts-object.ts` with a `DrizzleD1Object` implementation once the Drizzle D1 object adapter is available.
