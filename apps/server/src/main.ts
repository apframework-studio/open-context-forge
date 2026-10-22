import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";

const dataDir = process.env.OCF_DATA_DIR ?? join(homedir(), "Library", "Application Support", "Open Context Forge");
mkdirSync(dataDir, { recursive: true });

const app = createApp({
  dataDir,
  maintainerRoot: process.env.OCF_MAINTAINER_ROOT,
  publisherRoot: process.env.OCF_PUBLISHER_ROOT,
  blogRoot: process.env.OCF_BLOG_ROOT,
});

await app.listen({ host: "127.0.0.1", port: 3081 });
