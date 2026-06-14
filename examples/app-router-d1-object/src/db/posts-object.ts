import { DurableObject } from "cloudflare:workers";

export type Post = {
  id: number;
  title: string;
  body: string;
  createdAt: string;
};

type CreatePostInput = {
  title: string;
  body: string;
};

type ListPostsOptions = {
  limit?: number;
};

type D1ObjectMethodRequest = {
  method: string;
  args: unknown[];
  bookmark?: string | null;
};

type D1ObjectMethodResponse<T = unknown> = {
  value: T;
  bookmark?: string;
};

type D1ObjectPrimaryStub = {
  runDrizzleObjectMethod?: (
    request: D1ObjectMethodRequest,
  ) => Promise<D1ObjectMethodResponse>;
};

type D1ObjectState = DurableObjectState & {
  primaryStub?: D1ObjectPrimaryStub;
  configureReadReplication?: (options: { mode: "auto" | "disabled" }) => Promise<void>;
  storage: DurableObjectStorage & {
    getCurrentBookmark?: () => Promise<string>;
    waitForBookmark?: (bookmark: string) => Promise<void>;
  };
};

const RESERVED_METHODS = new Set([
  "constructor",
  "runD1ObjectMethod",
  "runDrizzleObjectMethod",
]);

export class PostsDatabase extends DurableObject {
  static readonly primaryMethods = ["createPost"];

  declare protected ctx: D1ObjectState;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      const d1Ctx = ctx as D1ObjectState;
      if (!d1Ctx.primaryStub) {
        await d1Ctx.configureReadReplication?.({ mode: "auto" });
      }
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS posts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    });
  }

  listPosts(options: ListPostsOptions = {}): Post[] {
    const limit = clampLimit(options.limit ?? 10);
    return this.ctx.storage.sql
      .exec<PostRow>(
        `
          SELECT id, title, body, created_at
          FROM posts
          ORDER BY id DESC
          LIMIT ?
        `,
        limit,
      )
      .toArray()
      .map(toPost);
  }

  createPost(input: CreatePostInput): Post {
    const title = input.title.trim();
    const body = input.body.trim();

    if (!title || !body) {
      throw new Error("title and body are required");
    }

    const row = this.ctx.storage.sql
      .exec<PostRow>(
        `
          INSERT INTO posts (title, body)
          VALUES (?, ?)
          RETURNING id, title, body, created_at
        `,
        title,
        body,
      )
      .toArray()[0];

    if (!row) {
      throw new Error("failed to create post");
    }

    return toPost(row);
  }

  async runD1ObjectMethod(
    request: D1ObjectMethodRequest,
  ): Promise<D1ObjectMethodResponse> {
    return this.runObjectMethod(request);
  }

  async runDrizzleObjectMethod(
    request: D1ObjectMethodRequest,
  ): Promise<D1ObjectMethodResponse> {
    return this.runObjectMethod(request);
  }

  private async runObjectMethod(
    request: D1ObjectMethodRequest,
  ): Promise<D1ObjectMethodResponse> {
    const method = getCallableMethod(this, request.method);

    if (this.shouldForwardToPrimary(request.method)) {
      const response = await this.ctx.primaryStub?.runDrizzleObjectMethod?.(request);
      if (!response) {
        throw new Error("Primary D1 object does not implement runDrizzleObjectMethod");
      }
      return response;
    }

    if (request.bookmark) {
      await this.ctx.storage.waitForBookmark?.(request.bookmark);
    }

    const value = await method.apply(this, request.args);
    const bookmark = await this.ctx.storage.getCurrentBookmark?.();

    return { value, bookmark };
  }

  private shouldForwardToPrimary(methodName: string): boolean {
    return this.ctx.primaryStub !== undefined && PostsDatabase.primaryMethods.includes(methodName);
  }
}

type PostRow = {
  id: number;
  title: string;
  body: string;
  created_at: string;
};

function toPost(row: PostRow): Post {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
  };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 10;
  return Math.min(Math.max(Math.trunc(limit), 1), 50);
}

function getCallableMethod(
  target: PostsDatabase,
  methodName: string,
): (...args: unknown[]) => unknown {
  if (
    RESERVED_METHODS.has(methodName) ||
    methodName.startsWith("_") ||
    methodName in Object.prototype
  ) {
    throw new Error(`D1 object method "${methodName}" cannot be called`);
  }

  const method = (target as unknown as Record<string, unknown>)[methodName];
  if (typeof method !== "function") {
    throw new Error(`D1 object method "${methodName}" does not exist`);
  }

  return method as (...args: unknown[]) => unknown;
}
