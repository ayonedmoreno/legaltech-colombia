import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const frameworks = ["fastify", "next", "react", "react-dom"];
const prismaClient = { paths: ["@prisma/client"], patterns: ["@prisma/client/*"] };
const message = "Import not allowed in this workspace (ADR-001 dependency rules).";

/** Enforces the dependency boundaries defined in ADR-001 with `no-restricted-imports`. */
function boundaries({ paths = [], patterns = [] }) {
  return {
    "no-restricted-imports": [
      "error",
      {
        paths: paths.map((name) => ({ name, message })),
        patterns: patterns.map((group) => ({ group: [group], message })),
      },
    ],
  };
}

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      "docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
  },
  // packages/contracts: only zod, no other workspace package, no framework, no ORM.
  {
    files: ["packages/contracts/**"],
    rules: boundaries({
      paths: [...frameworks, ...prismaClient.paths],
      patterns: ["@legaltech/*", ...prismaClient.patterns],
    }),
  },
  // Pure engines: no database, ai, framework or ORM.
  {
    files: ["packages/legal-engine/**", "packages/pricing-engine/**"],
    rules: boundaries({
      paths: [...frameworks, ...prismaClient.paths, "@legaltech/database", "@legaltech/ai"],
      patterns: prismaClient.patterns,
    }),
  },
  {
    files: ["packages/ai/**"],
    rules: boundaries({
      paths: [...frameworks, ...prismaClient.paths],
      patterns: prismaClient.patterns,
    }),
  },
  // Only packages/database may import the ORM.
  {
    files: ["packages/database/**"],
    rules: boundaries({ paths: frameworks, patterns: ["@legaltech/*"] }),
  },
  {
    files: ["apps/api/**"],
    rules: boundaries({
      paths: ["next", "react", "react-dom", ...prismaClient.paths],
      patterns: prismaClient.patterns,
    }),
  },
  {
    files: ["apps/web/**"],
    rules: boundaries({
      paths: ["fastify", "@legaltech/database", ...prismaClient.paths],
      patterns: prismaClient.patterns,
    }),
  },
  prettier,
);
