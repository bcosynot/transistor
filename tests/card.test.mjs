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
    this.style = this.makeStyle();
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
  /** Enough of CSSStyleDeclaration for custom-property assertions. */
  makeStyle() {
    const props = new Map();
    return {
      setProperty(name, value) {
        props.set(name, String(value));
      },
      getPropertyValue(name) {
        return props.get(name) ?? "";
      },
      _props: props,
    };
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

function makeCard(entityId, state, config = {}) {
  const card = new Card();
  card.setConfig({ entity: entityId, ...config });
  card.hass = state === undefined ? { states: {} } : { states: { [entityId]: state } };
  return card;
}

/** The <ha-card> in the shadow root — the only thing the browser paints. */
function haCard(card) {
  return card.shadowRoot.childNodes.find((n) => n.tagName === "ha-card");
}

/** The rendered markup of one line's row, found by its badge label. */
function row(html, lineName) {
  return html.split('<div class="row">').find((r) => r.includes(`>${lineName}<`));
}

/** One line's row markup for the standard BOARD. */
function boardRow(lineName, config = {}) {
  const card = makeCard("sensor.dashboard_transit", BOARD, config);
  return row(card._body.innerHTML, lineName);
}

// Line A is a subway (12 min walk) with five departures, the first two of them
// (3 and 9 min) already unreachable — so its columns start at 15. C99 is a bus
// (3 min walk), so its 4 min departure is still catchable. D44 is a bus whose
// only departure is leaving now: nothing on that line is catchable at all.
// Every countdown below renders two digits ("03", not "3").
const BOARD = {
  state: "A 3/9 · B — · C99 4/12 · D44 now/6",
  attributes: {
    stale: false,
    generated: "2026-01-01T08:00:00+00:00",
    lines: [
      {
        line: "A", mode: "subway", stop: "Example Av", direction: "Downtown",
        deps: [
          { min: 3, at: "8:03am" }, { min: 9, at: "8:09am" }, { min: 15, at: "8:15am" },
          { min: 21, at: "8:21am" }, { min: 27, at: "8:27am" },
        ],
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
});

test("neither the stop name nor the direction is rendered", () => {
  // One stop and one direction per line, so both were identical on every row.
  const html = makeCard("sensor.dashboard_transit", BOARD)._body.innerHTML;
  assert.ok(!html.includes("Example Av"), "subway stop name must not render");
  assert.ok(!html.includes("Example Rd/1 St"), "bus stop name must not render");
  assert.ok(!html.includes("Downtown"), "subway direction must not render");
  assert.ok(!html.includes("City Centre"), "bus direction must not render");
  assert.ok(!html.includes('class="stop"'), "no stop/direction element at all");
});

// --- walk time: a departure you cannot reach is not a departure -------------

test("a departure inside the walk time is lifted out of the columns", () => {
  // A's 3 and 9 min departures are both inside the 12 min walk to the platform.
  const aRow = boardRow("A");
  const cells = aRow.slice(aRow.indexOf('class="lead"'));
  assert.ok(!/class="min">03</.test(cells), "the 3 min departure must not be a column");
  assert.ok(!/class="min">09</.test(cells), "the 9 min departure must not be a column");
  assert.match(cells, /class="min">15</);
  assert.equal((cells.match(/class="dep/g) || []).length, 3, "three catchable columns");
});

test("the uncatchable departure is shown to the right of the badge, outside the columns", () => {
  const aRow = boardRow("A");
  assert.match(aRow, /<div class="lead"><div class="badge[^>]*>A<\/div><span class="lost">03<\/span>/);
  // ...and only the soonest of them, not every one that was dropped.
  assert.equal((aRow.match(/class="lost"/g) || []).length, 1);
  assert.ok(!/class="lost">09</.test(aRow));
});

test("only the soonest uncatchable departure is advertised", () => {
  // Three minutes of walk, three buses inside it: only the first is shown.
  const board = {
    state: "x",
    attributes: {
      lines: [
        {
          line: "C99", mode: "bus", stop: "s", direction: "d",
          deps: [
            { min: 1, at: "8:01am" }, { min: 2, at: "8:02am" }, { min: 3, at: "8:03am" },
            { min: 40, at: "8:40am" },
          ],
        },
      ],
    },
  };
  const cRow = row(makeCard("sensor.dashboard_transit", board)._body.innerHTML, "C99");
  assert.equal((cRow.match(/class="lost"/g) || []).length, 1);
  assert.match(cRow, /class="lost">01</);
  // The other two are dropped, and the next catchable one leads the columns.
  assert.match(cRow, /<div class="dep"><span class="min">40</);
});

test("the walk time is per mode", () => {
  // Same board: 3 min is unreachable by subway (12), 4 min is fine by bus (3).
  assert.match(boardRow("A"), /class="lost">03</);
  const cRow = boardRow("C99");
  assert.match(cRow, /<span class="lost"><\/span>/);
  assert.match(cRow, /<div class="dep"><span class="min">04</);
});

test("nothing catchable: the columns still render, dimmed", () => {
  // D44's only departure is leaving now, and no bus in 3 min is catchable.
  const dRow = boardRow("D44");
  assert.equal((dRow.match(/class="dep unreachable"/g) || []).length, 1);
  assert.equal((dRow.match(/class="dep empty"/g) || []).length, 2);
  assert.match(dRow, /class="dep unreachable">\s*<span class="min">now</);
  // Nothing is advertised separately: the columns already are that departure.
  assert.match(dRow, /<span class="lost"><\/span>/);
});

test("the flag sits outside the departure columns and after the badge", () => {
  // A row with nothing lifted still reserves the cell, so the flags line up
  // down the card whatever each row carries.
  const cRow = boardRow("C99");
  assert.match(cRow, /<div class="badge wide"[^>]*>C99<\/div><span class="lost"><\/span>/);
  // The flag is its own cell before the first departure column, never inside
  // one of them.
  const aRow = boardRow("A");
  assert.ok(
    aRow.indexOf('class="lost"') < aRow.indexOf('class="dep'),
    "the flag must precede the departure columns",
  );
  assert.ok(!/class="dep[^"]*"><span class="lost"/.test(aRow), "the flag is not a departure cell");
});

test("walk_minutes overrides the default per mode", () => {
  // Zero means "do not filter this mode": the subway row is back to raw order.
  const aRow = boardRow("A", { walk_minutes: { subway: 0 } });
  assert.match(aRow, /<span class="lost"><\/span>/);
  assert.match(aRow, /<div class="dep"><span class="min">03</);
  assert.match(aRow, /class="min">15</);
});

test("a single walk_minutes number applies to every mode", () => {
  const aRow = boardRow("A", { walk_minutes: 5 });
  assert.match(aRow, /class="lost">03</);
  assert.match(aRow, /<div class="dep"><span class="min">09</); // 9 > 5, catchable
  const cRow = boardRow("C99", { walk_minutes: 5 });
  assert.match(cRow, /class="lost">04</);
  assert.match(cRow, /<div class="dep"><span class="min">12</);
});

test("a mode the walk time does not mention is not filtered", () => {
  const board = {
    state: "x",
    attributes: {
      lines: [
        { line: "F", mode: "tram", stop: "s", direction: "d", deps: [{ min: 1, at: "8:01am" }] },
      ],
    },
  };
  const fRow = row(makeCard("sensor.dashboard_transit", board)._body.innerHTML, "F");
  assert.match(fRow, /<span class="lost"><\/span>/);
  assert.match(fRow, /<div class="dep"><span class="min">01</);
});

test("a nonsense walk_minutes value does not break the render", () => {
  for (const walk_minutes of ["soon", null, {}, { subway: "later" }, -1, NaN]) {
    const html = makeCard("sensor.dashboard_transit", BOARD, { walk_minutes })._body.innerHTML;
    assert.equal((html.match(/class="row"/g) || []).length, 4, `walk_minutes: ${walk_minutes}`);
    assert.match(html, /class="min">15</, `walk_minutes: ${walk_minutes} must fall back to the default`);
  }
});

test("a line with no service advertises nothing", () => {
  const bRow = boardRow("B");
  assert.match(bRow, /<span class="lost"><\/span>/);
  assert.equal((bRow.match(/class="dep empty"/g) || []).length, 3);
});

// --- columns, type, and layout ---------------------------------------------

test("renders three departure columns by default", () => {
  const aRow = boardRow("A");
  // Five departures, two of them unreachable; the columns are what is left.
  assert.equal((aRow.match(/class="dep/g) || []).length, 3);
  assert.match(aRow, /class="min">15</);
  assert.match(aRow, /class="min">21</);
  assert.match(aRow, /class="min">27</);
  const cells = aRow.slice(aRow.indexOf('class="lead"'));
  assert.ok(!/class="min">09</.test(cells), "the dropped departure must not be a column");
});

test("the departures option sets the column count", () => {
  const aRow = boardRow("A", { departures: 2 });
  assert.equal((aRow.match(/class="dep/g) || []).length, 2);
  assert.match(aRow, /class="min">15</);
  assert.match(aRow, /class="min">21</);
  assert.ok(!aRow.includes(">27<"), "third departure must not render at departures: 2");
});

test("the row grid's column count follows the departures option", () => {
  // A hardcoded repeat() would leave a dead column and squeeze the cells
  // whenever the count and the rendering disagreed.
  const three = makeCard("sensor.dashboard_transit", BOARD);
  assert.equal(three.style.getPropertyValue("--dep-columns"), "3");
  const five = makeCard("sensor.dashboard_transit", BOARD, { departures: 5 });
  assert.equal(five.style.getPropertyValue("--dep-columns"), "5");
  assert.match(
    three.shadowRoot.childNodes[0].textContent,
    /grid-template-columns: var\(--lead-col, 94px\) repeat\(var\(--dep-columns, 3\), minmax\(0, 1fr\)\)/,
  );
});

test("a short line still renders every column", () => {
  const cRow = boardRow("C99");
  // Two departures, three columns: two filled, one empty.
  assert.equal((cRow.match(/class="dep/g) || []).length, 3);
  assert.equal((cRow.match(/class="dep empty"/g) || []).length, 1);
});

test("the line badge is sized to be read across a room", () => {
  const card = makeCard("sensor.dashboard_transit", BOARD);
  const css = card.shadowRoot.childNodes[0].textContent;
  assert.match(css, /\.badge\s*\{[^}]*min-width: 40px/);
  assert.match(css, /\.badge\s*\{[^}]*font-size: 1\.25rem/);
  assert.match(css, /\.badge\.wide\s*\{[^}]*font-size: 1rem/);
});

test("the lead column is fixed and the departure columns equal", () => {
  // Each row is its own grid, so content-sized columns would resolve per row and
  // the numbers would stop lining up down the card.
  const css = makeCard("sensor.dashboard_transit", BOARD).shadowRoot.childNodes[0].textContent;
  assert.match(css, /\.row\s*\{[^}]*grid-template-columns: var\(--lead-col/);
});

test("the uncatchable departure is a step under the countdown, and struck through", () => {
  // Colour alone is a weak signal for a colour-blind reader; the strike carries
  // the meaning. It is a number, not a label, so it sits one step under the
  // countdowns rather than at the card's label size. Its cell is fixed-width
  // too, so it cannot move with its value and the flags stay in one column.
  const css = makeCard("sensor.dashboard_transit", BOARD).shadowRoot.childNodes[0].textContent;
  assert.match(css, /\.lead\s*\{[^}]*grid-template-columns: 52px var\(--lost-col, 38px\)/);
  assert.match(css, /\.lead \.lost\s*\{[^}]*font-size: 2\.2rem/);
  assert.match(css, /\.lead \.lost\s*\{[^}]*text-decoration: line-through/);
  assert.match(css, /\.dep \.min\s*\{[^}]*font-size: 2\.4rem/);
  assert.match(css, /\.dep\.unreachable \.min\s*\{[^}]*opacity: 0\.45/);
  // The clock time is dropped in that state: "now" beside a clock time does
  // not fit the cell, and none of those departures is catchable anyway.
  assert.match(css, /\.dep\.unreachable \.at\s*\{[^}]*display: none/);
});

test("a flag reading 'now' takes the word's smaller size", () => {
  // "now" at the number size is 57px against the flag's 38px cell and clips.
  const css = makeCard("sensor.dashboard_transit", BOARD).shadowRoot.childNodes[0].textContent;
  assert.match(css, /\.lead \.lost\.word\s*\{[^}]*font-size: 1\.4rem/);
  // A departure leaving now, on a line where something later is catchable, is
  // flagged as the word rather than a number.
  const board = {
    state: "x",
    attributes: {
      lines: [
        {
          line: "C99", mode: "bus", stop: "s", direction: "d",
          deps: [{ min: 0, at: "8:00am" }, { min: 40, at: "8:40am" }],
        },
      ],
    },
  };
  const cRow = row(makeCard("sensor.dashboard_transit", board)._body.innerHTML, "C99");
  assert.match(cRow, /<span class="lost word">now<\/span>/);
  // ...and a numeric flag is not the word.
  assert.match(boardRow("A"), /<span class="lost">03<\/span>/);
});

test("the clock time sits beside the countdown, not under it", () => {
  const html = makeCard("sensor.dashboard_transit", BOARD)._body.innerHTML;
  // Both values inside one .dep cell, countdown first.
  assert.match(html, /<div class="dep"><span class="min">15<\/span><span class="at">8:15am<\/span><\/div>/);
  assert.ok(!/<div class="at">/.test(html), "the clock time is a span, not its own block");
});

test("the clock time is set smaller than the countdown", () => {
  const css = makeCard("sensor.dashboard_transit", BOARD).shadowRoot.childNodes[0].textContent;
  assert.match(css, /\.dep \.min\s*\{[^}]*font-size: 2\.4rem/);
  assert.match(css, /\.dep \.at\s*\{[^}]*font-size: 0\.8rem/);
});

test("every countdown is two digits", () => {
  // A bare "8" beside a "12" leaves the columns ragged on the left. The
  // one-hour horizon caps a value at 60, so two digits covers every value.
  const board = {
    state: "x",
    attributes: {
      lines: [
        {
          line: "C99", mode: "bus", stop: "s", direction: "d",
          deps: [{ min: 8, at: "8:08am" }, { min: 48, at: "8:48am" }],
        },
      ],
    },
  };
  const html = makeCard("sensor.dashboard_transit", board)._body.innerHTML;
  assert.match(html, /class="min">08</);
  assert.match(html, /class="min">48</);
  assert.ok(!/class="min">8</.test(html), "a single-digit countdown must be padded");
  // The flag is padded the same way, so it matches the columns it sits beside.
  const flagged = row(
    makeCard("sensor.dashboard_transit", board, { walk_minutes: 10 })._body.innerHTML,
    "C99",
  );
  assert.match(flagged, /<span class="lost">08<\/span>/);
});

test("departure minutes carry no unit suffix", () => {
  const html = makeCard("sensor.dashboard_transit", BOARD)._body.innerHTML;
  assert.ok(!html.includes("min<"), "no 'min' suffix element");
  assert.ok(!/class="min">\d+min/.test(html), "no 'min' text in the minutes cell");
  // Every row's minutes cell is two digits, or "now", or the empty-line dash.
  for (const cell of html.matchAll(/class="min">([^<]*)</g)) {
    assert.match(cell[1], /^(now|—|\d{2})$/, `unexpected minutes cell ${cell[1]}`);
  }
});

test("a departure under a minute reads as 'now'", () => {
  const html = makeCard("sensor.dashboard_transit", BOARD)._body.innerHTML;
  assert.match(html, /class="min">now</);
});

test("a line with no service gets one dash, not one per column", () => {
  const bRow = boardRow("B");
  assert.equal((bRow.match(/class="dep empty"/g) || []).length, 3);
  assert.equal((bRow.match(/—/g) || []).length, 1, "exactly one dash for the whole line");
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
          stop: "<b>unused</b>", direction: "<i>unused</i>",
          deps: [{ min: 1, at: "<script>" }],
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
  assert.match(painted, /8:15am/);
  assert.match(painted, /C99/);
  assert.match(painted, /class="lost">03</);
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
  assert.match(haCard(card).paintedText(), /8:15am/);
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
