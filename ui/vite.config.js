import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Local dev: "/" is fine. GitHub Pages: "/<repo-name>/".
  const repo = process.env.GITHUB_REPOSITORY
    ? process.env.GITHUB_REPOSITORY.split("/")[1]
    : null;

  const base =
    process.env.VITE_BASE ||
    (mode === "production" && repo ? `/${repo}/` : "/");

  return {
    plugins: [react()],
    base,
    server: {
      proxy: {
        // Local dev API to trigger Python generator
        '/api': 'http://localhost:8787',
      },
    },
  };
});
