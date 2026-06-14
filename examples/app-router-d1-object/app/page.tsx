import { createPostAction } from "./actions";
import { posts } from "../src/db/client";

export default async function HomePage() {
  const latestPosts = await posts.listPosts({ limit: 10 });

  return (
    <main>
      <h1>vinext D1 object example</h1>
      <p>
        This page is rendered by vinext and reads from a SQLite-backed Durable Object through
        <code> vinext:d1</code>.
      </p>

      <form action={createPostAction}>
        <p>
          <label>
            Title
            <input name="title" required />
          </label>
        </p>
        <p>
          <label>
            Body
            <textarea name="body" required />
          </label>
        </p>
        <button type="submit">Create post</button>
      </form>

      <h2>Latest posts</h2>
      {latestPosts.length === 0 ? (
        <p>No posts yet. Create one above or POST to <code>/api/posts</code>.</p>
      ) : (
        <ul>
          {latestPosts.map((post) => (
            <li key={post.id}>
              <strong>{post.title}</strong>
              <p>{post.body}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
