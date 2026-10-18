/**
 * dashboard-transit-card
 *
 * Renders the transistor MQTT board (sensor.dashboard_transit) as one row per
 * line: a route badge sized to be read across a room, then the next N
 * departures, each showing minutes away (no "min" suffix: it is the same on
 * every column, so it only ate width) with the clock time beside it.
 *
 * The stop name and direction are deliberately omitted; the board is one stop
 * and one direction per line, so both were identical on every row.
 *
 * Config:
 *   type: custom:dashboard-transit-card
 *   entity: sensor.dashboard_transit
 *   title: Transit              # optional, hides the header when null
 *   departures: 4               # optional, columns to render
 *
 * Written as a plain custom element (no Lit, no build step) because a
 * markdown card cannot carry the styling — HA strips every `style` attribute
 * from markdown content.
 */

const SUBWAY_BADGE = { bg: "#fccc0a", fg: "#111" }; // N/Q/R/W are all yellow
const BUS_BADGE = { bg: "#1c5fa8", fg: "#fff" };

const STYLES = `
:host { display: block; height: 100%; }
ha-card {
  height: 100%;
  box-sizing: border-box;
  padding: 10px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  opacity: 0.9;
}
.header .meta { font-size: 0.72rem; font-weight: 400; opacity: 0.6; }
.rows { display: flex; flex-direction: column; gap: 6px; flex: 1; justify-content: center; }
.row {
  display: grid;
  /* Fixed badge column, equal departure columns. Each row is its own grid, so
   * content-sized columns would resolve per row and the numbers would stop
   * lining up down the card. 56px fits the widest pill. */
  grid-template-columns: 56px repeat(4, minmax(0, 1fr));
  align-items: center;
  column-gap: 8px;
}
.badge {
  justify-self: center;
  min-width: 40px; height: 40px;
  padding: 0 8px;
  box-sizing: border-box;
  border-radius: 20px;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700;
  font-size: 1.25rem;
  line-height: 1;
}
.badge.wide { font-size: 1rem; }
/* Clock time sits beside the countdown rather than under it — a fourth
   departure fits in the row only if the two share a line. */
.dep {
  display: flex; align-items: baseline; justify-content: flex-end;
  gap: 4px; min-width: 0; white-space: nowrap;
}
.dep .min { font-size: 1.28rem; font-weight: 600; line-height: 1.05; font-variant-numeric: tabular-nums; }
.dep .at { font-size: 0.68rem; opacity: 0.6; font-variant-numeric: tabular-nums; }
.dep.empty .min { opacity: 0.3; }
.none { text-align: center; opacity: 0.6; font-size: 0.85rem; padding: 8px 0; }
.state-stale .header .meta { color: var(--warning-color, #ffa726); opacity: 1; }
`;

class DashboardTransitCard extends HTMLElement {
  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("dashboard-transit-card: 'entity' is required");
    }
    this._config = config;
    this._build();
  }

  set hass(hass) {
    this._hass = hass;
    this._build();
  }

  connectedCallback() {
    this._build();
  }

  getCardSize() {
    return 4;
  }

  // A custom card defaults to 12 of a section's 24 grid columns, which would
  // make it half-width. Claim the full row explicitly.
  getGridOptions() {
    return { columns: "full", rows: "auto" };
  }

  _build() {
    if (!this._config) return;
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = STYLES;
      this.shadowRoot.appendChild(style);
      this._card = document.createElement("ha-card");
      this.shadowRoot.appendChild(this._card);
      this._body = document.createElement("div");
      this._body.className = "rows";
      // The rows container MUST be a child of the card, not just a detached
      // node holding markup: a detached `_body` is never painted, and
      // `_renderHeader()` inserts the header *before* it — which throws
      // NotFoundError against a real DOM when it has no parent.
      this._card.appendChild(this._body);
      this._header = null;
    }
    this._render();
  }

  _render() {
    const entityId = this._config.entity;
    const state = this._hass && this._hass.states ? this._hass.states[entityId] : undefined;

    if (!state) {
      this._card.className = "state-stale";
      this._setBody(`<div class="none">${this._esc(entityId)} not found</div>`);
      return;
    }

    const attrs = state.attributes || {};
    const lines = Array.isArray(attrs.lines) ? attrs.lines : [];
    const stale = attrs.stale === true;
    const unavailable = state.state === "unavailable" || state.state === "unknown";

    this._card.className = stale || unavailable ? "state-stale" : "";
    this._renderHeader(unavailable ? "no data" : stale ? "stale" : "");

    if (unavailable || lines.length === 0) {
      this._setBody(`<div class="none">${unavailable ? "waiting for the transit feed" : "no lines configured"}</div>`);
      return;
    }

    this._setBody(lines.map((line) => this._renderRow(line)).join(""));
  }

  _renderHeader(meta) {
    const title = this._config.title === null ? null : this._config.title || "Transit";
    if (!title && !meta) {
      if (this._header) this._header.remove();
      this._header = null;
      return;
    }
    if (!this._header) {
      this._header = document.createElement("div");
      this._header.className = "header";
      // Prepend: the header belongs above the rows. insertBefore() needs the
      // reference node to already be a child of the card.
      this._card.insertBefore(this._header, this._card.firstChild);
    }
    this._header.innerHTML = `<span>${this._esc(title || "")}</span><span class="meta">${this._esc(meta || "")}</span>`;
  }

  _renderRow(line) {
    const lineName = String(line.line || "");
    const isBus = line.mode === "bus";
    const colors = isBus ? BUS_BADGE : SUBWAY_BADGE;
    const wide = lineName.length > 2;
    const badge = `<div class="badge${wide ? " wide" : ""}" style="background:${colors.bg};color:${colors.fg}">${this._esc(lineName)}</div>`;

    // Neither the stop name nor the direction is shown: the board watches one
    // stop and one direction per line, so both were identical on every row.
    const deps = Array.isArray(line.deps) ? line.deps : [];
    const count = this._departures();
    const cells = [];
    for (let idx = 0; idx < count; idx++) {
      const dep = deps[idx];
      if (!dep) {
        // A line with no service at all gets a single dash in its first column,
        // not one per empty column.
        const dash = deps.length === 0 && idx === 0 ? '<span class="min">—</span>' : "";
        cells.push(`<div class="dep empty">${dash}</div>`);
        continue;
      }
      const min = Number(dep.min);
      const label = min <= 0 ? "now" : String(min);
      cells.push(
        `<div class="dep"><span class="min">${label}</span>` +
          `<span class="at">${this._esc(dep.at || "")}</span></div>`
      );
    }

    return `<div class="row">${badge}${cells.join("")}</div>`;
  }

  _departures() {
    const n = Number(this._config.departures);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
  }

  _setBody(html) {
    this._body.innerHTML = html;
  }

  _esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  static getStubConfig() {
    return { entity: "sensor.dashboard_transit", title: "Transit", departures: 4 };
  }
}

if (!customElements.get("dashboard-transit-card")) {
  customElements.define("dashboard-transit-card", DashboardTransitCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "dashboard-transit-card")) {
  window.customCards.push({
    type: "dashboard-transit-card",
    name: "Dashboard Transit",
    description: "Next departures for your configured transit lines.",
  });
}
