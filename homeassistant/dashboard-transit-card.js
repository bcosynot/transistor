/**
 * dashboard-transit-card
 *
 * Renders the transistor MQTT board (sensor.dashboard_transit) as a dense row
 * per line: route badge, stop/direction, then the next two departures with
 * minutes-away as the primary value and the clock time as the secondary.
 *
 * Config:
 *   type: custom:dashboard-transit-card
 *   entity: sensor.dashboard_transit
 *   title: Transit            # optional, hides the header when null
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
  grid-template-columns: 34px minmax(0, 1fr) auto auto;
  align-items: center;
  column-gap: 10px;
}
.badge {
  width: 30px; height: 30px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700;
  font-size: 0.82rem;
  line-height: 1;
}
.badge.wide { border-radius: 15px; font-size: 0.68rem; }
.stop { min-width: 0; }
.stop .name {
  font-size: 0.82rem; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.stop .dir { font-size: 0.68rem; opacity: 0.55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dep { text-align: right; min-width: 52px; }
.dep .min { font-size: 1.28rem; font-weight: 600; line-height: 1.05; font-variant-numeric: tabular-nums; }
.dep .min small { font-size: 0.6rem; font-weight: 400; opacity: 0.6; margin-left: 1px; }
.dep .at { font-size: 0.7rem; opacity: 0.55; font-variant-numeric: tabular-nums; }
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

    const stop = `
      <div class="stop">
        <div class="name">${this._esc(line.stop || "")}</div>
        <div class="dir">${this._esc(line.direction || "")}</div>
      </div>`;

    const deps = Array.isArray(line.deps) ? line.deps : [];
    const cells = [0, 1].map((idx) => {
      const dep = deps[idx];
      if (!dep) {
        return `<div class="dep empty"><div class="min">—</div></div>`;
      }
      const min = Number(dep.min);
      const label = min <= 0 ? "now" : `${min}<small>min</small>`;
      return `<div class="dep"><div class="min">${label}</div><div class="at">${this._esc(dep.at || "")}</div></div>`;
    });

    return `<div class="row">${badge}${stop}${cells.join("")}</div>`;
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
    return { entity: "sensor.dashboard_transit", title: "Transit" };
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
