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

This example keeps the object implementation dependency-free so it builds against the current workspace dependencies. The local adapter mirrors Drizzle's D1 object session shape (`runDrizzleObjectMethod({ method, args, bookmark }) -> { value, bookmark }`) and primary-method forwarding; a Drizzle-backed version can keep the same `vite.config.ts`, `src/db/client.ts`, and route code, then replace only `src/db/posts-object.ts` with a `DrizzleD1Object` implementation.
