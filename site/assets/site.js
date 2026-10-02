// SPDX-License-Identifier: MIT
// The site's three behaviours: the theme picker, the sync illustration's loop and the break/fix test, which runs
// rung's own simulator in a worker (assets/play-worker.js, built by tools/site/build.mjs).
const $ = (sel, root = document) => root.querySelector(sel);
const motion = matchMedia("(prefers-reduced-motion: reduce)");

// ------------------------------------------------------------------ theme: the system's, or the one picked
const themeSelect = $(".theme select");
if (themeSelect) {
  // the head script already applied ?theme= or the saved choice: show what is in effect
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

// ------------------------------------------------------------------ sync: a file edit goes to TIA Portal, a TIA edit comes back
const sync = $(".sync");
if (sync) {
  const [fileNum, tiaNum] = [$('[data-side="file"] [data-num]', sync), $('[data-side="tia"] [data-num]', sync)];
  const state = $(".state", sync);
  const pauseBtn = $(".pause", sync);
  // each step is the whole picture at that moment, so the loop can resume from any point
  const STEPS = [
    [0, "3000.0", "3000.0", "", "In sync"],
    [1000, "2500.0", "3000.0", "file", "Saved"],
    [2000, "2500.0", "3000.0", "file", "Compiling…"],
    [3000, "2500.0", "2500.0", "tia", "In sync"],
    [3700, "2500.0", "2500.0", "", "In sync"],
    [4200, "2500.0", "3000.0", "tia", "Edited in TIA Portal"],
    [5500, "3000.0", "3000.0", "file", "File updated"],
    [6500, "3000.0", "3000.0", "", "In sync"],
  ];
  const CYCLE = 8000;
  const show = ([, file, tia, lit, text]) => {
    fileNum.textContent = file;
    tiaNum.textContent = tia;
    fileNum.classList.toggle("lit", lit === "file");
    tiaNum.classList.toggle("lit", lit === "tia");
    state.textContent = text;
    sync.toggleAttribute("data-busy", text !== "In sync");
  };
  let timers = [];
  let started = 0; // when the current cycle began (performance.now), shifted on resume
  let at = 0; // where in the cycle a stopped loop stands
  let wanted = true; // the reader did not pause it
  let seen = false;
  const halt = () => {
    if (timers.length) at = (performance.now() - started) % CYCLE;
    timers.forEach(clearTimeout);
    timers = [];
  };
  const run = (from) => {
    started = performance.now() - from;
    show(STEPS.findLast(([t]) => t <= from));
    for (const step of STEPS) if (step[0] > from) timers.push(setTimeout(() => show(step), step[0] - from));
    timers.push(setTimeout(() => (timers = [], run(0)), CYCLE - from));
  };
  const update = () => {
    if (motion.matches) {
      halt();
      at = 0;
      show(STEPS[0]);
      pauseBtn.hidden = true;
      return;
    }
    pauseBtn.hidden = false;
    if (wanted && seen && !document.hidden) timers.length || run(at);
    else halt();
  };
  new IntersectionObserver(([e]) => ((seen = e.isIntersecting), update())).observe(sync);
  document.addEventListener("visibilitychange", update);
  motion.addEventListener("change", update);
  pauseBtn.addEventListener("click", () => {
    wanted = !wanted;
    pauseBtn.textContent = wanted ? "Pause" : "Play";
    update();
  });
  update();
}

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
        if (c.passed) say("PASS · Motor stays running.", "pass");
        else say(`FAIL · Expected ${f ? JSON.stringify(f.expected) : "?"}; got ${f ? JSON.stringify(f.actual) : "?"}.`, "fail");
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
