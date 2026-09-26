import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// `prisma generate` rewrites the shared Prisma Client in place, so it must run exactly once per
// Turborepo run and before anything reads the client. These tests pin that wiring (README).
type TurboTasks = Record<string, { dependsOn?: string[]; cache?: boolean }>;

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
const turbo = JSON.parse(readFileSync(new URL("../../../turbo.json", import.meta.url), "utf8")) as {
  tasks: TurboTasks;
};
// Turborepo also accepts per-package configuration, which would override the root tasks.
const packageTurboUrl = new URL("../turbo.json", import.meta.url);
const packageTurbo = existsSync(packageTurboUrl)
  ? (JSON.parse(readFileSync(packageTurboUrl, "utf8")) as { tasks?: TurboTasks })
  : undefined;

const CLIENT_READERS = ["build", "typecheck", "test"];

describe("Prisma Client generation (single Turborepo task)", () => {
  it("runs prisma generate only from the generate script", () => {
    const generating = Object.entries(packageJson.scripts)
      .filter(([, command]) => command.includes("prisma generate"))
      .map(([name]) => name);
    expect(generating).toEqual(["generate"]);
  });

  it("is an uncached Turborepo task that build, typecheck and test depend on", () => {
    expect(turbo.tasks.generate).toEqual({ cache: false });
    for (const task of CLIENT_READERS) {
      expect(turbo.tasks[task]?.dependsOn, task).toContain("generate");
    }
  });

  it("is not bypassed by a package-specific override of those tasks", () => {
    for (const task of CLIENT_READERS) {
      const rootOverride = turbo.tasks[`@legaltech/database#${task}`];
      if (rootOverride) {
        expect(rootOverride.dependsOn, `root override of ${task}`).toContain("generate");
      }
      const packageOverride = packageTurbo?.tasks?.[task];
      if (packageOverride) {
        expect(packageOverride.dependsOn, `packages/database/turbo.json ${task}`).toContain(
          "generate",
        );
      }
    }
  });
});
