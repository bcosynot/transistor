/**
 * Render tests for dashboard-transit-card.
 *
 * The card is a plain custom element (no Lit, no build step), so it can be
 * exercised directly with a minimal DOM stub — no browser required.
 *
 *   node --test tests/card.test.mjs
 *
 * All board data below is fictional, so the public test-suite carries no
 * deployment-specific location.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.childNodes = [];
    this.parentNode = null;
    this._html = "";
    this.className = "";
    this.style = {};
    this.textContent = "";
  }
  get children() {
    return this.childNodes;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  appendChild(child) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  // A real DOM refuses insertBefore() when the reference node is not already a
  // child — it throws NotFoundError. Modelling that is the whole point: an
  // earlier stub silently appended instead, which hid a card that threw on
  // every render and painted nothing at all.
  insertBefore(child, ref) {
    if (ref !== null && ref !== undefined && ref.parentNode !== this) {
      const err = new Error(
        "Failed to execute 'insertBefore' on 'Node': The node before which " +
          "the new node is to be inserted is not a child of this node.",
      );
      err.name = "NotFoundError";
      throw err;
    }
    if (child.parentNode) child.remove();
    child.parentNode = this;
    const i = this.childNodes.indexOf(ref);
    if (i < 0) this.childNodes.push(child);
    else this.childNodes.splice(i, 0, child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    if (i >= 0) this.parentNode.childNodes.splice(i, 1);
    this.parentNode = null;
  }
  set innerHTML(value) {
    this._html = value;
  }
  get innerHTML() {
    return this._html;
  }
  attachShadow() {
    this.shadowRoot = new FakeElement("#shadow");
    return this.shadowRoot;
  }
  /** Everything a browser would paint in this subtree, flattened. */
  paintedText() {
    return this._html + this.childNodes.map((c) => c.paintedText()).join("");
  }
}

globalThis.HTMLElement = FakeElement;
globalThis.document = { createElement: (tag) => new FakeElement(tag) };

const defined = new Map();
globalThis.customElements = {
  get: (name) => defined.get(name),
  define: (name, ctor) => defined.set(name, ctor),
};
globalThis.window = {};

await import("../homeassistant/dashboard-transit-card.js");
const Card = defined.get("dashboard-transit-card");

function makeCard(entityId, state) {
  const card = new Card();
  card.setConfig({ entity: entityId });
  card.hass = state === undefined ? { states: {} } : { states: { [entityId]: state } };
  return card;
}

/** The <ha-card> in the shadow root — the only thing the browser paints. */
function haCard(card) {
  return card.shadowRoot.childNodes.find((n) => n.tagName === "ha-card");
}

const BOARD = {
  state: "A 3/9 · B — · C99 4/12 · D44 6/14",
  attributes: {
    stale: false,
    generated: "2026-01-01T08:00:00+00:00",
    lines: [
      {
        line: "A", mode: "subway", stop: "Example Av", direction: "Downtown",
        deps: [{ min: 3, at: "8:03am" }, { min: 9, at: "8:09am" }],
      },
      { line: "B", mode: "subway", stop: "Example Av", direction: "Downtown", deps: [] },
      {
        line: "C99", mode: "bus", stop: "Example Rd/1 St", direction: "City Centre",
        deps: [{ min: 4, at: "8:04am" }, { min: 12, at: "8:12am" }],
      },
      {
        line: "D44", mode: "bus", stop: "Example Rd/1 St", direction: "City Centre",
        deps: [{ min: 0, at: "8:00am" }],
      },
    ],
  },
};

test("registers itself as a custom card", () => {
  assert.ok(Card, "custom element was defined");
  assert.ok(window.customCards.some((c) => c.type === "dashboard-transit-card"));
});

test("setConfig without an entity throws", () => {
  assert.throws(() => new Card().setConfig({}), /entity.*required/);
});

test("claims the full grid width", () => {
  assert.deepEqual(makeCard("sensor.x", BOARD).getGridOptions(), {
    columns: "full",
    rows: "auto",
  });
});

test("renders one row per line", () => {
  const html = makeCard("sensor.dashboard_transit", BOARD)._body.innerHTML;
  assert.equal((html.match(/class="row"/g) || []).length, 4);
  assert.match(html, /Downtown/);
  assert.match(html, /City Centre/);
});

test("the stop name is not rendered", () => {
  // Every line is at the same stop per mode, so the name was identical on every row
  // and only pushed the departure numbers apart. The direction stays.
  const html = makeCard("sensor.dashboard_transit", BOARD)._body.innerHTML;
  assert.ok(!html.includes("Example Av"), "subway stop name must not render");
  assert.ok(!html.includes("Example Rd/1 St"), "bus stop name must not render");
  assert.ok(!html.includes('class="name"'), "no stop-name element at all");
});

test("the line badge is sized to be read across a room", () => {
  const card = makeCard("sensor.dashboard_transit", BOARD);
  const css = card.shadowRoot.childNodes[0].textContent;
  assert.match(css, /\.badge\s*\{[^}]*min-width: 40px/);
  assert.match(css, /\.badge\s*\{[^}]*font-size: 1\.25rem/);
  assert.match(css, /\.badge\.wide\s*\{[^}]*font-size: 1rem/);
});

test("the badge column is fixed so rows line up", () => {
  // Each row is its own grid, so an auto badge column would size per row and
  // misalign the directions and numbers down the card.
  const css = makeCard("sensor.dashboard_transit", BOARD).shadowRoot.childNodes[0].textContent;
  assert.match(css, /\.row\s*\{[^}]*grid-template-columns: 56px minmax\(0, 1fr\) auto auto/);
});

test("shows minutes as the primary value and clock time as secondary", () => {
  const html = makeCard("sensor.dashboard_transit", BOARD)._body.innerHTML;
  assert.match(html, /class="min">3<\/div>/);
  assert.match(html, /8:03am/);
});

test("departure minutes carry no unit suffix", () => {
  const html = makeCard("sensor.dashboard_transit", BOARD)._body.innerHTML;
  assert.ok(!html.includes("min<"), "no 'min' suffix element");
  assert.ok(!/class="min">\d+min/.test(html), "no 'min' text in the minutes cell");
  // Every row's minutes cell is a bare number (or "now").
  for (const cell of html.matchAll(/class="min">([^<]*)</g)) {
    assert.match(cell[1], /^(now|\d+|—)$/, `unexpected minutes cell ${cell[1]}`);
  }
});

test("a departure under a minute reads as 'now'", () => {
  const html = makeCard("sensor.dashboard_transit", BOARD)._body.innerHTML;
  assert.match(html, /class="min">now</);
});

test("a line with no service renders an empty cell, not a crash", () => {
  const html = makeCard("sensor.dashboard_transit", BOARD)._body.innerHTML;
  // The B row exists with a dash and no clock time.
  assert.match(html, /class="dep empty"/);
});

test("bus and subway badges are colour-coded", () => {
  const html = makeCard("sensor.dashboard_transit", BOARD)._body.innerHTML;
  assert.match(html, /background:#fccc0a/); // subway yellow
  assert.match(html, /background:#1c5fa8/); // bus blue
});

test("only multi-character routes get the pill badge", () => {
  const html = makeCard("sensor.dashboard_transit", BOARD)._body.innerHTML;
  // A one-character subway route stays a circle…
  assert.match(html, /class="badge" style="background:#fccc0a/);
  // …while a three-character bus route needs the wider pill.
  assert.equal((html.match(/class="badge wide"/g) || []).length, 2);
});

test("a stale board is flagged in the header", () => {
  const stale = { ...BOARD, attributes: { ...BOARD.attributes, stale: true } };
  const card = makeCard("sensor.dashboard_transit", stale);
  assert.equal(card._card.className, "state-stale");
  assert.match(card._header.innerHTML, /stale/);
});

test("an unavailable entity renders a placeholder", () => {
  const card = makeCard("sensor.dashboard_transit", { state: "unavailable", attributes: {} });
  assert.match(card._body.innerHTML, /waiting for the transit feed/);
});

test("a missing entity renders a not-found placeholder", () => {
  const card = makeCard("sensor.nope", undefined);
  assert.match(card._body.innerHTML, /not found/);
});

test("markup in feed data is escaped", () => {
  const nasty = {
    state: "x",
    attributes: {
      lines: [
        {
          line: "<img src=x onerror=alert(1)>", mode: "bus",
          stop: "<b>unused</b>", direction: "<script>", deps: [],
        },
      ],
    },
  };
  const html = makeCard("sensor.dashboard_transit", nasty)._body.innerHTML;
  assert.ok(!html.includes("<img"), "raw tag must not survive");
  assert.ok(!html.includes("<script"), "raw tag must not survive");
  assert.match(html, /&lt;script&gt;/);
});

// --- regression: the card must be *painted*, not merely built ---------------
//
// The rows container was created but never appended to <ha-card>, so nothing
// the card produced was in the shadow tree: HA showed a full-width card whose
// only height was its own padding. Every assertion above still passed, because
// `_body.innerHTML` is readable on a detached node. These tests assert the
// shadow tree itself.

test("the rows container is a child of the card, not a detached node", () => {
  const card = makeCard("sensor.dashboard_transit", BOARD);
  assert.equal(card._body.parentNode, haCard(card), "rows must be in the shadow tree");
});

test("the card paints its rows into <ha-card>", () => {
  const card = makeCard("sensor.dashboard_transit", BOARD);
  const painted = haCard(card).paintedText();
  assert.match(painted, /Downtown/);
  assert.match(painted, /C99/);
  assert.equal((painted.match(/class="row"/g) || []).length, 4);
});

test("the header is inside <ha-card> and sits above the rows", () => {
  const card = makeCard("sensor.dashboard_transit", BOARD);
  const card_ = haCard(card);
  assert.equal(card._header.parentNode, card_, "header must be in the shadow tree");
  assert.equal(card_.childNodes.indexOf(card._header), 0, "header renders first");
  assert.equal(card_.childNodes.indexOf(card._body), 1, "rows follow the header");
});

test("a header-less render still paints the rows", () => {
  const card = new Card();
  card.setConfig({ entity: "sensor.dashboard_transit", title: null });
  card.hass = { states: { "sensor.dashboard_transit": BOARD } };
  assert.equal(card._header, null, "no header when title is null and nothing is stale");
  assert.match(haCard(card).paintedText(), /Downtown/);
});

test("a placeholder for a missing entity reaches the shadow tree", () => {
  const card = makeCard("sensor.nope", undefined);
  assert.match(haCard(card).paintedText(), /not found/);
});

test("re-rendering on every hass update does not duplicate the header", () => {
  const card = makeCard("sensor.dashboard_transit", BOARD);
  card.hass = { states: { "sensor.dashboard_transit": BOARD } };
  card.hass = { states: { "sensor.dashboard_transit": BOARD } };
  const headers = haCard(card).childNodes.filter((n) => n.className === "header");
  assert.equal(headers.length, 1);
});
