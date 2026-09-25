// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RUNG_FORMAT_VERSION,
  escapeSegment,
  unescapeSegment,
  formatAddress,
  parseAddress,
  addressToPath,
  pathToAddress,
  findCaseCollisions,
  AddressError,
  type Address,
  type TextForm,
} from "../src/index.js";

interface Vectors {
  segments: { valid: [string, string][]; invalidEscaped: string[]; invalidRaw: string[] };
  addresses: { address: Address; string: string; form: TextForm; path: string }[];
  invalidAddressStrings: string[];
  invalidPaths: string[];
}
const vectors: Vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../docs/format/address-vectors.json", import.meta.url)), "utf8"),
);

describe("format", () => {
  it("exposes format version 1", () => expect(RUNG_FORMAT_VERSION).toBe(1));
});

describe("escapeSegment / unescapeSegment", () => {
  it.each(vectors.segments.valid)("%j <-> %j", (raw, esc) => {
    expect(escapeSegment(raw)).toBe(esc);
    expect(unescapeSegment(esc)).toBe(raw);
  });
  it.each(vectors.segments.invalidEscaped)("rejects noncanonical escaped %j", (s) => {
    expect(() => unescapeSegment(s)).toThrow();
  });
  it.each(vectors.segments.invalidRaw)("rejects raw %j", (s) => {
    expect(() => escapeSegment(s)).toThrow();
  });
});

describe("addresses", () => {
  it.each(vectors.addresses)("$string", (v) => {
    expect(formatAddress(v.address)).toBe(v.string);
    expect(parseAddress(v.string)).toEqual(v.address);
    expect(addressToPath(v.address, v.form)).toBe(v.path);
    expect(pathToAddress(v.path)).toEqual({ address: v.address, form: v.form });
  });
  it.each(vectors.invalidAddressStrings)("rejects address %j", (s) => {
    expect(() => parseAddress(s)).toThrow(AddressError);
  });
  it.each(vectors.invalidPaths)("ignores path %j", (p) => {
    expect(pathToAddress(p)).toBeNull();
  });
  it("rejects a form that does not fit the kind", () => {
    expect(() => addressToPath({ device: "P", kind: "tagtable", groups: [], name: "T" }, "scl")).toThrow(AddressError);
  });
  it("rejects empty namespace and empty unit", () => {
    expect(() => formatAddress({ device: "P", kind: "block", groups: [], name: "X", namespace: "" })).toThrow(AddressError);
    expect(() => formatAddress({ device: "P", unit: "", kind: "block", groups: [], name: "X" })).toThrow(AddressError);
  });
  it("keeps namespace and group apart", () => {
    const a = formatAddress({ device: "P", kind: "block", groups: ["Fx"], name: "M" });
    const b = formatAddress({ device: "P", kind: "block", groups: [], name: "M", namespace: "Fx" });
    expect(a).not.toBe(b);
  });
});

describe("findCaseCollisions", () => {
  it("reports case-only duplicates", () => {
    expect(findCaseCollisions(["plc/P/blocks/A.scl", "plc/P/blocks/a.scl", "plc/P/blocks/b.scl"])).toEqual([
      ["plc/P/blocks/A.scl", "plc/P/blocks/a.scl"],
    ]);
  });
  it("treats Unicode-normalization twins as collisions", () => {
    expect(findCaseCollisions(["plc/P/blocks/Ü.scl", "plc/P/blocks/Ü.scl"])).toHaveLength(1);
  });
});
