// SPDX-License-Identifier: MIT
// The site's parts that move: the sync demo, the workspace explorer, the playground (rung's own simulator, built
// for the browser), the recorded soak runs, and the small things. With prefers-reduced-motion everything is at rest.
import { PRESETS } from "./presets.js";

document.documentElement.classList.add("js");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ------------------------------------------------------------------ highlighting, one line at a time
const KEYWORDS = new Set(
  "FUNCTION_BLOCK END_FUNCTION_BLOCK FUNCTION END_FUNCTION ORGANIZATION_BLOCK END_ORGANIZATION_BLOCK DATA_BLOCK END_DATA_BLOCK TYPE END_TYPE STRUCT END_STRUCT VAR_INPUT VAR_OUTPUT VAR_IN_OUT VAR_TEMP VAR_GLOBAL VAR CONSTANT END_VAR BEGIN IF THEN ELSE ELSIF END_IF CASE OF END_CASE FOR TO BY DO END_FOR WHILE END_WHILE REPEAT UNTIL END_REPEAT RETURN EXIT CONTINUE AND OR XOR NOT MOD TRUE FALSE NETWORK END_NETWORK TITLE RUNG END_RUNG VERSION NON_RETAIN RETAIN AT REGION END_REGION".split(" "),
);
const TYPES = new Set("Bool Byte Word DWord LWord Int DInt UInt UDInt SInt USInt LInt Real LReal Time LTime Date TOD DTL String Char Void TON TOF TP TON_TIME CTU CTD CTUD R_TRIG F_TRIG".split(" ").map((t) => t.toUpperCase()));
const FUNCS = new Set("LIMIT MIN MAX SEL MUX ABS SQRT CONTACT COIL MOVE".split(" "));
const RULES = {
  scl: [
    [/\/\/.*/y, "c"],
    [/\(\*.*?\*\)/y, "c"],
    [/'(?:[^'$]|\$.)*'/y, "s"],
    [/"[^"]*"/y, "s"],
    [/(?:LT|T|TIME|S5T|DINT|INT|W|DW|B|L)#[\w.+-]+/iy, "n"],
    [/%[IQMD][A-Z]?\d+(?:\.\d+)?/iy, "a"],
    [/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, "n"],
    [/#[A-Za-z_]\w*/y, ""],
    [/[A-Za-z_]\w*/y, "word"],
  ],
  yaml: [
    [/#.*/y, "c"],
    [/"[^"]*"|'[^']*'/y, "s"],
    [/[A-Za-z_][\w.[\]]*(?=:(?:\s|$))/y, "k"],
    [/(?:true|false|null)\b/y, "n"],
    [/-?\d+(?:\.\d+)?(?:ms|s)?\b/y, "n"],
  ],
  toml: [
    [/#.*/y, "c"],
    [/\[[^\]]*\]/y, "k"],
    [/"(?:[^"\\]|\\.)*"/y, "s"],
    [/[A-Za-z_][\w-]*(?=\s*=)/y, "t"],
    [/(?:true|false)\b|\d+/y, "n"],
  ],
  xml: [
    [/<!--.*?-->/y, "c"],
    [/<\/?[\w.:]+|\/?>/y, "k"],
    [/[\w.:-]+(?==)/y, "t"],
    [/"[^"]*"/y, "s"],
  ],
  md: [
    [/^#+ .*/y, "k"],
    [/`[^`]*`/y, "s"],
    [/\*\*[^*]+\*\*/y, "f"],
    [/<!--.*?-->/y, "c"],
  ],
};
const modeOf = (file) =>
  /\.(scl|awl|db|udt|s7dcl|st)$/i.test(file) ? "scl" : /\.ya?ml$/i.test(file) ? "yaml" : /\.toml$/i.test(file) ? "toml" : /\.(xml|s7res)$/i.test(file) ? "xml" : /\.md$/i.test(file) ? "md" : "text";
function hlLine(line, mode) {
  const rules = RULES[mode];
  if (!rules) return esc(line);
  let out = "";
  let i = 0;
  while (i < line.length) {
    let hit = false;
    for (const [re, cls] of rules) {
      re.lastIndex = i;
      const m = re.exec(line);
      if (!m || !m[0].length) continue;
      let c = cls;
      if (c === "word") {
        const u = m[0].toUpperCase();
        c = KEYWORDS.has(u) ? "k" : TYPES.has(u) ? "t" : FUNCS.has(u) ? "f" : "";
      }
      out += c ? `<span class="${c}">${esc(m[0])}</span>` : esc(m[0]);
      i += m[0].length;
      hit = true;
      break;
    }
    if (!hit) {
      out += esc(line[i]);
      i++;
    }
  }
  return out;
}
const lines = (text, mode) => text.split("\n").map((l, i) => `<span class="ln" data-n="${i + 1}">${hlLine(l, mode) || " "}</span>`).join("");

// ------------------------------------------------------------------ header
const top = $(".top");
const onScroll = () => top.classList.toggle("scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();
const menu = $(".menu");
const nav = $("#nav");
menu?.addEventListener("click", () => {
  const open = nav.classList.toggle("open");
  menu.setAttribute("aria-expanded", String(open));
  menu.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
});
$$("#nav a").forEach((a) => a.addEventListener("click", () => nav.classList.remove("open")));

// ------------------------------------------------------------------ copy buttons
async function copyText(button, text) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
    button.classList.add("done");
  } catch {
    button.textContent = "Select the text instead";
  }
  setTimeout(() => {
    button.textContent = label;
    button.classList.remove("done");
  }, 1600);
}
$$("[data-copy]").forEach((b) => b.addEventListener("click", () => copyText(b, b.dataset.copy.replace(/&#10;/g, "\n"))));

// ------------------------------------------------------------------ the sync demo
// What rung watch prints for each pass (cli/twoway.ts), as it prints it.
const counts = (e, i, c, m, x) =>
  `exported ${e ? `<b>${e}</b>` : 0}  imported ${i ? `<b>${i}</b>` : 0}  created ${c}  merged ${m ? `<b>${m}</b>` : 0}  conflicts ${x ? `<b class="bad">${x}</b>` : 0}  pending-deletes 0  removed 0  unchanged 41`;
const COMPILED = `  info     COMPILE            plc/PLC_1/blocks/10_Drives/Fx_Motor.scl — <span class="ok">Compiling finished (errors: 0; warnings: 0)</span>`;
const CONFLICTED = `  <span class="bad">error    CONFLICT           plc/PLC_1/blocks/10_Drives/Fx_Motor.scl — Edited in the workspace and in TIA Portal; resolve with rung resolve</span>`;

const BASE = [
  'FUNCTION_BLOCK "Fx_Motor"',
  "   VAR_INPUT",
  "      Start : Bool;",
  "      Stop : Bool;",
  "      Speed : Real;   // rpm",
  "   END_VAR",
  "BEGIN",
  "\t#Latch := (#Start OR #Latch) AND NOT #Stop;",
  "\t#Running := #Latch;",
  "\t#Overspeed := #Speed > 3000.0;",
  "END_FUNCTION_BLOCK",
];
const READY = "\t#Ready := #Running AND NOT #Overspeed;";
const FAULT = "      Fault : Bool;";
const RUNNING_FAULT = "\t#Running := #Latch AND NOT #Fault;";
const over = (v) => `\t#Overspeed := #Speed > ${v};`;
// the state each scene starts from
const S1 = BASE.map((l, i) => (i === 9 ? over("2500.0") : l));
const S2 = [...S1.slice(0, 10), READY, ...S1.slice(10)];
const S3 = [...S2.slice(0, 5), FAULT, ...S2.slice(5, 8), RUNNING_FAULT, over("2400.0"), ...S2.slice(10)];

const SCENES = {
  save: { caption: "Import through Openness → compile → update the file", ms: 8200 },
  tia: { caption: "TIA Portal changes sync back to the file", ms: 6400 },
  both: { caption: "Different lines changed on both sides: three-way merge, SCL by line, LAD and FBD by network", ms: 9000 },
  conflict: { caption: "Same line changed on both sides. Sync stops for review", ms: 9000 },
};
const ORDER = Object.keys(SCENES);

const demo = $(".demo");
if (demo) {
  const file = $('[data-pane="file"]', demo);
  const tia = $('[data-pane="tia"]', demo);
  const editor = $(".editor", demo);
  const status = $(".status", demo);
  const statusText = $(".text", status);
  const log = $(".log", demo);
  const caption = $(".scene-caption", demo);
  const tabs = $$(".scenes button", demo);
  const sclTab = $('[data-tab="scl"]', demo);
  const conflictTab = $('[data-tab="conflict"]', demo);
  const pauseBtn = $(".pause", demo);
  const sparkTia = $(".spark.to-tia", demo);
  const sparkFile = $(".spark.to-file", demo);
  const duo = $(".duo", demo);
  const viewTabs = $$(".views button", demo);
  // on a phone one side shows at a time: the one where something happens
  const view = (side) => {
    duo.dataset.view = side;
    viewTabs.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === side)));
  };
  viewTabs.forEach((b) => b.addEventListener("click", () => view(b.dataset.view)));

  const render = (pre, ls) => (pre.innerHTML = lines(ls.join("\n"), "scl"));
  const lineOf = (pre, n) => $$(".ln", pre)[n - 1];
  const setLine = (pre, n, text, caret, warm) => {
    const ln = lineOf(pre, n);
    if (!ln) return;
    ln.innerHTML = caret === undefined ? hlLine(text, "scl") || " " : `${hlLine(text.slice(0, caret), "scl")}<span class="caret${warm ? " warm" : ""}"></span>${hlLine(text.slice(caret), "scl")}`;
  };
  const insertLine = (pre, after, text) => {
    const ln = document.createElement("span");
    ln.className = "ln";
    ln.innerHTML = hlLine(text, "scl") || " ";
    lineOf(pre, after).after(ln);
    $$(".ln", pre).forEach((l, i) => (l.dataset.n = String(i + 1)));
    return ln;
  };
  const mark = (pre, n, cls, note) => {
    const ln = lineOf(pre, n);
    if (!ln) return;
    if (cls) ln.classList.add(cls);
    if (note) ln.dataset.note = note;
  };
  const unmark = (pre) => $$(".ln", pre).forEach((l) => (l.classList.remove("hl-power", "hl-warm", "hl-bad"), delete l.dataset.note));
  const say = (html) => {
    const row = document.createElement("span");
    row.className = "row";
    row.innerHTML = html;
    log.append(row);
    while (log.children.length > 3) log.firstElementChild.remove();
  };
  const setStatus = (kind, text) => {
    status.className = `status ${kind}`;
    statusText.textContent = text;
  };
  const showConflictFile = (on) => {
    conflictTab.classList.toggle("shown", on);
    conflictTab.classList.toggle("on", on);
    sclTab.classList.toggle("on", !on);
  };
  const fire = async (spark) => {
    spark.classList.remove("go");
    void spark.offsetWidth;
    spark.classList.add("go");
    await pace(700);
  };

  // typing replaces `from` with `to` inside line n, where `from` stands
  async function retype(pre, n, text, from, to, warm) {
    const at = text.indexOf(from);
    const before = text.slice(0, at);
    const after = text.slice(at + from.length);
    for (let i = from.length; i >= 0; i--) {
      setLine(pre, n, before + from.slice(0, i) + after, at + i, warm);
      await pace(45);
    }
    for (let j = 1; j <= to.length; j++) {
      setLine(pre, n, before + to.slice(0, j) + after, at + j, warm);
      await pace(85);
    }
    setLine(pre, n, before + to + after);
    return before + to + after;
  }
  async function typeIn(pre, after, text, warm, note) {
    const ln = insertLine(pre, after, "");
    if (note) (ln.classList.add(warm ? "hl-warm" : "hl-power"), (ln.dataset.note = note));
    for (let i = 1; i <= text.length; i++) {
      ln.innerHTML = `${hlLine(text.slice(0, i), "scl")}<span class="caret${warm ? " warm" : ""}"></span>`;
      await pace(i === 1 ? 120 : 30);
    }
    ln.innerHTML = hlLine(text, "scl");
    return ln;
  }

  // pausing: every wait of a scene goes through pace(), which holds while paused and ends early on a jump
  let paused = false;
  let jump = null;
  let token = 0;
  async function pace(ms) {
    const mine = token;
    let left = ms;
    while (left > 0) {
      if (mine !== token) throw new Error("jump");
      await wait(Math.min(left, 50));
      if (!paused) left -= 50;
    }
    if (mine !== token) throw new Error("jump");
  }

  const start = (scene) => {
    const from = { save: BASE, tia: S1, both: S2, conflict: S3 }[scene];
    render(file, from);
    render(tia, from);
    view(scene === "tia" ? "tia" : "file");
    editor.classList.remove("is-dirty");
    showConflictFile(false);
    file.scrollTop = 0;
    log.innerHTML = "";
    setStatus("", "In sync");
    caption.textContent = SCENES[scene].caption;
  };

  const PLAY = {
    async save() {
      await pace(900);
      editor.classList.add("is-dirty");
      const t = await retype(file, 10, BASE[9], "3000.0", "2500.0");
      await pace(450);
      editor.classList.remove("is-dirty");
      mark(file, 10, "hl-power", "saved");
      await fire(sparkTia);
      view("tia");
      setStatus("busy", "Importing through Openness…");
      setLine(tia, 10, t);
      mark(tia, 10, "hl-power");
      say(counts(0, 1, 0, 0, 0));
      await pace(900);
      setStatus("busy", "Compiling…");
      await pace(900);
      setStatus("ok", "Fx_Motor compiled · 0 errors, 0 warnings");
      say(COMPILED);
      await pace(1600);
    },
    async tia() {
      await pace(800);
      setStatus("busy", "Edited in TIA Portal");
      await typeIn(tia, 10, READY, true, "edited in TIA Portal");
      await pace(900);
      await fire(sparkFile);
      view("file");
      unmark(tia);
      const ln = insertLine(file, 10, READY);
      ln.classList.add("hl-warm");
      ln.dataset.note = "from TIA Portal";
      say(counts(1, 0, 0, 0, 0));
      setStatus("ok", "In sync · the file follows TIA Portal");
      await pace(1800);
    },
    async both() {
      await pace(700);
      // the file: a new input, used on the Running line
      editor.classList.add("is-dirty");
      await typeIn(file, 5, FAULT, false, "in the file");
      await pace(250);
      await retype(file, 10, S2[8], "#Latch;", "#Latch AND NOT #Fault;");
      mark(file, 10, "hl-power", "in the file");
      // meanwhile in TIA Portal: another line
      await pace(400);
      view("tia");
      setStatus("busy", "Edited in TIA Portal");
      await retype(tia, 10, S2[9], "2500.0", "2400.0", true);
      mark(tia, 10, "hl-warm", "in TIA Portal");
      await pace(400);
      editor.classList.remove("is-dirty");
      await fire(sparkTia);
      setStatus("busy", "Merging: both sides changed Fx_Motor");
      await pace(900);
      // merged into both
      render(tia, S3);
      mark(tia, 6, "hl-power");
      mark(tia, 10, "hl-power");
      mark(tia, 11, "hl-warm");
      view("file");
      setLine(file, 11, S3[10]);
      mark(file, 11, "hl-warm", "from TIA Portal");
      say(counts(0, 0, 0, 1, 0));
      setStatus("busy", "Compiling…");
      await pace(800);
      setStatus("ok", "Both changes kept · compiled, 0 errors");
      say(COMPILED);
      await pace(2000);
    },
    async conflict() {
      await pace(700);
      editor.classList.add("is-dirty");
      await retype(file, 11, S3[10], "2400.0", "2200.0");
      mark(file, 11, "hl-power", "in the file");
      await pace(400);
      view("tia");
      setStatus("busy", "Edited in TIA Portal");
      await retype(tia, 11, S3[10], "2400.0", "2600.0", true);
      mark(tia, 11, "hl-warm", "in TIA Portal");
      await pace(400);
      editor.classList.remove("is-dirty");
      await fire(sparkTia);
      setStatus("bad", "Conflict: resolution required");
      say(counts(0, 0, 0, 0, 1));
      say(CONFLICTED);
      await pace(900);
      // what rung writes next to the file: both sides and their base, TIA Portal untouched
      view("file");
      showConflictFile(true);
      const marked = [...S3.slice(0, 10), "<<<<<<< file", over("2200.0"), "||||||| base", over("2400.0"), "=======", over("2600.0"), ">>>>>>> tia", ...S3.slice(11)];
      render(file, marked);
      [11, 13, 15, 17].forEach((n) => lineOf(file, n).classList.add("marker"));
      mark(file, 12, "hl-power", "file");
      mark(file, 14, "", "base");
      mark(file, 16, "hl-warm", "TIA Portal");
      file.scrollTo({ top: lineOf(file, 9).offsetTop - 14, behavior: still ? "auto" : "smooth" });
      await pace(3600);
    },
  };

  // the end of each scene, for reduced motion and for a jump while paused
  const FINAL = {
    save() {
      render(file, S1);
      render(tia, S1);
      mark(file, 10, "hl-power", "saved");
      mark(tia, 10, "hl-power");
      setStatus("ok", "Fx_Motor compiled · 0 errors, 0 warnings");
      say(counts(0, 1, 0, 0, 0));
      say(COMPILED);
    },
    tia() {
      render(file, S2);
      render(tia, S2);
      mark(file, 11, "hl-warm", "from TIA Portal");
      setStatus("ok", "In sync · the file follows TIA Portal");
      say(counts(1, 0, 0, 0, 0));
    },
    both() {
      render(file, S3);
      render(tia, S3);
      mark(file, 6, "hl-power", "in the file");
      mark(file, 10, "hl-power", "in the file");
      mark(file, 11, "hl-warm", "from TIA Portal");
      mark(tia, 6, "hl-power");
      mark(tia, 10, "hl-power");
      mark(tia, 11, "hl-warm");
      setStatus("ok", "Both changes kept · compiled, 0 errors");
      say(counts(0, 0, 0, 1, 0));
      say(COMPILED);
    },
    conflict() {
      const t = [...S3];
      t[10] = over("2600.0");
      render(tia, t);
      mark(tia, 11, "hl-warm", "in TIA Portal");
      showConflictFile(true);
      const marked = [...S3.slice(0, 10), "<<<<<<< file", over("2200.0"), "||||||| base", over("2400.0"), "=======", over("2600.0"), ">>>>>>> tia", ...S3.slice(11)];
      render(file, marked);
      [11, 13, 15, 17].forEach((n) => lineOf(file, n).classList.add("marker"));
      mark(file, 12, "hl-power", "file");
      mark(file, 14, "", "base");
      mark(file, 16, "hl-warm", "TIA Portal");
      setStatus("bad", "Conflict: resolution required");
      say(counts(0, 0, 0, 0, 1));
      say(CONFLICTED);
      requestAnimationFrame(() => (file.scrollTop = lineOf(file, 9).offsetTop - 14));
    },
  };

  let current = "save";
  const select = (scene) => {
    current = scene;
    tabs.forEach((b) => {
      const on = b.dataset.scene === scene;
      b.setAttribute("aria-selected", String(on));
      b.style.setProperty("--p", on ? "0" : ORDER.indexOf(b.dataset.scene) < ORDER.indexOf(scene) ? "1" : "0");
    });
  };
  const showFinal = (scene) => {
    select(scene);
    start(scene);
    log.innerHTML = "";
    FINAL[scene]();
    view("file");
    $(`[data-scene="${scene}"]`, demo).style.setProperty("--p", "1");
  };

  async function loop(from) {
    let i = ORDER.indexOf(from);
    for (;;) {
      const scene = ORDER[i];
      select(scene);
      start(scene);
      const tab = $(`[data-scene="${scene}"]`, demo);
      const t0 = performance.now();
      let pausedFor = 0;
      let pausedAt = 0;
      const mine = token;
      const tick = () => {
        if (mine !== token) return;
        if (paused) pausedAt ||= performance.now();
        else if (pausedAt) (pausedFor += performance.now() - pausedAt), (pausedAt = 0);
        tab.style.setProperty("--p", String(Math.min(1, (performance.now() - t0 - pausedFor - (pausedAt ? performance.now() - pausedAt : 0)) / SCENES[scene].ms)));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      try {
        await PLAY[scene]();
      } catch (e) {
        if (e.message !== "jump") throw e;
        return;
      }
      tab.style.setProperty("--p", "1");
      i = (i + 1) % ORDER.length;
      if (i === 0) tabs.forEach((b) => b.style.setProperty("--p", "0"));
    }
  }

  tabs.forEach((b) =>
    b.addEventListener("click", () => {
      token++;
      if (still || paused) showFinal(b.dataset.scene);
      else void loop(b.dataset.scene);
    }),
  );
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.setAttribute("aria-label", paused ? "Play" : "Pause");
    $("use", pauseBtn).setAttribute("href", `assets/icons.svg#${paused ? "g-play" : "g-pause"}`);
  });

  // on a phone the log stays folded until asked for
  if (matchMedia("(max-width: 760px)").matches) $(".log-box", demo).open = false;
  if (still) {
    pauseBtn.hidden = true;
    showFinal("both");
  } else {
    start("save");
    let begun = false;
    new IntersectionObserver((entries) => {
      if (!begun && entries.some((e) => e.isIntersecting)) {
        begun = true;
        void loop("save");
      }
    }).observe(demo);
  }
}

// ------------------------------------------------------------------ workspace explorer
const NOTES = {
  "rung.toml": ["rung config", "Binds the folder to the project and says how sync behaves: deletes wait for a person, and failsafe, know-how protected, system and GRAPH blocks stay read-only."],
  "AGENTS.md": ["for agents", "Written by rung for coding agents: the layout, what is read-only, and that a person downloads."],
  ".gitignore": ["git", ".rung/ is rung’s own state: merge bases, the journal, the trash. It stays out of git."],
  "plc/PLC_1/blocks/10_Drives/Motors/Fx_Motor.scl": ["SCL", "An FB in SCL, as TIA Portal exports it. The folders are the block’s groups in the project tree."],
  "plc/PLC_1/blocks/10_Drives/Fx_Counter.scl": ["SCL", "An FB with a multi-instance IEC timer."],
  "plc/PLC_1/blocks/20_Valves/Fx_Valve.scl": ["SCL", "An FC with a CASE statement."],
  "plc/PLC_1/blocks/20_Valves/Fx_LadInterlock.s7dcl": ["LAD · SIMATIC SD", "A LAD block as text: a line per contact and coil. It merges network by network and runs in rung test."],
  "plc/PLC_1/blocks/20_Valves/Fx_LadInterlock.s7res": ["SIMATIC SD", "SD’s companion file for texts; empty here."],
  "plc/PLC_1/blocks/Fx_Broken.scl": ["SCL", "Fails to compile on purpose. rung puts TIA Portal’s message on line 11, in the editor."],
  "plc/PLC_1/blocks/Fx_Global.db": ["data block", "A global DB with a member of a PLC data type."],
  "plc/PLC_1/blocks/Fx_Secret.protected.yaml": ["read-only", "Know-how protected in TIA Portal: rung can’t read its body, keeps what it can see and never imports it."],
  "plc/PLC_1/blocks/Fx_Stl.awl": ["STL", "STL, which rung test runs with the status word and both accumulators."],
  "plc/PLC_1/blocks/Main.xml": ["LAD · SimaticML", "The program cycle OB as SimaticML, TIA Portal’s XML: LAD and FBD networks that carry titles or comments stay in this form."],
  "plc/PLC_1/blocks/Motor%2FValve 1.scl": ["SCL", "A block named “Motor/Valve 1”. The slash is escaped, so any TIA Portal name is a valid file name."],
  "plc/PLC_1/force/Force table.xml": ["read-only", "A force table, mirrored for reading."],
  "plc/PLC_1/hardware/network.yaml": ["network settings", "IP addresses, subnet masks and PROFINET names of the PLC’s interfaces. A change here goes to TIA Portal with the next sync."],
  "plc/PLC_1/tags/Default tag table.tags.st": ["tag table", "A tag table as text, one tag per line."],
  "plc/PLC_1/tags/Fx_Inputs.tags.st": ["tag table", "One tag per line, address and type checked as you type."],
  "plc/PLC_1/tags/Fx_Outputs.tags.st": ["tag table", "One tag per line, address and type checked as you type."],
  "plc/PLC_1/types/Fx_Types.udt": ["PLC data type", "A PLC data type (UDT)."],
  "plc/PLC_1/watch/Fx_Watch.xml": ["watch table", "A watch table."],
  "tests/motor.test.yaml": ["rung test", "A unit test for Fx_Motor. It passes on the simulator; run it below."],
};
const RUNNABLE = { "tests/motor.test.yaml": true, "plc/PLC_1/blocks/10_Drives/Motors/Fx_Motor.scl": true };

const tree = $(".tree");
if (tree) {
  const viewerName = $(".viewer-name");
  const viewerPath = $(".viewer-path");
  const FIRST = "plc/PLC_1/blocks/10_Drives/Motors/Fx_Motor.scl";
  const viewerKind = $(".viewer-kind");
  const viewerCode = $(".viewer-code");
  const viewerNote = $(".viewer-note");
  const copyBtn = $(".viewer .copy");
  let files = {};
  let currentFile = "";

  const open = (path) => {
    currentFile = path;
    const [kind, note] = NOTES[path] ?? ["file", ""];
    viewerName.textContent = path.split("/").pop();
    viewerPath.textContent = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    viewerKind.textContent = kind;
    viewerCode.innerHTML = lines(files[path].replace(/\n$/, ""), modeOf(path));
    viewerCode.scrollTop = 0;
    viewerNote.innerHTML = esc(note) + (RUNNABLE[path] ? ` <a href="#play" class="run-here">Run it in the playground →</a>` : "");
    $$("button[data-path]", tree).forEach((b) => b.setAttribute("aria-current", String(b.dataset.path === path)));
    if (path === "plc/PLC_1/blocks/Fx_Broken.scl") {
      const ln = $$(".ln", viewerCode)[10];
      ln?.classList.add("hl-bad");
      if (ln) ln.dataset.note = "Tag #Missing not defined.";
    }
  };
  copyBtn.addEventListener("click", () => currentFile && copyText(copyBtn, files[currentFile]));
  viewerNote.addEventListener("click", (e) => {
    if (!e.target.closest(".run-here")) return;
    window.dispatchEvent(new CustomEvent("rung:play", { detail: { file: "Fx_Motor.scl", source: files["plc/PLC_1/blocks/10_Drives/Motors/Fx_Motor.scl"], test: files["tests/motor.test.yaml"], label: "Fx_Motor from the workspace" } }));
  });

  // a tree from the paths: folders first, as an editor shows them
  const build = (paths) => {
    const root = {};
    for (const p of paths) {
      let node = root;
      const parts = p.split("/");
      parts.forEach((part, i) => {
        if (i === parts.length - 1) node[part] = p;
        else node = node[part] ??= {};
      });
    }
    // only the folders on the way to the first file are open
    const html = (node, depth, dir) =>
      Object.entries(node)
        .sort(([a, x], [b, y]) => {
          const fx = typeof x === "object";
          const fy = typeof y === "object";
          return fx !== fy ? (fx ? -1 : 1) : a.localeCompare(b);
        })
        .map(([name, v]) => {
          if (typeof v === "object") {
            const path = dir + name + "/";
            return `<button type="button" class="folder" aria-expanded="${FIRST.startsWith(path)}" style="--d:${depth}"><svg aria-hidden="true"><use href="assets/icons.svg#g-folder"/></svg><span class="name">${esc(name)}</span></button><div class="kids">${html(v, depth + 1, path)}</div>`;
          }
          const ro = /protected\.yaml$|force\//.test(v) ? `<span class="ro">read-only</span>` : "";
          return `<button type="button" data-path="${esc(v)}" title="${esc(name)}" style="--d:${depth}"><svg aria-hidden="true"><use href="assets/icons.svg#${/protected\.yaml$/.test(v) ? "g-lock" : "g-file"}"/></svg><span class="name">${esc(name)}</span>${ro}</button>`;
        })
        .join("");
    tree.innerHTML = html(root, 0, "");
  };
  tree.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.classList.contains("folder")) b.setAttribute("aria-expanded", String(b.getAttribute("aria-expanded") !== "true"));
    else open(b.dataset.path);
  });
  fetch("assets/data/workspace.json")
    .then((r) => r.json())
    .then((data) => {
      files = data;
      build(Object.keys(files));
      open(FIRST);
    })
    .catch(() => (viewerNote.textContent = "Could not load the example workspace."));
}

// ------------------------------------------------------------------ playground
const play = $(".play");
if (play) {
  const presetBar = $(".presets", play);
  const src = $('[data-ed="src"] textarea', play);
  const srcHl = $('[data-ed="src"] .ed-hl', play);
  const yaml = $('[data-ed="yaml"] textarea', play);
  const yamlHl = $('[data-ed="yaml"] .ed-hl', play);
  const srcName = $('[data-ed="src"] .ed-name', play);
  const srcLang = $('[data-ed="src"] .ed-lang', play);
  const runBtn = $(".run", play);
  const changeBtn = $(".break", play);
  const out = $(".play-out .out", play);
  const raw = $(".raw", play);
  const result = $(".play-result", play);
  const verdict = $(".verdict", play);
  const timing = $(".timing", play);
  const challenge = $(".challenge", play);
  const body = $(".play-body", play);
  let preset = PRESETS[0];
  let engine = null;

  const paint = (ta, pre, mode) => {
    pre.innerHTML = ta.value.split("\n").map((l) => hlLine(l, mode)).join("\n") + "\n";
    // the overlay grows with the text so the area scrolls once, for both
    ta.style.height = "0px";
    ta.style.width = "0px";
    ta.style.height = `${Math.max(ta.parentElement.clientHeight, pre.scrollHeight)}px`;
    ta.style.width = `${Math.max(ta.parentElement.clientWidth, pre.scrollWidth)}px`;
  };
  const repaint = () => (paint(src, srcHl, "scl"), paint(yaml, yamlHl, "yaml"), placeMarks());

  // a line marked in an editor: where a step failed, or the line a change made
  const marks = [];
  const unmark = (kind) => {
    for (let i = marks.length - 1; i >= 0; i--) if (!kind || marks[i].kind === kind) (marks[i].el.remove(), marks.splice(i, 1));
  };
  const placeMarks = () => {
    for (const m of marks) {
      const pre = m.ta === src ? srcHl : yamlHl;
      const cs = getComputedStyle(pre);
      const lh = parseFloat(cs.lineHeight);
      m.el.style.top = `${parseFloat(cs.paddingTop) + (m.line - 1) * lh}px`;
      m.el.style.height = `${lh}px`;
    }
  };
  const markLine = (ta, line, kind, label) => {
    const el = document.createElement("div");
    el.className = `ed-mark ${kind}`;
    el.dataset.label = label;
    ta.parentElement.prepend(el);
    marks.push({ el, ta, line, kind });
    placeMarks();
  };
  const lineAt = (text, index) => text.slice(0, index).split("\n").length;

  const idle = (text) => {
    result.className = "play-result";
    verdict.textContent = text;
    timing.textContent = "";
  };
  const setChange = () => {
    const c = preset.change;
    changeBtn.hidden = !c;
    if (!c) return;
    const changed = !src.value.includes(c.from) && (c.to === "" || src.value.includes(c.to));
    changeBtn.textContent = changed ? c.restore : c.label;
  };
  const load = (p) => {
    preset = p;
    src.value = p.source;
    yaml.value = p.test;
    srcName.textContent = `plc/PLC_1/blocks/${p.file}`;
    srcLang.textContent = p.lang;
    challenge.innerHTML = p.challenge ?? "";
    challenge.hidden = !p.challenge;
    unmark();
    repaint();
    setChange();
    out.innerHTML = "";
    raw.hidden = true;
    idle("Run the example, then change it.");
    $$("button", presetBar).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.id === p.id)));
  };
  presetBar.innerHTML = PRESETS.map((p) => `<button type="button" role="tab" data-id="${p.id}">${esc(p.label)}<small>${esc(p.lang)}</small></button>`).join("");
  presetBar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) load(PRESETS.find((p) => p.id === b.dataset.id));
  });
  $(".reset", play).addEventListener("click", () => load(PRESETS.find((p) => p.id === preset.id) ?? preset));
  // the example's one-line change, and back
  changeBtn.addEventListener("click", () => {
    const c = preset.change;
    if (!c) return;
    unmark();
    const at = src.value.indexOf(c.from);
    if (at >= 0) {
      src.value = src.value.slice(0, at) + c.to + src.value.slice(at + c.from.length);
      markLine(src, lineAt(src.value, at), "edit", c.to ? "changed" : "line removed");
    } else {
      const back = preset.source.indexOf(c.from);
      src.value = preset.source;
      markLine(src, lineAt(src.value, back), "edit", "restored");
    }
    repaint();
    setChange();
    idle("Changed. Run the test again.");
  });
  src.addEventListener("input", () => (unmark(), repaint(), setChange()));
  yaml.addEventListener("input", () => (unmark("bad"), repaint()));
  for (const ta of [src, yaml])
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        document.execCommand("insertText", false, ta === yaml ? "  " : "    ");
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void run();
      }
    });
  $$(".play-tabs button", play).forEach((b) =>
    b.addEventListener("click", () => {
      body.dataset.show = b.dataset.show;
      $$(".play-tabs button", play).forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      repaint();
    }),
  );
  body.dataset.show = "src";

  const show = (v) => (typeof v === "string" && /^<.*>$/.test(v) ? v : JSON.stringify(v));
  const getEngine = () => (engine ??= import("./play.js"));
  async function run() {
    runBtn.disabled = true;
    idle(engine ? "Running…" : "Loading the simulator…");
    try {
      const { play: runTest } = await getEngine();
      const r = await runTest(preset.file, src.value, yaml.value);
      out.innerHTML = r.lines.map((l) => `<span class="${l.kind}">${esc(l.text)}</span>`).join("\n");
      raw.hidden = false;
      unmark("bad");
      const cases = r.result.cases;
      const total = r.result.error ? 1 : cases.length;
      const failedCase = cases.findIndex((c) => !c.passed);
      const ms = r.ms < 10 ? r.ms.toFixed(1) : Math.round(r.ms);
      timing.textContent = `${ms} ms in this browser`;
      if (r.result.error) {
        result.className = "play-result fail";
        verdict.textContent = `The test stopped: ${r.result.error}`;
      } else if (failedCase >= 0) {
        const c = cases[failedCase];
        const x = c.failures[0];
        const step = x?.step ?? c.errorStep;
        result.className = "play-result fail";
        verdict.textContent = x
          ? `Failed at step ${x.step}: ${x.name} was ${show(x.actual)}; expected ${show(x.expected)}.`
          : `Stopped at step ${c.errorStep}: ${c.error}`;
        const line = step ? r.positions[failedCase]?.steps[step - 1] : r.positions[failedCase]?.line;
        if (line) {
          markLine(yaml, line, "bad", "failed here");
          if (body.dataset.show === "src" && matchMedia("(max-width: 760px)").matches) $('.play-tabs [data-show="yaml"]', play).click();
        }
      } else {
        result.className = "play-result pass";
        verdict.textContent = `Passed · ${total}/${total} ${total === 1 ? "case" : "cases"}`;
      }
    } catch (e) {
      engine = null;
      result.className = "play-result fail";
      verdict.textContent = "Could not load the simulator. Try again.";
      out.textContent = String(e?.message ?? e);
      raw.hidden = false;
    } finally {
      runBtn.disabled = false;
    }
  }
  runBtn.addEventListener("click", () => void run());
  window.addEventListener("rung:play", (e) => {
    const { file, source, test, label } = e.detail;
    load({ id: "workspace", label, lang: "SCL", file, source, test, challenge: "Set <code>MX := 2500.0</code> in the LIMIT, then run again.", change: { label: "Lower the limit", restore: "Restore the limit", from: "MX := 3000.0", to: "MX := 2500.0" } });
    document.getElementById("play").scrollIntoView({ behavior: still ? "auto" : "smooth" });
    setTimeout(() => void run(), still ? 0 : 700);
  });
  load(preset);
  // fetch the simulator once the playground comes near
  new IntersectionObserver((entries, io) => {
    if (entries.some((e) => e.isIntersecting)) {
      void getEngine().catch(() => (engine = null));
      io.disconnect();
    }
  }, { rootMargin: "600px 0px" }).observe(play);
  addEventListener("resize", repaint);
}

// ------------------------------------------------------------------ the recorded soak runs
const chart = $(".soak-chart");
if (chart) {
  const LANES = [
    ["create", "Create"],
    ["file", "File edit"],
    ["tia", "TIA edit"],
    ["both", "Both edited"],
    ["concurrent", "Concurrent"],
    ["kill", "Kill"],
    ["delete", "Delete"],
  ];
  const inspector = $(".inspector");
  const totals = Object.fromEntries($$("[data-t]").map((el) => [el.dataset.t, el]));
  const stepsNote = $(".steps-note");
  const stepLink = $(".step-link");
  let data = null;
  let run = null;
  let selected = -1;
  let playing = 0;
  let head = -1;

  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  // the whole recording's totals: they never move while the cursor does
  const setTotals = () => {
    totals.actions.textContent = run.log.length;
    totals.killed.textContent = run.log.filter((r) => r[2] > 0).length;
    totals.merged.textContent = run.log.reduce((n, r) => n + r[6], 0);
    totals.conflicts.textContent = run.log.reduce((n, r) => n + r[7], 0);
    totals.problems.textContent = run.problems;
    const noops = run.steps - run.log.length;
    stepsNote.textContent = `${run.steps} steps${noops ? `: ${run.log.length} actions and ${noops} no-op steps (a create of a block that exists)` : ", every one an action"} · ${run.tia} · commit ${run.commit}`;
  };

  function draw() {
    const W = Math.max(320, chart.clientWidth - 8);
    const narrow = W < 560;
    const L = narrow ? 88 : 118;
    const laneH = narrow ? 15 : 19;
    const top = 6;
    const cutY = top + LANES.length * laneH + 12;
    const barsY = cutY + 34;
    const barsH = narrow ? 34 : 46;
    const axisY = barsY + barsH + 18;
    const H = axisY + 8;
    const span = run.minutes * 60;
    const x = (t) => L + (t / span) * (W - L - 6);
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
    for (let m = 0; m <= run.minutes; m += 5) s += `<line class="grid" x1="${x(m * 60)}" x2="${x(m * 60)}" y1="${top - 4}" y2="${axisY - 12}"/><text class="axis" x="${x(m * 60)}" y="${axisY}" text-anchor="${m === 0 ? "start" : m === run.minutes ? "end" : "middle"}">${m} min</text>`;
    LANES.forEach(([, label], i) => (s += `<text class="lane-label" x="0" y="${top + i * laneH + laneH * 0.68}">${label}</text>`));
    s += `<text class="lane-label" x="0" y="${cutY + 11}" style="fill:var(--warm)">${narrow ? "Interrupted" : "Sync interrupted"}</text><text class="lane-label" x="0" y="${barsY + barsH - 4}">Synced</text>`;
    const mh = laneH - 7;
    for (const r of run.log) {
      const lane = r[1];
      const cx = x(r[0]);
      s += `<rect class="mk${data.actions[lane] === "kill" ? " kill-lane" : ""}" x="${cx - 1}" y="${top + lane * laneH + 3.5}" width="2.2" height="${mh}" rx="1"/>`;
      if (r[2] > 0) s += `<path class="cut" d="M${cx - 3.5} ${cutY + 2}h7l-3.5 12z"/>`;
      // what the sync of this step carried: exports, imports and creates, merges on top
      const did = r[3] + r[4] + r[5];
      const merged = r[6];
      const unit = barsH / 4;
      if (did) s += `<rect class="bar-i" x="${cx - 1.2}" y="${barsY + barsH - Math.min(4, did) * unit}" width="2.4" height="${Math.min(4, did) * unit}"/>`;
      if (merged) s += `<rect class="bar-m" x="${cx - 1.2}" y="${barsY + barsH - Math.min(4, did + merged) * unit}" width="2.4" height="${merged * unit}"/>`;
    }
    const at = playing ? head : selected;
    if (at >= 0) s += `<line class="${playing ? "head" : "sel"}" x1="${x(run.log[at][0])}" x2="${x(run.log[at][0])}" y1="${top - 4}" y2="${axisY - 12}"/>`;
    s += `<line class="cursor" x1="-10" x2="-10" y1="${top - 4}" y2="${axisY - 12}"/></svg>`;
    chart.innerHTML = s;
    chart._x = x;
    chart._geom = { L, W, span };
  }

  const describe = (i) => {
    const r = run.log[i];
    inspector.innerHTML = `<h4>Step ${r[8]}: ${esc(LANES[r[1]][1])}</h4><p class="when">${mmss(r[0])} into the run</p>
      <dl><dt>Exported</dt><dd>${r[3]}</dd><dt>Imported</dt><dd>${r[4]}</dd><dt>Created</dt><dd>${r[5]}</dd><dt>Merged</dt><dd>${r[6]}</dd><dt>Conflicts</dt><dd>${r[7]}</dd></dl>
      ${r[2] > 0 ? `<p class="cutnote">rung sync was killed ${r[2]} ms in, on purpose. The next sync finished what it had started.</p>` : ""}`;
  };
  const show = (i) => {
    selected = i;
    describe(i);
    stepLink.href = `#evidence-s${run.seed}-${run.log[i][8]}`;
    draw();
  };
  const empty = () => {
    inspector.innerHTML = `<p class="insp-empty">Select a step to inspect it.</p><p class="insp-empty">Seed ${run.seed} ran on commit <a href="https://github.com/sa1ntsinner/rung/commit/${run.commit}">${run.commit}</a>.</p>`;
  };
  const nearest = (clientX) => {
    const rect = chart.getBoundingClientRect();
    const { L, W, span } = chart._geom;
    const t = ((clientX - rect.left - L) / (W - L - 6)) * span;
    let best = 0;
    run.log.forEach((r, i) => Math.abs(r[0] - t) < Math.abs(run.log[best][0] - t) && (best = i));
    return best;
  };
  chart.addEventListener("pointermove", (e) => {
    if (!run || playing) return;
    const i = nearest(e.clientX);
    const cur = $(".cursor", chart);
    if (cur) cur.setAttribute("x1", chart._x(run.log[i][0])), cur.setAttribute("x2", chart._x(run.log[i][0]));
    if (e.pointerType === "mouse") show(i);
  });
  chart.addEventListener("click", (e) => run && ((playing = 0), show(nearest(e.clientX))));

  const pick = (seed, step) => {
    run = data.runs.find((r) => String(r.seed) === String(seed)) ?? data.runs[0];
    selected = -1;
    playing = 0;
    $$(".seeds button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.seed === String(run.seed))));
    setTotals();
    stepLink.href = `#evidence-s${run.seed}`;
    const i = step === undefined ? -1 : run.log.findIndex((r) => r[8] === step);
    if (i >= 0) show(i);
    else (empty(), draw());
  };
  $$(".seeds button").forEach((b) => b.addEventListener("click", () => data && pick(b.dataset.seed)));
  $(".next-kill").addEventListener("click", () => {
    if (!run) return;
    playing = 0;
    const from = selected + 1;
    const i = run.log.findIndex((r, k) => k >= from && r[2] > 0);
    show(i >= 0 ? i : run.log.findIndex((r) => r[2] > 0));
  });
  // playing moves a cursor through the recording and shows each step it passes
  $(".replay").addEventListener("click", () => {
    if (!run) return;
    const id = ++playing;
    const span = run.minutes * 60;
    const t0 = performance.now();
    const dur = still ? 0 : 12000;
    const frame = () => {
      if (id !== playing) return;
      const k = dur ? Math.min(1, (performance.now() - t0) / dur) : 1;
      const t = k * span;
      let i = head;
      while (i + 1 < run.log.length && run.log[i + 1][0] <= t) i++;
      if (i !== head || k === 1) {
        head = i;
        if (i >= 0) describe(i);
        draw();
      }
      if (k < 1) requestAnimationFrame(frame);
      else {
        playing = 0;
        head = -1;
        show(run.log.length - 1);
      }
    };
    head = -1;
    requestAnimationFrame(frame);
  });
  stepLink.addEventListener("click", (e) => {
    e.preventDefault();
    const url = new URL(stepLink.href, location.href).href;
    history.replaceState(null, "", url);
    copyText(stepLink, url);
  });
  let resizeT;
  addEventListener("resize", () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => run && draw(), 150);
  });
  fetch("assets/data/soak.json")
    .then((r) => r.json())
    .then((d) => {
      data = d;
      // #evidence-s11-103: that recording at that step
      const m = /^#evidence-s(\d+)(?:-(\d+))?$/.exec(location.hash);
      pick(m ? m[1] : 11, m?.[2] ? Number(m[2]) : undefined);
      if (m) chart.scrollIntoView({ block: "center" });
    })
    .catch(() => (inspector.textContent = "Could not load the recorded runs."));
}

// ------------------------------------------------------------------ 43 blocks of one production program
const squares = $(".squares");
if (squares) {
  squares.innerHTML = Array.from({ length: 43 }, (_, i) => `<i class="${i < 34 ? "" : i < 42 ? "stub" : "no"}" style="--s:${still ? 1 : 0};transition-delay:${i * 18}ms"></i>`).join("");
  const light = () => $$("i", squares).forEach((i) => i.style.setProperty("--s", "1"));
  if (!still)
    new IntersectionObserver((entries, io) => {
      if (entries.some((e) => e.isIntersecting)) (io.disconnect(), light());
    }, { threshold: 0.5 }).observe(squares);
}

// ------------------------------------------------------------------ the Pro review's tabs
$$(".review-tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    $$(".review-tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $$("[data-rp]").forEach((p) => (p.hidden = p.dataset.rp !== b.dataset.rt));
  }),
);

// ------------------------------------------------------------------ theme: the system's, or the one the reader picked
const themeSelect = $(".theme select");
if (themeSelect) {
  themeSelect.value = document.documentElement.dataset.theme ?? "system";
  themeSelect.addEventListener("change", () => {
    const t = themeSelect.value;
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try {
      if (t === "system") localStorage.removeItem("rung-theme");
      else localStorage.setItem("rung-theme", t);
    } catch {}
  });
}

// ------------------------------------------------------------------ sections rise as they come in
const reveals = $$(".reveal");
if (still || !("IntersectionObserver" in window)) reveals.forEach((r) => r.classList.add("shown"));
else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("shown");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -6% 0px" },
  );
  reveals.forEach((r) => io.observe(r));
}
