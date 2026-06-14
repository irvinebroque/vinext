"use server";

import { posts } from "../src/db/client";

export async function createPostAction(formData: FormData) {
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();

  if (!title || !body) {
    return;
  }

  await posts.createPost({ title, body });
}
