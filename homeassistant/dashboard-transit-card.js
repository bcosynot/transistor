/**
 * dashboard-transit-card
 *
 * Renders the transistor MQTT board (sensor.dashboard_transit) as one row per
 * line: a route badge sized to be read across a room, then the next N
 * departures, each showing minutes away (no "min" suffix: it is the same on
 * every column, so it only ate width) with the clock time beside it. Countdowns
 * are always two digits — the one-hour horizon caps a value at 60, and a bare
 * "8" beside a "12" leaves the columns ragged on the left.
 *
 * The stop name and direction are deliberately omitted; the board is one stop
 * and one direction per line, so both were identical on every row.
 *
 * WALK TIME. A departure you cannot reach is not a departure: the card is in
 * the kitchen, and reaching the platform takes minutes. Any departure inside
 * `walk_minutes` for its mode is *uncatchable*, so it is lifted out of the
 * three columns and shown struck through just right of the route badge, and
 * the columns show the next three departures you can actually make. Only the
 * soonest uncatchable one is shown — the rest of that prefix is simply
 * dropped. When nothing at all is catchable (a bus every 2 min against a
 * 3 min walk) the soonest departures are shown anyway, dimmed, so a row is
 * never blank.
 *
 * Config:
 *   type: custom:dashboard-transit-card
 *   entity: sensor.dashboard_transit
 *   title: Transit              # optional, hides the header when null
 *   departures: 4               # optional, columns to render
 *   walk_minutes:               # optional, minutes to reach the stop
 *     subway: 12                # mode -> minutes; 0 or omitted disables the
 *     bus: 3                    # filter for that mode, so nothing is lifted
 *
 * Written as a plain custom element (no Lit, no build step) because a
 * markdown card cannot carry the styling — HA strips every `style` attribute
 * from markdown content.
 */

const SUBWAY_BADGE = { bg: "#fccc0a", fg: "#111" }; // N/Q/R/W are all yellow
const BUS_BADGE = { bg: "#1c5fa8", fg: "#fff" };

// How long it takes to reach the stop, per mode. Any departure closer than
// this is one you will watch leave. Overridden (per mode, or merged over) by
// the card's own walk_minutes option.
const WALK_MINUTES = { subway: 12, bus: 3 };

const STYLES = `
:host { display: block; height: 100%; }
ha-card {
  height: 100%;
  box-sizing: border-box;
  padding: 10px 10px 12px;
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
  /* Fixed lead column (the badge plus the uncatchable departure beside it),
   * then equal departure columns. Each row is its own grid, so content-sized
   * columns would resolve per row and the numbers would stop lining up down
   * the card. The departure column count comes from the card's departures
   * option, via the --dep-columns custom property. */
  grid-template-columns: var(--lead-col, 94px) repeat(var(--dep-columns, 3), minmax(0, 1fr));
  align-items: center;
  /* Tighter than the card's original 8px: the lead cell grew to hold the
   * uncatchable departure at a readable size, and the columns are right-aligned
   * numbers, so the gap between them can give the width up without the
   * clusters moving any closer. */
  column-gap: 6px;
}
/* The lead cell is a grid too, and the uncatchable cell is in it even when
 * empty: the badge sub-column is fixed and the flag starts right after it,
 * so neither the badge nor the flag moves on the rows that carry one. The
 * badge sub-column is sized for the widest pill ("Q100" at 1rem + padding). */
.lead {
  display: grid;
  grid-template-columns: 52px var(--lost-col, 38px);
  align-items: center;
  justify-content: start;
  column-gap: 4px;
  min-width: 0;
}
/* The departure you are about to lose. It is a number, not a label, so it runs
 * one step under the countdowns (2.2rem against their 2.4rem) rather than down
 * at the card's label size — but still struck through, so the meaning does not
 * rest on the colour alone, and still in a fixed-width cell, so it cannot move
 * with its value or shift the columns. */
.lead .lost {
  text-align: left;
  font-size: 2.2rem;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--warning-color, #ffa726);
  text-decoration: line-through;
  text-decoration-thickness: 2px;
}
/* A departure that is leaving as you look at it is flagged "now", and three
 * letters do not ride at the number's size: measured, "now" at 2.2rem is 57px
 * against the cell's 38px and would clip. The word takes a step down; the
 * digits keep the number's size. */
.lead .lost.word { font-size: 1.4rem; }
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
.dep .min { font-size: 2.4rem; font-weight: 600; line-height: 1.05; font-variant-numeric: tabular-nums; }
.dep .at { font-size: 0.8rem; opacity: 0.7; font-variant-numeric: tabular-nums; }
.dep.empty .min { opacity: 0.3; }
/* Nothing on this line is catchable: the numbers are still the useful ones
 * (the next bus is still the next bus), so they stay — just stepped back. The
 * clock times go: measured, "now" plus a 7-character time needs 110px against
 * an 88px cell and would run into the neighbouring number, and in a state
 * where none of them can be caught the exact clock time is the least useful
 * thing on the row. */
.dep.unreachable .min { opacity: 0.45; }
.dep.unreachable .at { display: none; }
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
    // The row grid's column count has to match the cells actually rendered.
    this.style.setProperty("--dep-columns", String(this._departures()));
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
    const cutoff = this._walkMinutes(line.mode);
    // Minutes ascend down the list, so the uncatchable ones are always a
    // prefix: filter it off and show the next catchable departures instead.
    const reachable = cutoff > 0 ? deps.filter((d) => Number(d.min) > cutoff) : deps;
    const dropped = reachable.length < deps.length;
    // Only the soonest uncatchable departure is advertised. When none of them
    // is catchable the columns show the raw list (dimmed) and there is nothing
    // to advertise separately — the badge would only repeat column one.
    const lost = dropped && reachable.length > 0 ? deps[0] : null;
    const shown = reachable.length > 0 ? reachable : deps;
    const dimmed = dropped && reachable.length === 0;

    // The uncatchable cell is always rendered, even empty — to the right of
    // the badge, and its own fixed-width cell, so the flags line up down the
    // card whether or not a row has one. A word ("now") needs a smaller size
    // than a number to fit that cell; see the CSS.
    const lostLabel = lost ? this._minutesLabel(lost) : "";
    const lostCell =
      `<span class="lost${lostLabel === "now" ? " word" : ""}">${this._esc(lostLabel)}</span>`;
    const lead = `<div class="lead">${badge}${lostCell}</div>`;

    const count = this._departures();
    const cells = [];
    for (let idx = 0; idx < count; idx++) {
      const dep = shown[idx];
      if (!dep) {
        // A line with no service at all gets a single dash in its first column,
        // not one per empty column.
        const dash = deps.length === 0 && idx === 0 ? '<span class="min">—</span>' : "";
        cells.push(`<div class="dep empty">${dash}</div>`);
        continue;
      }
      cells.push(
        `<div class="dep${dimmed ? " unreachable" : ""}">` +
          `<span class="min">${this._esc(this._minutesLabel(dep))}</span>` +
          `<span class="at">${this._esc(dep.at || "")}</span></div>`
      );
    }

    return `<div class="row">${lead}${cells.join("")}</div>`;
  }

  /** Countdown text for a departure: "now" under a minute, else two digits. */
  _minutesLabel(dep) {
    const min = Number(dep.min);
    // Always two digits. A bare "8" beside a "12" leaves the columns ragged on
    // the left, and the one-hour horizon caps a value at 60 — so two digits
    // covers every value there can be.
    return min <= 0 ? "now" : String(min).padStart(2, "0");
  }

  /**
   * Minutes needed to reach the stop for a mode, 0 meaning "do not filter".
   * A number applies to every mode; a mapping is merged over the defaults, so
   * setting one mode to 0 turns the filter off for that mode alone.
   */
  _walkMinutes(mode) {
    const override = this._config.walk_minutes;
    if (typeof override === "number") return Number.isFinite(override) ? Math.max(0, override) : 0;
    const table = override && typeof override === "object" ? override : {};
    const value = mode in table ? table[mode] : WALK_MINUTES[mode];
    const minutes = Number(value);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
  }

  _departures() {
    const n = Number(this._config.departures);
    // Three by default: at the card's ~400px the countdown has to stay big
    // enough to read across a room, and a fourth column forces it down.
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
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
