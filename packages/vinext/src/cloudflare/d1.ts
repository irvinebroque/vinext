import { getOrCreateAls } from "vinext/shims/internal/als-registry";

type MethodLike = (...args: never[]) => unknown;
type UnknownMethod = (...args: unknown[]) => unknown;
type ReservedD1Method =
  | "runDrizzleObjectMethod"
  | "runDrizzleQuery"
  | "applyDrizzleMigrations"
  | "runD1ObjectMethod"
  | "runKyselyD1ObjectMethod";

type PublicMethodKey<TObject extends object> = {
  [K in keyof TObject]: K extends ReservedD1Method
    ? never
    : TObject[K] extends MethodLike
      ? K extends string
        ? K
        : never
      : never;
}[keyof TObject];

export type VinextD1DatabaseClient<TObject extends object = Record<string, UnknownMethod>> = {
  [K in PublicMethodKey<TObject>]: TObject[K] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : never;
};

export type VinextD1BookmarkMode = "cookie" | "header" | false;
export type VinextD1PartitionMode = "default" | "hostname";

export type VinextD1WriteConfig = {
  methods?: readonly string[];
  routes?: readonly string[];
};

export type VinextD1DatabaseRuntimeConfig = {
  binding: string;
  bookmark?: VinextD1BookmarkMode;
  partitionBy?: VinextD1PartitionMode;
  rpcMethod?: string;
  writes?: VinextD1WriteConfig;
};

type DurableObjectNamespaceLike = {
  getByName(name: string, options?: { routingMode?: "primary-only" }): VinextD1SessionStub;
};

type VinextD1SessionStub = Record<string, unknown>;

type VinextD1MethodRequest = {
  method: string;
  args: readonly unknown[];
  bookmark?: string | null;
};

type VinextD1MethodResponse<T = unknown> = {
  value: T;
  bookmark?: string | null;
};

type VinextD1RequestContext = {
  env?: Record<string, unknown>;
  request: Request;
  bookmarks: Map<string, VinextD1Bookmark>;
  sessions: Map<string, VinextD1DatabaseSession>;
};

type VinextD1Bookmark = {
  value: string;
  mode: Exclude<VinextD1BookmarkMode, false>;
};

type VinextD1DatabaseSession = {
  bookmark: string | undefined;
  pending: Promise<void>;
  stub: VinextD1SessionStub;
};

const DEFAULT_WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const DEFAULT_RPC_METHOD = "runDrizzleObjectMethod";
const BOOKMARK_HEADER = "x-d1-bookmark";
const BOOKMARK_COOKIE = "__vinext_d1_bookmark";

const _als = getOrCreateAls<VinextD1RequestContext>("vinext.cloudflare.d1.als");

export function runWithVinextD1RequestContext<T>(
  options: { request: Request; env?: Record<string, unknown> },
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return _als.run(
    {
      env: options.env,
      request: options.request,
      bookmarks: new Map(),
      sessions: new Map(),
    },
    fn,
  );
}

export function createVinextD1DatabaseClient<TObject extends object>(
  name: string,
  config: VinextD1DatabaseRuntimeConfig,
): VinextD1DatabaseClient<TObject> {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property !== "string" || property === "then") {
        return undefined;
      }

      return (...args: unknown[]) => callVinextD1Method(name, config, property, args);
    },
  }) as VinextD1DatabaseClient<TObject>;
}

export function applyVinextD1Bookmarks(response: Response): Response {
  const context = _als.getStore();
  if (!context || context.bookmarks.size === 0) {
    return response;
  }

  let nextResponse = response;
  let headers = response.headers;

  try {
    for (const [name, bookmark] of context.bookmarks) {
      applyBookmark(headers, name, bookmark);
    }
  } catch {
    headers = new Headers(response.headers);
    for (const [name, bookmark] of context.bookmarks) {
      applyBookmark(headers, name, bookmark);
    }
    nextResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return nextResponse;
}

async function callVinextD1Method(
  name: string,
  config: VinextD1DatabaseRuntimeConfig,
  method: string,
  args: readonly unknown[],
): Promise<unknown> {
  const context = _als.getStore();
  if (!context) {
    throw new Error(`[vinext] D1 database "${name}" was used outside a vinext request context.`);
  }

  const session = getOrCreateSession(context, name, config);
  const call = session.pending.then(async () => {
    const rpcMethod = config.rpcMethod ?? DEFAULT_RPC_METHOD;
    const rpc = session.stub[rpcMethod];
    if (typeof rpc !== "function") {
      throw new Error(
        `[vinext] D1 database "${name}" binding "${config.binding}" does not expose ${rpcMethod}().`,
      );
    }

    const response = (await rpc.call(session.stub, {
      method,
      args,
      bookmark: session.bookmark,
    } satisfies VinextD1MethodRequest)) as VinextD1MethodResponse;

    if (response.bookmark && config.bookmark !== false) {
      session.bookmark = response.bookmark;
      context.bookmarks.set(name, {
        value: response.bookmark,
        mode: config.bookmark === "header" ? "header" : "cookie",
      });
    }

    return response.value;
  });

  session.pending = call.then(
    () => undefined,
    () => undefined,
  );

  return call;
}

function getOrCreateSession(
  context: VinextD1RequestContext,
  name: string,
  config: VinextD1DatabaseRuntimeConfig,
): VinextD1DatabaseSession {
  const existing = context.sessions.get(name);
  if (existing) return existing;

  const namespace = getNamespace(context, config.binding, name);
  const objectName = resolveObjectName(config, context.request);
  const options = shouldRoutePrimary(context.request, config)
    ? { routingMode: "primary-only" as const }
    : undefined;
  const stub = namespace.getByName(objectName, options);
  const bookmark = readBookmark(context.request, config.bookmark, name);
  const session: VinextD1DatabaseSession = {
    bookmark,
    pending: Promise.resolve(),
    stub,
  };
  context.sessions.set(name, session);
  return session;
}

function getNamespace(
  context: VinextD1RequestContext,
  binding: string,
  name: string,
): DurableObjectNamespaceLike {
  const namespace = context.env?.[binding] as DurableObjectNamespaceLike | undefined;
  if (!namespace || typeof namespace.getByName !== "function") {
    throw new Error(
      `[vinext] D1 database "${name}" expected a Durable Object namespace binding named "${binding}".`,
    );
  }
  return namespace;
}

function resolveObjectName(config: VinextD1DatabaseRuntimeConfig, request: Request): string {
  if (config.partitionBy === "hostname") {
    return `site:${new URL(request.url).hostname}`;
  }
  return "default";
}

function shouldRoutePrimary(request: Request, config: VinextD1DatabaseRuntimeConfig): boolean {
  const method = request.method.toUpperCase();
  const writeMethods = new Set(
    (config.writes?.methods ?? DEFAULT_WRITE_METHODS).map((m) => m.toUpperCase()),
  );
  if (writeMethods.has(method)) return true;

  const pathname = new URL(request.url).pathname;
  return (config.writes?.routes ?? []).some((pattern) => matchRoutePattern(pathname, pattern));
}

function matchRoutePattern(pathname: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  }

  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    const rest = pathname.slice(prefix.length + 1);
    return pathname.startsWith(`${prefix}/`) && rest.length > 0 && !rest.includes("/");
  }

  return pathname === pattern;
}

function readBookmark(
  request: Request,
  mode: VinextD1BookmarkMode | undefined,
  name: string,
): string | undefined {
  if (mode === false) return undefined;
  if (mode === "header") {
    return request.headers.get(BOOKMARK_HEADER) ?? undefined;
  }
  return readCookie(request.headers.get("cookie"), cookieNameForDatabase(name)) ?? undefined;
}

function applyBookmark(headers: Headers, name: string, bookmark: VinextD1Bookmark): void {
  headers.set(BOOKMARK_HEADER, bookmark.value);
  if (bookmark.mode !== "cookie") return;

  headers.append(
    "Set-Cookie",
    `${encodeCookieComponent(cookieNameForDatabase(name))}=${encodeCookieComponent(bookmark.value)}; Path=/; HttpOnly; SameSite=Lax`,
  );
}

function cookieNameForDatabase(name: string): string {
  return name === "default" ? BOOKMARK_COOKIE : `${BOOKMARK_COOKIE}_${name}`;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    return decodeCookieComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

function encodeCookieComponent(value: string): string {
  return encodeURIComponent(value);
}

function decodeCookieComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
