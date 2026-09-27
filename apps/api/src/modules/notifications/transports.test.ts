import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileEmailTransport, MemoryEmailTransport } from "./transports.js";

const message = { to: "ana@example.com", subject: "Verifica tu correo", text: "Hola\nenlace" };

describe("MemoryEmailTransport", () => {
  it("keeps the messages it is given", async () => {
    const transport = new MemoryEmailTransport();
    await transport.send(message);
    expect(transport.sent).toEqual([message]);
  });

  it("rejects a recipient or subject with a line break (header injection)", async () => {
    const transport = new MemoryEmailTransport();
    await expect(
      transport.send({ ...message, to: "a@example.com\nBcc: x@evil" }),
    ).rejects.toThrow();
    await expect(transport.send({ ...message, subject: "Hola\r\nBcc: x" })).rejects.toThrow();
    expect(transport.sent).toEqual([]);
  });
});

describe("FileEmailTransport", () => {
  it("writes each message to its own file in the directory", async () => {
    const directory = join(await mkdtemp(join(tmpdir(), "legaltech-mail-")), "mail");
    try {
      const transport = new FileEmailTransport(directory);
      await transport.send(message);
      await transport.send({ ...message, to: "luis@example.com" });

      const files = await readdir(directory);
      expect(files).toHaveLength(2);
      const contents = await Promise.all(files.map((f) => readFile(join(directory, f), "utf8")));
      expect(contents).toContain(
        "To: ana@example.com\nSubject: Verifica tu correo\n\nHola\nenlace\n",
      );
      if (process.platform !== "win32") {
        expect((await stat(join(directory, files[0]!))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a header with a line break and writes nothing", async () => {
    const directory = join(await mkdtemp(join(tmpdir(), "legaltech-mail-")), "mail");
    try {
      const transport = new FileEmailTransport(directory);
      await expect(transport.send({ ...message, subject: "a\nb" })).rejects.toThrow();
      await expect(readdir(directory)).rejects.toThrow(); // never created
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
