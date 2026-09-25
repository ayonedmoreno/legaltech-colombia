import { Prisma, type PrismaClient } from "@legaltech/database";
import { describe, expect, it, vi } from "vitest";
import { PrismaAuthRepository } from "./auth.repository.js";
import { DuplicateEmailError } from "./auth.types.js";

const INPUT = { email: "ana@example.com", passwordHash: "$argon2id$...", fullName: "Ana Gómez" };

function repositoryWhoseCreateFailsWith(error: unknown): PrismaAuthRepository {
  const prisma = { user: { create: vi.fn().mockRejectedValue(error) } };
  return new PrismaAuthRepository(prisma as unknown as PrismaClient);
}

function knownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("database error", {
    code,
    clientVersion: Prisma.prismaVersion.client,
    meta: { target: ["email"] },
  });
}

describe("PrismaAuthRepository.createUser", () => {
  it("maps a unique constraint violation (P2002) to DuplicateEmailError", async () => {
    const repository = repositoryWhoseCreateFailsWith(knownRequestError("P2002"));
    await expect(repository.createUser(INPUT)).rejects.toBeInstanceOf(DuplicateEmailError);
  });

  it("does not hide any other known database error", async () => {
    const error = knownRequestError("P2003");
    const repository = repositoryWhoseCreateFailsWith(error);
    await expect(repository.createUser(INPUT)).rejects.toBe(error);
  });

  it("does not hide unknown errors", async () => {
    const error = new Error("connection lost");
    const repository = repositoryWhoseCreateFailsWith(error);
    await expect(repository.createUser(INPUT)).rejects.toBe(error);
  });
});
