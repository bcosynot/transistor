/**
 * Render tests for kitchen-transit-card.
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
    this.children = [];
    this.parentNode = null;
    this._html = "";
    this.className = "";
    this.style = {};
    this.textContent = "";
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    child.parentNode = this;
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(child);
    else this.children.splice(i, 0, child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
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
}

globalThis.HTMLElement = FakeElement;
globalThis.document = { createElement: (tag) => new FakeElement(tag) };

const defined = new Map();
globalThis.customElements = {
  get: (name) => defined.get(name),
  define: (name, ctor) => defined.set(name, ctor),
};
globalThis.window = {};

await import("../homeassistant/kitchen-transit-card.js");
const Card = defined.get("kitchen-transit-card");

function makeCard(entityId, state) {
  const card = new Card();
  card.setConfig({ entity: entityId });
  card.hass = state === undefined ? { states: {} } : { states: { [entityId]: state } };
  return card;
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
  assert.ok(window.customCards.some((c) => c.type === "kitchen-transit-card"));
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
  const html = makeCard("sensor.kitchen_transit", BOARD)._body.innerHTML;
  assert.equal((html.match(/class="row"/g) || []).length, 4);
  assert.match(html, /Example Av/);
  assert.match(html, /Example Rd\/1 St/);
  assert.match(html, /Downtown/);
  assert.match(html, /City Centre/);
});

test("shows minutes as the primary value and clock time as secondary", () => {
  const html = makeCard("sensor.kitchen_transit", BOARD)._body.innerHTML;
  assert.match(html, /3<small>min<\/small>/);
  assert.match(html, /8:03am/);
});

test("a departure under a minute reads as 'now'", () => {
  const html = makeCard("sensor.kitchen_transit", BOARD)._body.innerHTML;
  assert.match(html, /class="min">now</);
});

test("a line with no service renders an empty cell, not a crash", () => {
  const html = makeCard("sensor.kitchen_transit", BOARD)._body.innerHTML;
  // The B row exists with a dash and no clock time.
  assert.match(html, /class="dep empty"/);
});

test("bus and subway badges are colour-coded", () => {
  const html = makeCard("sensor.kitchen_transit", BOARD)._body.innerHTML;
  assert.match(html, /background:#fccc0a/); // subway yellow
  assert.match(html, /background:#1c5fa8/); // bus blue
});

test("only multi-character routes get the pill badge", () => {
  const html = makeCard("sensor.kitchen_transit", BOARD)._body.innerHTML;
  // A one-character subway route stays a circle…
  assert.match(html, /class="badge" style="background:#fccc0a/);
  // …while a three-character bus route needs the wider pill.
  assert.equal((html.match(/class="badge wide"/g) || []).length, 2);
});

test("a stale board is flagged in the header", () => {
  const stale = { ...BOARD, attributes: { ...BOARD.attributes, stale: true } };
  const card = makeCard("sensor.kitchen_transit", stale);
  assert.equal(card._card.className, "state-stale");
  assert.match(card._header.innerHTML, /stale/);
});

test("an unavailable entity renders a placeholder", () => {
  const card = makeCard("sensor.kitchen_transit", { state: "unavailable", attributes: {} });
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
          stop: "<script>", direction: "&", deps: [],
        },
      ],
    },
  };
  const html = makeCard("sensor.kitchen_transit", nasty)._body.innerHTML;
  assert.ok(!html.includes("<img"), "raw tag must not survive");
  assert.ok(!html.includes("<script"), "raw tag must not survive");
  assert.match(html, /&lt;script&gt;/);
});
