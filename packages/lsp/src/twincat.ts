// SPDX-License-Identifier: BUSL-1.1
// TwinCAT 3 / CODESYS-style sources stored as XML (.TcPOU, .TcDUT, .TcGVL): the ST code lives in CDATA
// sections of <Declaration> and <ST>. We blank everything else to spaces (keeping newlines), so the code
// can be parsed in place and every offset still points into the original file.

export const TWINCAT_FILE = /\.(TcPOU|TcDUT|TcGVL|TcIO)$/i;

export interface TwinCatUnit {
  /** Same length as the XML, code kept, everything else blanked. */
  code: string;
  /** Object name from the root element's Name attribute (POU/DUT/GVL). */
  name?: string;
  kind?: "POU" | "DUT" | "GVL" | "ITF";
}

export function extractTwinCat(xml: string): TwinCatUnit {
  const out = xml.replace(/[^\n\r]/g, " ").split("");
  const keep = (from: number, to: number) => {
    for (let i = from; i < to; i++) out[i] = xml[i]!;
  };
  // <Declaration><![CDATA[ ... ]]></Declaration> and <ST><![CDATA[ ... ]]></ST> anywhere (POU, Method, Action)
  const re = /<(Declaration|ST)>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/\1>/g;
  for (const m of xml.matchAll(re)) {
    const start = m.index! + m[0].indexOf("<![CDATA[") + "<![CDATA[".length;
    keep(start, start + m[2]!.length);
    // separate consecutive sections so tokens from two CDATA blocks never merge
    if (start - 1 >= 0 && out[start - 1] !== "\n") out[start - 1] = " ";
  }
  // a <Property> keeps its accessors as <Get>/<Set> elements: their keywords go into the blanked markup (GET over
  // the opening tag, END_GET over </Implementation>), so the code reads as CODESYS writes a property as text
  for (const m of xml.matchAll(/<(Get|Set)\b[^>]*>[\s\S]*?<\/\1>/g)) {
    const word = m[1]!.toUpperCase();
    const write = (at: number, text: string) => {
      for (let k = 0; k < text.length; k++) out[at + k] = text[k]!;
    };
    write(m.index!, word);
    const close = m[0].lastIndexOf("</Implementation>");
    if (close >= 0) write(m.index! + close, "END_" + word);
  }
  const root = /<(POU|DUT|GVL|Itf)\s[^>]*Name="([^"]+)"/.exec(xml);
  return { code: out.join(""), ...(root ? { name: root[2], kind: (root[1]!.toUpperCase() === "ITF" ? "ITF" : root[1]!.toUpperCase()) as TwinCatUnit["kind"] } : {}) };
}
