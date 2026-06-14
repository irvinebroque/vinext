import d1 from "vinext:d1";
import type { VinextD1DatabaseClient } from "vinext/cloudflare/d1";
import type { PostsDatabase } from "./posts-object";

export const posts = d1.posts as VinextD1DatabaseClient<PostsDatabase>;
