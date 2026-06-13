import { posts } from "../../../src/db/client";

type CreatePostInput = {
  title?: unknown;
  body?: unknown;
};

export async function GET() {
  return Response.json({
    posts: await posts.listPosts({ limit: 20 }),
  });
}

export async function POST(request: Request) {
  const input = (await request.json()) as CreatePostInput;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";

  if (!title || !body) {
    return Response.json({ error: "title and body are required" }, { status: 400 });
  }

  const post = await posts.createPost({ title, body });
  return Response.json({ post }, { status: 201 });
}
