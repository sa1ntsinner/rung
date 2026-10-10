// SPDX-License-Identifier: BUSL-1.1
// Which HMI tags of a Basic/Comfort panel are bound to a PLC tag or DB member, and on which screens they show: read
// from the XML `rung views` writes (views/hmi/<panel>/tags/*.xml, screens/*.xml), as TIA Portal exported it.
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface HmiTag {
  panel: string;
  table: string;
  /** the HMI tag's own name */
  tag: string;
  /** what it is bound to on the PLC (ControllerTag): a tag name, or DB.member */
  plc: string;
  connection?: string;
}
export interface HmiUse extends HmiTag {
  screens: string[];
}

const text = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The HMI tags of one exported tag table with what each is bound to (tags without a PLC binding are internal). */
export function hmiTagsOf(xml: string, panel: string, table: string): HmiTag[] {
  const out: HmiTag[] = [];
  for (const m of xml.matchAll(/<Hmi\.Tag\.Tag\b[\s\S]*?<\/Hmi\.Tag\.Tag>/g)) {
    const block = m[0];
    const name = /<AttributeList>[\s\S]*?<Name>([^<]*)<\/Name>/.exec(block)?.[1];
    const plc = /<ControllerTag\b[^>]*>\s*<Name>([^<]*)<\/Name>/.exec(block)?.[1];
    if (!name || !plc) continue;
    const connection = /<Connection\b[^>]*>\s*<Name>([^<]*)<\/Name>/.exec(block)?.[1];
    out.push({ panel, table, tag: text(name), plc: text(plc), ...(connection ? { connection: text(connection) } : {}) });
  }
  return out;
}

/** The HMI tags a screen's objects are connected to. */
export function screenTagsOf(xml: string): Set<string> {
  return new Set([...xml.matchAll(/<Tag\b[^>]*TargetID="@OpenLink"[^>]*>\s*<Name>([^<]*)<\/Name>/g)].map((m) => text(m[1]!)));
}

/** "Line_DB".Speed, Line_DB.Speed and line_db.speed name the same thing. */
export const plcKey = (name: string) => name.replace(/"/g, "").toUpperCase();

export class HmiIndex {
  constructor(readonly tags: HmiTag[] = [], readonly screens: { panel: string; screen: string; tags: Set<string> }[] = []) {}

  /** The HMI tags bound to this PLC name, each with the screens that show it. */
  usesOf(plcName: string): HmiUse[] {
    const key = plcKey(plcName);
    return this.tags.filter((t) => plcKey(t.plc) === key).map((t) => ({
      ...t,
      screens: this.screens.filter((s) => s.panel === t.panel && s.tags.has(t.tag)).map((s) => s.screen).sort(),
    }));
  }

  static async load(root: string): Promise<HmiIndex> {
    const tags: HmiTag[] = [];
    const screens: { panel: string; screen: string; tags: Set<string> }[] = [];
    const base = join(root, "views", "hmi");
    const panels = await readdir(base, { withFileTypes: true }).catch(() => []);
    const xmlIn = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await xmlIn(p)));
        else if (e.name.endsWith(".xml")) out.push(p);
      }
      return out;
    };
    for (const p of panels.filter((e) => e.isDirectory())) {
      const panel = decodeURIComponent(p.name);
      for (const f of await xmlIn(join(base, p.name, "tags"))) tags.push(...hmiTagsOf(await readFile(f, "utf8"), panel, decodeURIComponent(basename(f, ".xml"))));
      for (const f of await xmlIn(join(base, p.name, "screens"))) screens.push({ panel, screen: decodeURIComponent(basename(f, ".xml")), tags: screenTagsOf(await readFile(f, "utf8")) });
    }
    return new HmiIndex(tags, screens);
  }
}
