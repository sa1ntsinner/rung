// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { layoutRung, rungWidth, type LadderElement, type Shape } from "../src/core/ladderLayout";

const contact = (operand: string): LadderElement => ({ k: "contact", operand, negated: false });
const coil = (operand: string): LadderElement => ({ k: "coil", operand, kind: "", negated: false });
const texts = (shapes: Shape[]) => shapes.filter((s): s is Extract<Shape, { t: "text" }> => s.t === "text");
const at = (shapes: Shape[], s: string) => texts(shapes).find((t) => t.s === s)!;

describe("ladder layout", () => {
  it("puts the coil at the right edge of the room it gets, as TIA Portal does", () => {
    const rung = [contact('"Start"'), coil('"Run"')];
    const narrow = layoutRung(rung);
    const wide = layoutRung(rung, 900);
    expect(wide.width).toBe(900);
    expect(at(wide.shapes, '"Start"').x).toBe(at(narrow.shapes, '"Start"').x);
    expect(at(wide.shapes, '"Run"').x).toBeGreaterThan(800);
    expect(narrow.width).toBe(rungWidth(rung));
  });

  it("stacks parallel branches below the first and joins them on both sides", () => {
    const l = layoutRung([{ k: "par", merge: true, branches: [[contact('"A"')], [contact('"B"'), contact('"C"')]] }, coil('"Q"')]);
    const a = at(l.shapes, '"A"'), b = at(l.shapes, '"B"');
    expect(b.y).toBeGreaterThan(a.y);
    expect(b.x).toBe(a.x);
    // two vertical joins: where the branches split and where they meet
    expect(l.shapes.filter((s) => s.t === "line" && s.x1 === s.x2 && s.y2 > s.y1 && s.cls !== "lad-rail" && s.cls !== "lad-sym").length).toBe(2);
  });

  it("leaves a box nothing follows where it is, without a wire out of it", () => {
    const l = layoutRung([contact('"Go"'), { k: "box", name: "Add", flowIn: "en", inputs: [{ pin: "in1", operand: "1" }], outputs: [{ pin: "out", operand: '"X"' }] }], 1200);
    const box = l.shapes.find((s) => s.t === "rect")!;
    expect(box.t === "rect" && box.x).toBeLessThan(400);
    const right = box.t === "rect" ? box.x + box.w : 0;
    expect(l.shapes.some((s) => s.t === "line" && s.x1 >= right)).toBe(false);
  });

  it("connects coils in series and ends the line at the last one", () => {
    const l = layoutRung([contact('"A"'), coil('"X"'), coil('"Y"')], 600);
    const x = at(l.shapes, '"X"').x, y = at(l.shapes, '"Y"').x;
    const flow = l.shapes.filter((s): s is Extract<Shape, { t: "line" }> => s.t === "line" && s.y1 === s.y2 && !s.cls);
    // the wire after X reaches toward Y; nothing is drawn right of Y's coil
    expect(flow.some((s) => s.x1 > x && s.x1 < y && s.x2 > x + 20)).toBe(true);
    expect(flow.some((s) => s.x1 > y)).toBe(false);
  });

  it("cuts a long operand to fit and keeps it whole for the tooltip and the click", () => {
    const long = '"A_really_long_tag_name_that_goes_on".member';
    const t = at(layoutRung([contact(long), coil('"Q"')]).shapes, texts(layoutRung([contact(long), coil('"Q"')]).shapes)[0]!.s);
    expect(t.s.endsWith("…")).toBe(true);
    expect(t.full).toBe(long);
  });
});
