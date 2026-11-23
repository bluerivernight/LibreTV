import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../../src/util/passwords";

// Statically validated against the deterministic seed hash computed in M2:
// pbkdf2$sha256$210000$97VlTdYCUQV0PKi2SHhoGQ$MEPDgD5brbajSMc4IkaOwLd6eR7X0WaB-r0Z43xh3K0
const SEED_HASH = "pbkdf2$sha256$210000$97VlTdYCUQV0PKi2SHhoGQ$MEPDgD5brbajSMc4IkaOwLd6eR7X0WaB-r0Z43xh3K0";

describe("passwords", () => {
  it("hashPassword emits the stored format pbkdf2$sha256$iter$salt$dk", async () => {
    const h = await hashPassword("demo-pass-2026");
    const parts = h.split("$");
    expect(parts.length).toBe(5);
    expect(parts[0]).toBe("pbkdf2");
    expect(parts[1]).toBe("sha256");
    expect(parts[2]).toBe("210000");
    expect(parts[3]).toMatch(/^[A-Za-z0-9_-]+$/); // base64url salt, no padding
    expect(parts[4]).toMatch(/^[A-Za-z0-9_-]+$/); // base64url derived key
  });

  it("salt is random: two hashes of the same password differ but both verify", async () => {
    const [a, b] = await Promise.all([hashPassword("pw"), hashPassword("pw")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("pw", a)).toBe(true);
    expect(await verifyPassword("pw", b)).toBe(true);
  });

  it("verifyPassword round-trips and rejects wrong passwords", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
  });

  it("verifies the deterministic seed hash (demo@libre.tv credential)", async () => {
    expect(await verifyPassword("demo-pass-2026", SEED_HASH)).toBe(true);
    expect(await verifyPassword("not-the-password", SEED_HASH)).toBe(false);
  });

  it("rejects malformed stored hashes without throwing", async () => {
    for (const bad of ["", "not-a-hash", "pbkdf2$sha256$1", "scrypt$sha256$1$a$b", "pbkdf2$sha512$1$a$b"]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });
});