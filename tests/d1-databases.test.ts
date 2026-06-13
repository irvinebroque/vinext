import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  defaultD1BindingName,
  generateD1ObjectExportsModule,
  generateD1DatabasesModule,
  VIRTUAL_D1_OBJECT_EXPORTS,
  VIRTUAL_D1_DATABASES,
} from "../packages/vinext/src/cloudflare/d1-virtual.js";
import {
  applyVinextD1Bookmarks,
  createVinextD1DatabaseClient,
  runWithVinextD1RequestContext,
} from "../packages/vinext/src/cloudflare/d1.js";
import {
  generateAppRouterWorkerEntry,
  generatePagesRouterWorkerEntry,
} from "../packages/vinext/src/deploy.js";

describe("generateD1DatabasesModule", () => {
  it("exposes the public virtual module id", () => {
    expect(VIRTUAL_D1_DATABASES).toBe("vinext:d1");
    expect(VIRTUAL_D1_OBJECT_EXPORTS).toBe("virtual:vinext-d1-objects");
  });

  it("emits an empty default export when no databases are configured", () => {
    const code = generateD1DatabasesModule();
    expect(code).toContain("no d1 databases configured");
    expect(code).toContain("export default databases");
    expect(code).not.toContain("createVinextD1DatabaseClient");
  });

  it("generates a database export with normalized runtime config", () => {
    const code = generateD1DatabasesModule({
      blog: {
        source: "./db/blog",
        partitionBy: "hostname",
        writes: {
          methods: ["POST"],
          routes: ["/admin/**"],
        },
      },
    });

    expect(code).toContain('import { createVinextD1DatabaseClient } from "vinext/cloudflare/d1"');
    expect(code).toContain("export const blog = createVinextD1DatabaseClient");
    expect(code).toContain('"binding":"VINEXT_D1_BLOG"');
    expect(code).toContain('"partitionBy":"hostname"');
    expect(code).toContain('"bookmark":"cookie"');
    expect(code).toContain('"routes":["/admin/**"]');
    expect(code).toContain('databases["blog"] = blog');
  });

  it("allows an advanced binding override", () => {
    const code = generateD1DatabasesModule({
      blog: {
        binding: "BLOG_DATABASE",
        source: "./db/blog",
      },
    });
    expect(code).toContain('"binding":"BLOG_DATABASE"');
  });

  it("validates database keys and options", () => {
    expect(() =>
      generateD1DatabasesModule({
        "blog-db": { source: "./db/blog" },
      }),
    ).toThrow(/valid JavaScript export name/);
    expect(() => generateD1DatabasesModule({ blog: { source: "" } })).toThrow(/source/);
    expect(() =>
      generateD1DatabasesModule({
        // @ts-expect-error - exercised at runtime for JS users
        blog: { source: "./db/blog", partitionBy: "tenant" },
      }),
    ).toThrow(/partitionBy/);
  });

  it("derives stable default Durable Object binding names", () => {
    expect(defaultD1BindingName("blog")).toBe("VINEXT_D1_BLOG");
    expect(defaultD1BindingName("userProfiles")).toBe("VINEXT_D1_USER_PROFILES");
  });

  it("generates Worker exports for configured Durable Object source modules", () => {
    const code = generateD1ObjectExportsModule(
      {
        blog: { source: "./src/db/blog-object" },
        analytics: { source: "./src/db/blog-object" },
        shared: { source: "@acme/shared-d1-object" },
      },
      "/app",
    );

    expect(code).toContain('export * from "/app/src/db/blog-object";');
    expect(code).toContain('export * from "@acme/shared-d1-object";');
    expect(code.match(/blog-object/g)).toHaveLength(1);
  });
});

describe("createVinextD1DatabaseClient", () => {
  it("routes reads to the hostname-partitioned object with default routing", async () => {
    const calls: unknown[] = [];
    const getByNameCalls: unknown[] = [];
    const env = {
      VINEXT_D1_BLOG: {
        getByName(name: string, options?: unknown) {
          getByNameCalls.push({ name, options });
          return {
            async runDrizzleObjectMethod(request: unknown) {
              calls.push(request);
              return { value: [{ id: 1 }], bookmark: "b1" };
            },
          };
        },
      },
    };

    const blog = createVinextD1DatabaseClient<{
      listPosts(options: { limit: number }): { id: number }[];
    }>("blog", {
      binding: "VINEXT_D1_BLOG",
      bookmark: "header",
      partitionBy: "hostname",
    });

    const result = await runWithVinextD1RequestContext(
      {
        env,
        request: new Request("https://example.com/posts", {
          headers: { "x-d1-bookmark": "b0" },
        }),
      },
      () => blog.listPosts({ limit: 5 }),
    );

    expect(result).toEqual([{ id: 1 }]);
    expect(getByNameCalls).toEqual([{ name: "site:example.com", options: undefined }]);
    expect(calls).toEqual([{ method: "listPosts", args: [{ limit: 5 }], bookmark: "b0" }]);
  });

  it("routes configured writes to the primary object", async () => {
    const getByNameCalls: unknown[] = [];
    const env = {
      BLOG_DATABASE: {
        getByName(name: string, options?: unknown) {
          getByNameCalls.push({ name, options });
          return {
            async runDrizzleObjectMethod() {
              return { value: { id: 1 }, bookmark: "b1" };
            },
          };
        },
      },
    };

    const blog = createVinextD1DatabaseClient<{ createPost(): { id: number } }>("blog", {
      binding: "BLOG_DATABASE",
      writes: { methods: ["POST"], routes: ["/admin/**"] },
    });

    await runWithVinextD1RequestContext(
      {
        env,
        request: new Request("https://example.com/posts", { method: "POST" }),
      },
      () => blog.createPost(),
    );
    await runWithVinextD1RequestContext(
      {
        env,
        request: new Request("https://example.com/admin/settings"),
      },
      () => blog.createPost(),
    );

    expect(getByNameCalls).toEqual([
      { name: "default", options: { routingMode: "primary-only" } },
      { name: "default", options: { routingMode: "primary-only" } },
    ]);
  });

  it("serializes calls through one request session and carries the latest bookmark", async () => {
    const seenBookmarks: unknown[] = [];
    const env = {
      VINEXT_D1_BLOG: {
        getByName() {
          return {
            async runDrizzleObjectMethod(request: { bookmark?: string }) {
              seenBookmarks.push(request.bookmark);
              return { value: seenBookmarks.length, bookmark: `b${seenBookmarks.length}` };
            },
          };
        },
      },
    };

    const blog = createVinextD1DatabaseClient<{
      first(): number;
      second(): number;
    }>("blog", { binding: "VINEXT_D1_BLOG" });

    await runWithVinextD1RequestContext(
      {
        env,
        request: new Request("https://example.com/", {
          headers: { cookie: "__vinext_d1_bookmark_blog=b0" },
        }),
      },
      async () => {
        expect(await blog.first()).toBe(1);
        expect(await blog.second()).toBe(2);
      },
    );

    expect(seenBookmarks).toEqual(["b0", "b1"]);
  });

  it("applies bookmark headers and cookies to the outgoing response", async () => {
    const env = {
      VINEXT_D1_BLOG: {
        getByName() {
          return {
            async runDrizzleObjectMethod() {
              return { value: null, bookmark: "b1" };
            },
          };
        },
      },
    };

    const blog = createVinextD1DatabaseClient<{ touch(): null }>("blog", {
      binding: "VINEXT_D1_BLOG",
    });

    const response = await runWithVinextD1RequestContext(
      { env, request: new Request("https://example.com/") },
      async () => {
        await blog.touch();
        return applyVinextD1Bookmarks(new Response("ok"));
      },
    );

    expect(response.headers.get("x-d1-bookmark")).toBe("b1");
    expect(response.headers.get("set-cookie")).toContain("__vinext_d1_bookmark_blog=b1");
  });

  it("throws a helpful error when the binding is missing", async () => {
    const blog = createVinextD1DatabaseClient<{ listPosts(): unknown[] }>("blog", {
      binding: "VINEXT_D1_BLOG",
    });

    await expect(
      runWithVinextD1RequestContext({ env: {}, request: new Request("https://example.com/") }, () =>
        blog.listPosts(),
      ),
    ).rejects.toThrow(/VINEXT_D1_BLOG/);
  });
});

describe("D1 runtime wiring", () => {
  it("wraps the App Router worker entry with D1 request context before applying bookmarks", async () => {
    const src = await readFile(
      resolve(import.meta.dirname, "../packages/vinext/src/server/app-router-entry.ts"),
      "utf8",
    );

    expect(src).toContain("runWithVinextD1RequestContext(");
    expect(src).toContain("const result = await rscHandler(request, ctx);");
    expect(src).toContain(
      "return result instanceof Response ? applyVinextD1Bookmarks(result) : result;",
    );
    expect(src).toContain('export * from "virtual:vinext-d1-objects";');
  });

  it("wraps the generated Pages Router worker entry with D1 request context", () => {
    const code = generatePagesRouterWorkerEntry();
    expect(code).toContain('from "vinext/cloudflare/d1"');
    expect(code).toContain("runWithVinextD1RequestContext({ request, env }");
    expect(code).toContain("applyVinextD1Bookmarks(result.response)");
    expect(code).toContain('export * from "virtual:vinext-d1-objects";');
  });

  it("re-exports D1 objects from the generated App Router worker entry", () => {
    const code = generateAppRouterWorkerEntry();
    expect(code).toContain('export * from "vinext/server/app-router-entry";');
  });
});
