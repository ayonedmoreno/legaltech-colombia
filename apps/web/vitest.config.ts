import { defineConfig } from "vitest/config";

// Tests only: render components with React's automatic JSX runtime, as Next.js does.
export default defineConfig({
  esbuild: { jsx: "automatic" },
});
