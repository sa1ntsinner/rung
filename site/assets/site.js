// SPDX-License-Identifier: MIT
// The site's motion: the live demo in the hero, power on the left rail as the page scrolls, contacts that close
// as their section comes in, and the numbers. With prefers-reduced-motion everything is shown at rest.
(() => {
  document.documentElement.classList.add("js");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------ SCL, lightly highlighted
  const KEYWORDS = /\b(FUNCTION_BLOCK|END_FUNCTION_BLOCK|VAR_INPUT|VAR_OUTPUT|END_VAR|BEGIN|IF|THEN|ELSE|END_IF|AND|OR|NOT)\b/g;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function scl(src) {
    let out = "";
    let rest = src;
    const comment = rest.indexOf("//");
    let tail = "";
    if (comment >= 0) {
      tail = `<span class="c">${esc(rest.slice(comment))}</span>`;
      rest = rest.slice(0, comment);
    }
    out = esc(rest)
      .replace(/("[^"]*")/g, '<span class="s">$1</span>')
      .replace(KEYWORDS, '<span class="k">$1</span>')
      .replace(/\b(Bool|Real|Int)\b/g, '<span class="t">$1</span>')
      .replace(/\b(LIMIT)\b/g, '<span class="f">$1</span>')
      .replace(/\b(\d+\.\d+)\b/g, '<span class="n">$1</span>');
    return out + tail;
  }

  const BLOCK = [
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
  // what rung watch prints for each pass (twoway.ts), as it prints it
  const LOG = {
    imported: "exported 0  imported <b>1</b>  created 0  merged 0  conflicts 0  pending-deletes 0  removed 0  unchanged 41",
    compiled: "  info     COMPILE            plc/PLC_1/blocks/10_Drives/Fx_Motor.scl — <span class=\"ok\">Compiling finished (errors: 0; warnings: 0)</span>",
    exported: "exported <b>1</b>  imported 0  created 0  merged 0  conflicts 0  pending-deletes 0  removed 0  unchanged 41",
  };
  const TIA_LINE = "\t#Ready := #Running AND NOT #Overspeed;";

  function render(pre, lines) {
    pre.innerHTML = lines.map((l, i) => `<span class="ln" data-n="${i + 1}">${scl(l)}</span>`).join("");
  }
  const lineOf = (pre, n) => pre.querySelectorAll(".ln")[n - 1];
  function setLine(pre, n, text, caretAt, warm) {
    const ln = lineOf(pre, n);
    if (!ln) return;
    if (caretAt === undefined) ln.innerHTML = scl(text);
    else ln.innerHTML = `${scl(text.slice(0, caretAt))}<span class="caret${warm ? " warm" : ""}"></span>${scl(text.slice(caretAt))}`;
  }
  function insertLine(pre, after, text) {
    const at = lineOf(pre, after);
    const ln = document.createElement("span");
    ln.className = "ln";
    ln.innerHTML = scl(text);
    at.after(ln);
    pre.querySelectorAll(".ln").forEach((l, i) => (l.dataset.n = String(i + 1)));
    return ln;
  }

  // ------------------------------------------------------------------ the demo
  const demo = document.querySelector(".demo");
  if (demo) {
    const file = demo.querySelector('[data-pane="file"]');
    const tia = demo.querySelector('[data-pane="tia"]');
    const editor = demo.querySelector(".editor");
    const status = demo.querySelector(".status");
    const statusText = status.querySelector(".text");
    const log = demo.querySelector(".log");
    const sparkTia = demo.querySelector(".spark.to-tia");
    const sparkFile = demo.querySelector(".spark.to-file");
    const say = (html) => {
      const row = document.createElement("span");
      row.className = "row";
      row.innerHTML = html;
      log.append(row);
      while (log.children.length > 3) log.firstElementChild.remove();
    };
    const fire = async (spark) => {
      spark.classList.remove("go");
      void spark.offsetWidth;
      spark.classList.add("go");
      await wait(700);
    };
    const setStatus = (kind, text) => {
      status.className = `status ${kind}`;
      statusText.textContent = text;
    };
    const EDIT_LINE = BLOCK[9];
    const at = EDIT_LINE.indexOf("3000.0");

    const reset = () => {
      render(file, BLOCK);
      render(tia, BLOCK);
      log.innerHTML = "";
      editor.classList.remove("is-dirty");
      setStatus("", "Ready");
    };

    const finalState = () => {
      const edited = BLOCK.slice();
      edited[9] = EDIT_LINE.replace("3000.0", "2500.0");
      const merged = edited.slice(0, 10).concat([TIA_LINE], edited.slice(10));
      render(file, merged);
      render(tia, merged);
      lineOf(file, 11).classList.add("hl-warm");
      setStatus("ok", "Fx_Motor compiled · 0 errors, 0 warnings");
      log.innerHTML = "";
      say(LOG.imported);
      say(LOG.compiled);
      say(LOG.exported);
    };

    async function play() {
      for (;;) {
        reset();
        await wait(1400);
        // the person edits the file: 3000.0 becomes 2500.0
        editor.classList.add("is-dirty");
        const before = EDIT_LINE.slice(0, at);
        const after = EDIT_LINE.slice(at + 6);
        let text = EDIT_LINE;
        setLine(file, 10, text, at + 6);
        await wait(450);
        for (let i = 5; i >= 0; i--) {
          text = before + "3000.0".slice(0, i) + after;
          setLine(file, 10, text, at + i);
          await wait(55);
        }
        for (let j = 1; j <= 6; j++) {
          text = before + "2500.0".slice(0, j) + after;
          setLine(file, 10, text, at + j);
          await wait(95);
        }
        await wait(500);
        // saved: rung imports it and TIA Portal compiles
        editor.classList.remove("is-dirty");
        setLine(file, 10, text);
        lineOf(file, 10).classList.add("hl-power");
        await fire(sparkTia);
        setStatus("busy", "Importing Fx_Motor…");
        setLine(tia, 10, text);
        lineOf(tia, 10).classList.add("hl-power");
        say(LOG.imported);
        await wait(900);
        setStatus("busy", "Compiling…");
        await wait(900);
        setStatus("ok", "Fx_Motor compiled · 0 errors, 0 warnings");
        say(LOG.compiled);
        await wait(1200);
        lineOf(file, 10).classList.remove("hl-power");
        lineOf(tia, 10).classList.remove("hl-power");
        // someone in TIA Portal adds a line
        await wait(700);
        const added = insertLine(tia, 10, "");
        added.classList.add("hl-edit");
        for (let i = 1; i <= TIA_LINE.length; i++) {
          added.innerHTML = `${scl(TIA_LINE.slice(0, i))}<span class="caret warm"></span>`;
          await wait(i === 1 ? 120 : 38);
        }
        added.innerHTML = scl(TIA_LINE);
        await wait(700);
        // rung brings it to the file
        await fire(sparkFile);
        added.classList.remove("hl-edit");
        const came = insertLine(file, 10, TIA_LINE);
        came.classList.add("hl-warm");
        say(LOG.exported);
        await wait(4200);
      }
    }

    if (still) finalState();
    else {
      // play only while the demo is on screen
      reset();
      let started = false;
      new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting) && !started) {
          started = true;
          void play();
        }
      }).observe(demo);
    }
  }

  // ------------------------------------------------------------------ the ladder figure lights up in view
  const ladder = document.querySelector(".ladder");
  const sections = [...document.querySelectorAll(".rung-section")];
  const reveals = [...document.querySelectorAll(".reveal")];
  const counters = [...document.querySelectorAll("[data-count]")];
  if (still || !("IntersectionObserver" in window)) {
    ladder?.classList.add("lit");
    sections.forEach((s) => s.classList.add("on"));
    reveals.forEach((r) => r.classList.add("shown"));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("shown");
          if (e.target.classList.contains("rung-section")) setTimeout(() => e.target.classList.add("on"), 250);
          if (e.target.contains(ladder)) setTimeout(() => ladder.classList.add("lit"), 900);
          for (const c of e.target.querySelectorAll("[data-count]")) count(c);
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    reveals.forEach((r) => io.observe(r));
  }

  // the numbers count up once
  function count(el) {
    if (el.dataset.done) return;
    el.dataset.done = "1";
    const to = Number(el.dataset.count);
    const suffix = el.dataset.suffix ?? "";
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 1300);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = `${Math.round(to * eased)}${suffix}`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  if (still) counters.forEach((c) => (c.dataset.done = "1"));

  // ------------------------------------------------------------------ power on the left rail, as far as the page is read
  const rails = document.querySelector(".rails");
  if (rails && !still) {
    let queued = false;
    const update = () => {
      queued = false;
      const max = document.documentElement.scrollHeight - innerHeight;
      rails.style.setProperty("--progress", String(max > 0 ? Math.min(1, (scrollY + innerHeight * 0.35) / (max + innerHeight * 0.35)) : 1));
    };
    addEventListener("scroll", () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(update);
      }
    }, { passive: true });
    update();
  }

  // ------------------------------------------------------------------ copy the three commands
  for (const b of document.querySelectorAll(".copy")) {
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy.replace(/&#10;/g, "\n"));
        b.textContent = "Copied";
        b.classList.add("done");
        setTimeout(() => {
          b.textContent = "Copy";
          b.classList.remove("done");
        }, 1600);
      } catch {}
    });
  }
})();
