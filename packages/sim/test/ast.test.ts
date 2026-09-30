// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { parseBody, parseTime, SclSyntaxError } from "../src/ast.js";

describe("parseTime", () => {
  it("converts TIME literals to milliseconds", () => {
    expect(parseTime("T#1s500ms")).toBe(1500);
    expect(parseTime("TIME#2h")).toBe(7_200_000);
    expect(parseTime("LT#10ms")).toBe(10);
    expect(parseTime("T#-1m")).toBe(-60_000);
    expect(parseTime("T#1d_2h")).toBe(93_600_000);
  });
});

describe("parseBody", () => {
  it("respects operator precedence", () => {
    const [s] = parseBody("#x := 1 + 2 * 3 > 6 AND NOT #b OR #c;");
    expect(s).toMatchObject({ k: "assign", value: { k: "bin", op: "OR", l: { k: "bin", op: "AND", l: { k: "bin", op: ">", l: { k: "bin", op: "+" } }, r: { k: "un", op: "NOT" } } } });
  });

  it("parses calls with named inputs and outputs, member and index paths", () => {
    const [s] = parseBody('#t(IN := #a[#i + 1].x, PT := T#20ms, ET => "Db".Station.Elapsed);');
    expect(s).toMatchObject({ k: "call", call: { callee: { root: { kind: "local", name: "t" } }, args: [{ name: "IN" }, { name: "PT", value: { value: 20, type: "time" } }, { name: "ET", out: true }] } });
  });

  it("parses IF/ELSIF/ELSE, CASE with ranges and lists, loops and regions", () => {
    const body = parseBody(`
      REGION main
        IF #a THEN #x := 1; ELSIF #b THEN #x := 2; ELSE #x := 3; END_IF;
        CASE #m OF
          0, 1: #y := 1;
          2..5: #y := 2;
               #z := 1;
          ELSE #y := 3;
        END_CASE;
        FOR #i := 0 TO 9 BY 2 DO IF #i = 4 THEN EXIT; END_IF; END_FOR;
        WHILE #n > 0 DO #n := #n - 1; END_WHILE;
        REPEAT #n := #n + 1; UNTIL #n >= 3 END_REPEAT;
      END_REGION`);
    // a REGION's statements are in the list around it (a GOTO outside finds a label inside)
    expect(body.map((s) => s.k)).toEqual(["if", "case", "for", "while", "repeat"]);
    expect((body[1] as { items: { body: unknown[] }[] }).items.map((i) => i.body.length)).toEqual([1, 2]);
  });

  it("parses literals of every kind", () => {
    const [s] = parseBody("#x := 16#FF + 2#101 + DINT#5 + 1.5e2 + 'it''s';");
    const lits: unknown[] = [];
    const walk = (e: { k: string; l?: unknown; r?: unknown; value?: unknown }) => (e.k === "bin" ? (walk(e.l as never), walk(e.r as never)) : lits.push(e.value));
    walk((s as { value: never }).value);
    expect(lits).toEqual([255, 5, 5, 150, "it's"]);
  });

  it("reports syntax errors with offsets", () => {
    expect(() => parseBody("IF #a THEN #x := 1;")).toThrow(SclSyntaxError);
    try {
      parseBody("#x := ;");
    } catch (e) {
      expect((e as SclSyntaxError).offset).toBe(6);
    }
  });
});
