# MGC Pricing — HTML prototype

> **Demo data.** Every figure in this repository is an illustrative placeholder — the cost basis, the margins, the premiums and discounts, and all 175 clients are made up. They are not MGC's costs, margins or customers, and no number here should be quoted or relied on.

> **Still open: the floor definition.** The prototype uses
> `floor_per_kg = acq + hauling + margin(channel, sku)` — net of premiums and buffer.
> Discounts may not push the final price below it without an approved request.
> Each account has `floorOverridePerKg` so a real floor can be set later without touching the engine.
> **Do not treat this as settled.**

A working calculator, logger and decision tool for LPG pricing. Static HTML and vanilla JS modules plus one seed JSON. No build, no npm, no server code.

## Run

```bash
cd mgc-pricing
python serve.py 8000
```

Open http://localhost:8000/. Engine tests: http://localhost:8000/engine.test.html.

`serve.py` is `http.server` with `Cache-Control: no-store`, so an edited file is never served from a stale browser cache. `python3 -m http.server 8000` also works, but after an update reload with Ctrl+Shift+R or you may run a mix of old and new files.

Serve it over HTTP. Browsers block ES modules and `fetch` on `file://`, and `crypto.subtle` (SHA-256 snapshot hashes) needs `localhost` or HTTPS.

## Shared database (Supabase)

By default the app keeps its data in the browser (localStorage). To share one real database between people:

1. Create a free project at supabase.com.
2. Open **SQL editor**, paste `db/schema.sql`, run it. It creates one table per collection (each row is `id` plus the record as `jsonb`), turns on row-level security, makes `events` append-only and enables live updates.
3. In **Project settings → API** copy the Project URL and the `anon` key into `js/config.js`.
4. Open the app. The first browser to connect loads the demo data into the empty database; the top bar shows **● Database** when it is connected, **○ Local only** when `config.js` is empty and **○ Offline, local copy** when the database cannot be reached.

Every change is written to the database before it appears on screen; if the database refuses, nothing changes and the page says so. Other open browsers pick up changes within a second or so.

**Demo data only.** The stage-1 policies in `schema.sql` let anyone with the anon key read and write. Before any real MGC data goes in, turn on Supabase Auth and replace those policies with role checks (an example is at the bottom of `schema.sql`).

**Price history.** The seed holds five published versions (v1–v5, April–August 2026) with their proposals, approvals, past cost basis and margins, v5 notice acknowledgements and a few notice emails. `node tools/make-versions.mjs` rebuilds them in `data/seed.json`; v5 is always today's price list. A browser saved before this existed is upgraded to the five versions on its next load.

## Screens

| Route | Role | What it is |
|---|---|---|
| `#/quote` | seller | Quote desk: customer → **All products** price list, or one product with quantity. No editable price field, no floor or ladder shown. Send quote, Request lower, Print, Save price list, Past quotes |
| `#/priceroom` | manager | Clients board, Products board, Channels board (compare up to 5 each), PL notices. The **MPL calculator** and **Exceptions** live in a sliding panel on the right; changes added in the calculator are previewed on every board until published |
| `#/market` | messenger | Competitor price watch: readings with a required photo. No MGC prices |
| `#/board/:channelId` | manager, seller (own), viewer (own) | Price list: Acknowledge, Print, Save |
| `#/log` | manager | Append-only event log, four views |
| `#/config` | manager | Users and roles; channels and their order; clients list with CSV import / export |

**Configuration holds the lists the rest of the app reads:** Users, Channels, Products, Price watch zones and Clients. Each list can be reordered, and that order is the order used everywhere. Renaming is safe — IDs never change — and a row can only be removed once nothing references it. Every save is logged. In Clients, **Edit** opens one client's basic record (name, channel, status, needs attention, zone, main product, average monthly volume, credit term, competitor brand) above its terms; renaming a zone carries its readings and clients across.

**Channel order.** Configuration → Channels sets the sequence used by every channel list in the app — price lists, the Channels board, PL notices, the client pricing grid, pickers and the Quote desk. Names and audiences are editable there, channels can be added (the ID comes from the name and never changes afterwards), and one can be removed once it has no clients and no priced products. Changes are logged.

## Documents

Print, Save price list and Send quote all use one template (`js/pricedoc.js`): short bond (8.5 × 11 in) portrait, drawn on a canvas and saved as a one-page PDF with no library. Send quote downloads the quotation PDF; Past quotes can reprint it from the immutable snapshot. On the Quote desk, printing or saving a customer price list is gated like sending (current price list, no pending request, no unapproved below-floor price) and logged as `PRICE_LIST_ISSUED`; lines that need approval are left off.

## Client pricing grid

Price room → **Client pricing**, or the channel buttons inside the MPL calculator. One page per channel: clients down the side, line types across the top.

- **Current price offered** is view only, with MPL (acquisition + margin) and Margin (margin + buffer) underneath.
- **Two column groups.** *Premiums*: Total premium (view only, updating as you type), Installation cost for ROI, Credit risk / bad debts. *Discounts*: Supply only, Competition (dual supplier), Cash / zero-rated (short term).
- Every cell takes **several rows per client** — an investment amount (ROI only), a ₱/kg and a note. A blank ₱/kg on an ROI row divides the investment by the client's TRMV. Fields open with the last saved amounts.
- **The client name expands** its terms, **view only**: install date, LPG content billing, factor rate, tank ownership, tank counts by size (with 60% of 90% capacity computed), minimum kilograms per drop, fixed margin, total investment, required volume per month, start date and total generated volume. Edit them in **Configuration → Clients → Edit terms**, where they are saved and logged as `CLIENT_TERMS_SAVED`.
- **One Save button** adds every premium and discount edit to the open MPL proposal; they take effect on Publish.
- A **fixed margin** on a client replaces the channel margin, and moves that client's floor with it.

In the calculator itself, premiums and discounts are now one entry type: pick the client, then any component (premiums shown with +, discounts with −).

## Importing clients

Configuration → Clients. Choose a CSV (or paste rows from Google Sheets), check the preview, then import. Required columns: **Name, Channel, Status**. Optional: Account ID, Needs attention, Zone, Main product, Contract start / end, TRMV kg, Volume generated kg, Avg monthly volume kg, Credit term days, Floor override per kg, Premiums (`TANK_RENTAL; CREDIT_30`), Discounts (`DUAL_SUPPLIER=6.25`), Competitor brand, Installation investment, Entrusted cylinders, Cylinder cost. "Download template" gives a ready header row. Clients match by Account ID, then by name; a column left out keeps the client's current value. "Active but needs attention" imports as Inactive with the needs-attention flag. Rows with errors are skipped and listed. The import is logged.

**Role switcher.** "Acting as" in the header stands in for auth. Routes a role can't reach are never rendered — the view module isn't even loaded.

## Checks and balances it enforces

1. **No price typing.** Sellers cannot enter a price. Below floor, Send is disabled; the only route is Request lower, which requires a reason and a competitor reading.
2. **Freshness gate.** If the cost basis is newer than the published board, quotes cannot be sent.
3. **Simulate before approve.** Price changes go Draft → Simulate → Review → Approve → Publish, in order. Simulation writes nothing but its own log event.
4. **Four eyes.** Approval needs `instructedBy` and `verifiedBy`, and the verifier cannot be the drafter.
5. **Immutable quotes and versioned prices.** A sent quote stores the full engine input and output with a SHA-256 hash. Price rows are never updated; publish closes the old version (`effectiveTo`) and inserts a new one.
6. **The log is not optional.** Every mutation goes through `store.commit(event, mutationFn)`, the same call that changes the data. There is no "add log entry" button.

Also: competitor readings older than 7 days render greyed with their age; a reading more than 10% off the last one for that brand, zone and product must be confirmed.

## Files

```
js/engine.js     pure pricing function — no DOM, no imports, no clock. Ports verbatim.
js/money.js      integer centavos, half-up rounding, ₱ formatting
js/store.js      seed load, localStorage (key mgc_pricing_v1), commit(), export/import/reset
js/pricing.js    store-aware selectors: effective-dated lookups, account pricing, simulation, exceptions
js/router.js     hash router and role gate
js/ui.js         small DOM helpers
js/views/*       one module per screen (priceroom-wizard.js holds the five-step change flow)
js/clientterms.js   client term fields, shared by the grid (read) and Configuration (edit)
data/seed.json      configuration: costs, margins, components, channels, users
data/clients.mock.json  generated demo clients and competitor readings
tools/make-mock-clients.mjs  generator for the file above
engine.test.html    browser test page for the engine
serve.py            static server with no caching
```

## Seed data

`data/seed.json` holds configuration only: the cost basis (placeholder ₱60.00 acquisition, ₱2.00 hauling), channel × product margins, buffers, the premium and discount catalogue, zones and users. User names are placeholders — edit them in Configuration → Users, or in the file and then Reset demo data.

`data/clients.mock.json` holds the made-up demo clients and competitor readings, loaded on top of the seed at start-up. Regenerate it with:

```bash
node tools/make-mock-clients.mjs
```

It writes 175 clients — **50 Bulk, 120 Commercial** and 5 named ones on the other channels — plus competitor readings, from a fixed random seed, so the same command always produces the same file. Roughly 12% of active clients sit below the floor and a tenth have no volume on record, so the exceptions panel and the "excluded from impact" count have something real to show. Delete the file and the app still runs, with no clients.

It also holds `settings` (VAT 12%, quote validity 7 days), per-channel `buffers`, `primarySkuId` on each client (used for exceptions and monthly impact), `trackedBrands` (drives the weekly competitor checklist), and empty `publications`, `proposals`, `quotes`, `priceRequests`, `acknowledgments`, `events` collections.

## Pricing rules

- Order: `(acq + hauling) + margin + premiums − discounts + buffer`, then VAT on the per-cylinder net.
- All money is integer centavos. Each ladder step rounds half-up (away from zero) to a whole centavo; per-cylinder and VAT round once each.
- On the placeholder figures, the 11 kg MGas dealer price comes to ₱880.00 per cylinder, net of VAT.
- An approved price request adds an "Approved price exception" discount for that customer and product for 7 days and allows sending below floor.

## Demo tools

Header buttons: **Reset demo data** (wipes localStorage, reloads the seed), **Export JSON** and **Import JSON** (hand a session to someone else).

## Port path

`engine.js` moves to `packages/pricing-engine`. `store.commit()` becomes API calls; the event object is the `event_log` row. Seed keys become tables; `effectiveFrom/effectiveTo` become `tstzrange` with an exclusion constraint. Money stays `bigint` centavos end to end.
