// SPDX-License-Identifier: MIT
// A LAD/FBD block read-only, network by network: ladders drawn as TIA Portal draws them, other networks as text.
// Monitor reads the operands from the PLC and shows where power flows, as TIA Portal's monitoring does.
import { LitElement, html, svg, nothing } from "lit";
import { layoutRung, operandsOf, type LadderBlock, type LadderNetwork, type Shape } from "../../core/ladderLayout";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

export class RgLadder extends LitElement {
  static properties = { block: { state: true }, error: { state: true }, filter: { state: true }, room: { state: true }, monitoring: { state: true }, values: { state: true }, live: { state: true } };
  declare block: LadderBlock | undefined;
  declare error: string | undefined;
  declare filter: string;
  /** The width a network can use: coils go to its right edge, as in TIA Portal. */
  declare room: number;
  declare monitoring: boolean;
  declare values: Record<string, unknown>;
  declare live: { state: "live" | "off" | "error"; message: string } | undefined;
  private readonly resize = new ResizeObserver((e) => (this.room = Math.floor(e[0]!.contentRect.width)));

  constructor() {
    super();
    this.block = undefined;
    this.error = undefined;
    this.filter = "";
    this.room = 0;
    this.monitoring = false;
    this.values = {};
    this.live = undefined;
  }

  private readonly message = (event: MessageEvent) => {
    const m = event.data;
    if (m?.kind === "ladder") {
      this.block = m.block;
      this.error = m.error;
      // a changed block names other operands: read those
      if (this.monitoring) this.requestValues();
    } else if (m?.kind === "values") this.values = { ...this.values, ...m.values };
    else if (m?.kind === "monitorState") this.live = { state: m.state, message: m.message };
  };

  /** Back in view: monitoring that was paused while hidden goes on. */
  private readonly visibility = () => {
    if (document.visibilityState === "visible" && this.monitoring) this.requestValues();
  };

  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("message", this.message);
    document.addEventListener("visibilitychange", this.visibility);
    this.resize.observe(this);
    vscode.postMessage({ kind: "ready" });
  }
  disconnectedCallback() {
    window.removeEventListener("message", this.message);
    document.removeEventListener("visibilitychange", this.visibility);
    this.resize.disconnect();
    super.disconnectedCallback();
  }

  /** Every operand of the drawn networks (the ones the filter shows). */
  private requestValues() {
    const names = new Set<string>();
    for (const n of this.block?.networks ?? []) if (n.rung && this.shows(n)) for (const name of operandsOf(n.rung)) names.add(name);
    vscode.postMessage({ kind: "monitor", names: [...names] });
  }

  private toggleMonitor() {
    this.monitoring = !this.monitoring;
    if (this.monitoring) this.requestValues();
    else {
      vscode.postMessage({ kind: "monitor" });
      this.values = {};
      this.live = undefined;
    }
  }

  private shape(s: Shape) {
    if (s.t === "line") return svg`<line class=${s.cls ?? "lad-wire"} x1=${s.x1} y1=${s.y1} x2=${s.x2} y2=${s.y2} />`;
    if (s.t === "rect") return svg`<rect class=${s.cls} x=${s.x} y=${s.y} width=${s.w} height=${s.h} rx="2" />`;
    if (s.t === "path") return svg`<path class=${s.cls} d=${s.d} />`;
    // operands are links: a click finds the tag, DB or instance (Go to Symbol)
    const operand = /lad-operand/.test(s.cls);
    return svg`<text class=${s.cls} x=${s.x} y=${s.y} text-anchor=${s.anchor ?? "middle"} @click=${operand ? () => vscode.postMessage({ kind: "operand", name: s.full ?? s.s }) : nothing}>${s.full ? svg`<title>${s.full}</title>` : nothing}${s.s}</text>`;
  }

  private network(n: LadderNetwork, width: number) {
    const head = html`<header class="lad-head"><span class="lad-num">Network ${n.index}</span>${n.title ? html`<span class="lad-title">${n.title}</span>` : nothing}${n.language !== "LAD" && n.language ? html`<span class="lad-badge">${n.language}</span>` : nothing}</header>`;
    const comment = n.comment ? html`<p class="lad-comment">${n.comment}</p>` : nothing;
    if (n.rung) {
      const values = this.monitoring && this.live?.state === "live" ? (name: string) => this.values[name] : undefined;
      const l = layoutRung(n.rung, width, values);
      return html`<section class="lad-net">${head}${comment}<div class="lad-scroll"><svg class="lad-svg" width=${l.width} height=${l.height} viewBox="0 0 ${l.width} ${l.height}" role="img" aria-label=${`Network ${n.index}`}>${l.shapes.map((s) => this.shape(s))}</svg></div></section>`;
    }
    const why = n.note === "empty network" ? html`<p class="lad-note">Empty network</p>` : n.note ? html`<p class="lad-note">${n.note}${n.text ? ": shown as the SCL rung runs for it" : ""}</p>` : nothing;
    return html`<section class="lad-net">${head}${comment}${why}${n.text ? html`<pre class="lad-text">${n.text}</pre>` : nothing}</section>`;
  }

  private shows(n: LadderNetwork): boolean {
    const f = this.filter.trim().toLowerCase();
    if (!f) return true;
    return `${n.index} ${n.title} ${n.comment} ${n.text ?? ""} ${JSON.stringify(n.rung ?? [])}`.toLowerCase().includes(f);
  }

  render() {
    if (this.error) return html`<main class="lad"><p class="lad-note">${this.error}</p></main>`;
    const b = this.block;
    if (!b) return html`<main class="lad"><p class="lad-note">Reading the block…</p></main>`;
    // the view's width less its padding: a network that fits ends at the right edge, a wider one scrolls
    const width = Math.max(0, this.room - 48);
    const shown = b.networks.filter((n) => this.shows(n));
    const live = this.live;
    return html`<main class="lad">
      <header class="lad-block">
        <h1>${b.name} <span class="lad-badge">${b.type}</span> <span class="lad-badge">${b.language}</span></h1>
        ${b.title ? html`<p class="lad-title">${b.title}</p>` : nothing}
        ${b.comment ? html`<p class="lad-comment">${b.comment}</p>` : nothing}
        <div class="lad-tools">
          <input class="lad-filter" type="search" placeholder="Filter networks by name, operand or comment" aria-label="Filter networks" .value=${this.filter} @input=${(e: Event) => (this.filter = (e.target as HTMLInputElement).value)} @change=${() => this.monitoring && this.requestValues()} />
          <span class="lad-count">${shown.length === b.networks.length ? `${b.networks.length} networks` : `${shown.length} of ${b.networks.length} networks`}</span>
          <button class="rg-text-btn ${this.monitoring ? "lad-monitoring" : ""}" aria-pressed=${this.monitoring} @click=${() => this.toggleMonitor()} title="Read the operands from the PLC and show where power flows (read-only)"><span class="codicon codicon-${this.monitoring ? "eye-closed" : "eye"}"></span>${this.monitoring ? "Stop monitoring" : "Monitor"}</button>
          <button class="rg-text-btn" @click=${() => vscode.postMessage({ kind: "openText" })} title="Open the SimaticML file this view reads">Open as XML</button>
        </div>
        ${this.monitoring && live ? html`<p class="lad-live lad-live-${live.state}">${live.state === "live" ? html`<span class="codicon codicon-circle-filled"></span>` : nothing}${live.message}</p>` : nothing}
      </header>
      ${shown.map((n) => this.network(n, width))}
    </main>`;
  }
}
customElements.define("rg-ladder", RgLadder);
