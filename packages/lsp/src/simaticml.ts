// SPDX-License-Identifier: BUSL-1.1
// SimaticML (TIA Portal XML exports, as written by Openness and the VCI export): block interfaces,
// PLC data types and technology object names. Only what editors need is read; offsets point into the XML
// so go-to-definition lands on the member's Name attribute.
import type { BlockKind, BlockModel, Section, VarDecl } from "./parser.js";
import { translateNetworks } from "./flgnet.js";

interface XmlAttr {
  value: string;
  /** Offset of the attribute value (inside the quotes). */
  start: number;
  /** Length of the raw (still escaped) value. */
  rawLength: number;
}

export interface XmlNode {
  name: string;
  attrs: Record<string, XmlAttr>;
  children: XmlNode[];
  text: string;
  /** Offset of the first text character (for `<Name>X</Name>`: where X starts). */
  textStart: number;
  textRawLength: number;
  start: number;
  end: number;
}

const decode = (s: string) =>
  s.replace(/&(quot|lt|gt|amp|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l === "quot") return '"';
    if (l === "lt") return "<";
    if (l === "gt") return ">";
    if (l === "amp") return "&";
    if (l === "apos") return "'";
    return String.fromCodePoint(l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
  });

/** A tolerant, offset-preserving XML reader (enough for machine-written SimaticML). */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "", textStart: 0, textRawLength: 0, start: 0, end: xml.length };
  const stack: XmlNode[] = [root];
  const top = () => stack[stack.length - 1]!;
  const addText = (from: number, raw: string, decoded: string) => {
    const t = top();
    if (!t.text && raw.trim()) {
      const lead = raw.length - raw.trimStart().length;
      t.textStart = from + lead;
      t.textRawLength = raw.trim().length;
    }
    t.text += decoded;
  };
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) addText(i, xml.slice(i, lt), decode(xml.slice(i, lt)));
    if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const e = xml.indexOf("]]>", lt + 9);
      const end = e < 0 ? n : e;
      addText(lt + 9, xml.slice(lt + 9, end), xml.slice(lt + 9, end));
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const e = xml.indexOf(">", lt + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) break;
    const inner = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      // pop to the matching element (tolerates unbalanced input)
      for (let k = stack.length - 1; k > 0; k--)
        if (stack[k]!.name === name) {
          for (let j = stack.length - 1; j >= k; j--) stack[j]!.end = i;
          stack.length = k;
          break;
        }
      continue;
    }
    const m = /^([^\s/>]+)/.exec(inner);
    if (!m) continue;
    const node: XmlNode = { name: m[1]!, attrs: {}, children: [], text: "", textStart: gt + 1, textRawLength: 0, start: lt, end: i };
    for (const a of inner.slice(m[1]!.length).matchAll(/([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const raw = a[3] ?? a[4] ?? "";
      node.attrs[a[1]!] = { value: decode(raw), start: lt + 1 + m[1]!.length + a.index! + a[0].indexOf(a[2]!) + 1, rawLength: raw.length };
    }
    top().children.push(node);
    if (!inner.endsWith("/")) stack.push(node);
  }
  return root;
}

const child = (n: XmlNode | undefined, name: string) => n?.children.find((c) => c.name === name);
const children = (n: XmlNode | undefined, name: string) => n?.children.filter((c) => c.name === name) ?? [];

function* walk(n: XmlNode): Generator<XmlNode> {
  yield n;
  for (const c of n.children) yield* walk(c);
}

const BLOCK_KINDS: Record<string, BlockKind> = {
  "SW.Blocks.FB": "FB",
  "SW.Blocks.FC": "FC",
  "SW.Blocks.OB": "OB",
  "SW.Blocks.GlobalDB": "DB",
  "SW.Blocks.InstanceDB": "DB",
  "SW.Blocks.ArrayDB": "DB",
  "SW.Types.PlcStruct": "UDT",
};

const SECTIONS: Record<string, Section> = { Input: "Input", Output: "Output", InOut: "InOut", Static: "Static", Temp: "Temp", Constant: "Constant", Return: "Return", None: "Member" };

const unquoteType = (t: string) => t.replace(/^"|"$/g, "");

function member(m: XmlNode, section: Section): VarDecl | undefined {
  const name = m.attrs.Name;
  if (!name) return undefined;
  const type = m.attrs.Datatype?.value ?? "?";
  const arr = /^\s*array\s*\[[^\]]*\]\s*of\s+(.+)$/i.exec(type);
  const base = (arr ? arr[1]! : type).trim();
  const nested = children(m, "Member")
    .map((x) => member(x, "Member"))
    .filter((x): x is VarDecl => !!x);
  const comment = child(child(m, "Comment"), "MultiLanguageText")?.text.trim();
  const init = child(m, "StartValue")?.text.trim();
  const isStruct = /^struct$/i.test(base);
  return {
    name: name.value,
    start: name.start,
    end: name.start + name.rawLength,
    section,
    type,
    ...(isStruct ? {} : { typeRef: unquoteType(base.replace(/\[.*$/, "")) }),
    isArray: !!arr,
    ...(nested.length ? { members: nested } : {}),
    ...(init ? { init } : {}),
    ...(comment ? { comment } : {}),
  };
}

export interface SimaticMlUnit {
  blocks: BlockModel[];
  /** Named objects without an interface the editor can use (technology objects). */
  objects: { name: string; start: number; end: number; type?: string; number?: string }[];
}

/** True when the text looks like a SimaticML export (checked before parsing large XML files). */
export const isSimaticMl = (xml: string) => /<Document\b/.test(xml.slice(0, 4096)) && /<SW\./.test(xml);

/** Blocks, UDTs and technology objects in a SimaticML document (tag tables are read by parseTags). */
export function parseSimaticMl(xml: string): SimaticMlUnit {
  const out: SimaticMlUnit = { blocks: [], objects: [] };
  if (!isSimaticMl(xml)) return out;
  for (const n of walk(parseXml(xml))) {
    const attrs = child(n, "AttributeList");
    const nameNode = child(attrs, "Name");
    if (n.name.startsWith("SW.TechnologicalObjects.") && nameNode) {
      const type = child(attrs, "InstanceOfName")?.text.trim();
      const number = child(attrs, "Number")?.text.trim();
      out.objects.push({ name: nameNode.text.trim(), start: nameNode.textStart, end: nameNode.textStart + nameNode.textRawLength, ...(type ? { type } : {}), ...(number ? { number } : {}) });
      continue;
    }
    const kind = BLOCK_KINDS[n.name];
    if (!kind || !nameNode) continue;
    const block: BlockModel = {
      kind,
      name: nameNode.text.trim(),
      nameStart: nameNode.textStart,
      nameEnd: nameNode.textStart + nameNode.textRawLength,
      start: n.start,
      end: n.end,
      vars: [],
      regions: [],
      refs: [],
      xml: true,
    };
    const of = child(attrs, "InstanceOfName")?.text.trim();
    if (of) block.dbOf = of;
    for (const s of children(child(child(attrs, "Interface"), "Sections"), "Section")) {
      const section = SECTIONS[s.attrs.Name?.value ?? ""] ?? "Static";
      for (const m of children(s, "Member")) {
        const v = member(m, section);
        if (!v) continue;
        if (section === "Return") {
          if (!/^void$/i.test(v.type)) block.returnType = v.type;
          continue;
        }
        block.vars.push(v);
      }
    }
    if (kind === "FC" && !block.returnType) block.returnType = "Void";
    if ((kind === "FB" || kind === "FC" || kind === "OB") && /^(LAD|FBD)$/.test(child(attrs, "ProgrammingLanguage")?.text.trim() ?? "")) {
      const t = translateNetworks(n);
      block.lad = t.scl;
      if (t.unsupported.length) block.ladUnsupported = t.unsupported;
      if (t.temps.length) block.ladTemps = t.temps;
      block.refs.push(...t.refs);
    }
    out.blocks.push(block);
  }
  return out;
}
