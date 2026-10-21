// SPDX-License-Identifier: MIT
// The site's behaviours: entrances, the copy button, the panel row, the pinned editor, the sidebar notes, the clip,
// the tabs, and the break/fix test, which runs rung's own simulator in a worker (assets/play-worker.js, built by
// tools/site/build.mjs). Without script every part is visible and still.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const motion = matchMedia("(prefers-reduced-motion: reduce)");

// ------------------------------------------------------------------ entrances: each section's parts (the headline is CSS)
const RISE = "main > section:not(.hero) :is(h2, .two, .say, p, figure, .test, .stage, .side, .notes li, .tabs-box, .tile, .price, .caption)";
// a part rises once: nothing inside a fragment, a tile, a tab panel or the caption rises on its own
// on a phone the parts are simply there: a long column of rises reads as lag
const risers = matchMedia("(max-width: 720px)").matches ? [] : $$(RISE).filter((el) => !el.parentElement?.closest("[data-ui], .tile, .tabpanel, .caption, .step, .price") || el.matches(".say"));
for (const el of risers) {
  const sib = el.parentElement ? [...el.parentElement.children].indexOf(el) : 0;
  el.dataset.rise = "";
  el.style.setProperty("--i", String(Math.min(sib, 6)));
}
const riseIo = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) (e.target.classList.add("in"), riseIo.unobserve(e.target));
}, { rootMargin: "0px 0px -8% 0px" });
risers.forEach((el) => riseIo.observe(el));
const bars = $(".bars");
if (bars) {
  $$("li", bars).forEach((li, i) => li.style.setProperty("--i", String(i)));
  const io = new IntersectionObserver(([e]) => e.isIntersecting && (bars.classList.add("in"), io.disconnect()), { threshold: 0.25 });
  io.observe(bars);
}

// ------------------------------------------------------------------ copy the install command
for (const btn of $$("[data-copy]")) {
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Select and copy";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1800);
  });
}

// ------------------------------------------------------------------ panel row: the centred panel is lit and named
const row = $(".row");
if (row) {
  const panels = $$(".panel", row);
  const name = $(".caption .name");
  const text = $(".caption .text");
  let lit;
  const light = () => {
    const mid = row.getBoundingClientRect().left + row.clientWidth / 2;
    const best = panels.reduce((a, p) => {
      const r = p.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - mid);
      return d < a.d ? { p, d } : a;
    }, { p: panels[0], d: Infinity }).p;
    if (best === lit) return;
    lit?.classList.remove("lit");
    best.classList.add("lit");
    lit = best;
    name.textContent = best.dataset.name;
    text.textContent = best.dataset.text;
  };
  let raf = 0;
  row.addEventListener("scroll", () => (cancelAnimationFrame(raf), (raf = requestAnimationFrame(light))), { passive: true });
  addEventListener("resize", light);
  panels.forEach((p) => p.addEventListener("click", () => p.scrollIntoView({ behavior: motion.matches ? "auto" : "smooth", inline: "center", block: "nearest" })));
  // drag with a mouse; touch and trackpads scroll natively
  let down = null;
  row.addEventListener("pointerdown", (e) => e.pointerType === "mouse" && (down = { x: e.clientX, left: row.scrollLeft, moved: false }));
  addEventListener("pointermove", (e) => {
    if (!down) return;
    if (Math.abs(e.clientX - down.x) > 4) (down.moved = true), (row.style.scrollSnapType = "none");
    row.scrollLeft = down.left - (e.clientX - down.x);
  });
  addEventListener("pointerup", () => {
    if (!down) return;
    row.style.scrollSnapType = "";
    down = null;
  });
  const go = (d) => {
    const to = panels[panels.indexOf(lit) + d];
    to?.scrollIntoView({ behavior: motion.matches ? "auto" : "smooth", inline: "center", block: "nearest" });
    return !!to;
  };
  row.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (d && go(d)) e.preventDefault();
  });
  $(".caption .prev")?.addEventListener("click", () => go(-1));
  $(".caption .next")?.addEventListener("click", () => go(1));
  // start on the first panel, centred
  requestAnimationFrame(() => {
    row.scrollLeft = panels[0].offsetLeft + panels[0].offsetWidth / 2 - row.clientWidth / 2;
    light();
  });
}

// ------------------------------------------------------------------ pinned editor: the statement in view sets its state
const editor = $(".editor");
const steps = $$(".step");
if (editor && steps.length) {
  const swap = $(".swap", editor);
  const status = $(".s-state", editor);
  const STATUS = ["rung: watching", "FB_Batch → TIA · compiled", "rung: watching"];
  const set = (i) => {
    editor.dataset.state = String(i);
    steps.forEach((s, j) => s.classList.toggle("on", j === i));
    swap.textContent = i === 2 ? swap.dataset.b : swap.dataset.a;
    status.textContent = STATUS[i];
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) set(Number(e.target.dataset.step));
  }, { rootMargin: "-45% 0px -45% 0px" });
  steps.forEach((s) => io.observe(s));
  set(0);
}

// ------------------------------------------------------------------ sidebar notes: a note lights its part of the panel
const side = $(".side");
if (side) {
  const on = (key) => {
    side.classList.toggle("focus", !!key);
    $$("[data-part]", side).forEach((p) => p.classList.toggle("lit", p.dataset.part === key));
  };
  // on a wide screen each note stands level with the part it explains
  const wide = matchMedia("(min-width: 1081px)");
  const place = () => {
    for (const ul of $$(".notes")) {
      ul.classList.toggle("placed", wide.matches);
      ul.style.height = wide.matches ? `${side.offsetHeight}px` : "";
      // level with its part, or just under the note before it when the parts sit close together
      let floor = 0;
      for (const li of $$("li", ul)) {
        const part = $(`[data-part="${li.dataset.for}"]`, side);
        const top = Math.max(part.getBoundingClientRect().top - side.getBoundingClientRect().top - 4, floor);
        li.style.setProperty("--top", `${top}px`);
        floor = top + li.offsetHeight + 24;
      }
      if (wide.matches) ul.style.height = `${Math.max(side.offsetHeight, floor)}px`;
    }
  };
  place();
  addEventListener("resize", place);
  wide.addEventListener("change", place);
  for (const li of $$(".notes li")) {
    li.tabIndex = 0;
    li.addEventListener("pointerenter", () => on(li.dataset.for));
    li.addEventListener("pointerleave", () => on(null));
    li.addEventListener("focus", () => on(li.dataset.for));
    li.addEventListener("blur", () => on(null));
  }
}

// ------------------------------------------------------------------ the clip plays while it is on screen
const video = $(".clip video");
if (video) {
  const io = new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !motion.matches) video.play().catch(() => {});
    else video.pause();
  }, { threshold: 0.3 });
  io.observe(video);
}

// ------------------------------------------------------------------ tabs
const tabs = $$('[role="tab"]');
const pick = (tab, focus = false) => {
  for (const t of tabs) {
    const sel = t === tab;
    t.setAttribute("aria-selected", String(sel));
    t.tabIndex = sel ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !sel;
  }
  if (focus) tab.focus();
};
tabs.forEach((t, i) => {
  t.addEventListener("click", () => pick(t));
  t.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (d) (e.preventDefault(), pick(tabs[(i + d + tabs.length) % tabs.length], true));
  });
});

// ------------------------------------------------------------------ test: break the latch, see the real result
const test = $(".test");
if (test) {
  const source = (broken) => `FUNCTION_BLOCK "Fx_Motor"
VAR_INPUT
    Start : Bool;
    Stop : Bool;
END_VAR
VAR_OUTPUT
    Running : Bool;
END_VAR
BEGIN
    #Running := ${broken ? "#Start" : "(#Start OR #Running)"} AND NOT #Stop;
END_FUNCTION_BLOCK
`;
  // the same text the page shows next to the block
  const TEST = `block: Fx_Motor
cases:
  - name: stays latched
    steps:
      - set: { Start: true }
        cycle: 1
      - set: { Start: false }
        cycle: 1
        expect: { Running: true }
`;
  const EXPR = {
    false: '(<span class="v">#Start</span> <span class="k">OR</span> <span class="v">#Running</span>)',
    true: '<span class="v">#Start</span>',
  };
  const btn = $(".toggle", test);
  const result = $(".result", test);
  const expr = $(".expr", test);
  let worker;
  let broken = false;
  let busy = false;
  let failed = false; // the simulator could not load or answer: the button retries
  let limit;

  const say = (text, kind = "") => {
    result.textContent = text;
    result.dataset.kind = kind;
  };
  const label = () => (btn.textContent = failed ? "Retry" : broken ? "Fix it" : "Break it");
  const ready = () => {
    busy = false;
    btn.hidden = false;
    btn.disabled = false;
    label();
  };
  const unavailable = () => {
    clearTimeout(limit);
    worker?.terminate();
    worker = undefined;
    failed = true;
    say("Simulator unavailable.", "fail");
    ready();
  };
  const run = () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    // the old verdict never stands next to changed code
    say(worker ? "Running…" : "Loading simulator…");
    limit = setTimeout(unavailable, 10_000);
    try {
      worker ??= new Worker("assets/play-worker.js");
      worker.onerror = unavailable;
      worker.onmessage = ({ data }) => {
        clearTimeout(limit);
        const r = data.ok?.result;
        const c = r?.cases?.[0];
        if (!c || r.error || c.error) return unavailable();
        failed = false;
        const f = c.failures[0];
        if (c.passed) say("Pass. The motor stays running.", "pass");
        else say(`Fail. Expected ${f ? JSON.stringify(f.expected) : "?"}, got ${f ? JSON.stringify(f.actual) : "?"}.`, "fail");
        ready();
      };
      worker.postMessage({ file: "Fx_Motor.scl", source: source(broken), test: TEST });
    } catch {
      unavailable();
    }
  };
  btn.addEventListener("click", () => {
    if (!failed) {
      broken = !broken;
      expr.innerHTML = EXPR[broken];
      test.dataset.broken = String(broken);
    }
    label();
    run();
  });
  say("Loading simulator…");
  // the simulator loads shortly before the test comes into view, and runs the passing test once
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    io.disconnect();
    run();
  }, { rootMargin: "300px" });
  io.observe(test);
}
