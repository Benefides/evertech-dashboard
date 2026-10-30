# Evertech Sales & CRM Dashboard

This is a web dashboard that runs outside Odoo. It reads live data from Evertech's Odoo through the **Odoo external API** (JSON-RPC) and shows sales, the CRM pipeline and AMC renewals in one place. Staff open it with a password. You can also put it on a meeting-room TV using a read-only link. It works without an Odoo login per viewer: a single Odoo user and API key reads the data.

```
Browser ──> this server (Node.js) ──JSON-RPC /jsonrpc──> Odoo (evertech.odoo.com)
              │  holds the API key, caches 10 min,
              └─ works out every number shown on screen
```

The API key stays on the server. The browser only receives the finished numbers.

## What's on it

The **period**, **compare** (previous period or same period last year), **company**, **sales team** and **salesperson** filters apply to everything. Your choices are saved in the address bar, so you can bookmark or share a view.

| Section | Shows |
|---|---|
| **Sales** | Sales (excl. tax) with change vs the comparison period and a 12-month sparkline; margin (amount and % of sales); sales, margin and orders **year to date** (1 Jan to the period end, vs the same dates last year); orders in the period; amount still to invoice. Margin is Odoo's order margin (sales price minus product cost) and needs the **Sales Margin** module (Sales → Settings → Margins). Below that: sales by month (tooltip shows the same month last year), top customers (with margin), and a salesperson table (sales, orders, won, win rate, pipeline, overdue activities). |
| **Sales details** | Click the Sales, Margin, Orders or any YTD tile. Opens a screen with the same filters: totals, sales by month, breakdowns by salesperson, customer and sales team, and every order behind the number (search, sort by any column, CSV, link to Odoo). Switch between the selected period and year to date; the browser's Back button returns to the dashboard. |
| **To invoice details** | Click the To invoice tile. Every confirmed order Odoo marks "To invoice" (any order date): SO number, order date, age, customer, salesperson, order total, already invoiced and still to invoice (untaxed, from the order lines), grouped by age, salesperson and customer. Click an order to see its lines: ordered, delivered, invoiced and to-invoice quantities. Search, sort, CSV. |
| **Target details** | Click **Details** on the Target card, or a salesperson's name. Every opportunity in the target: customer, salesperson, stage and probability, expected closing date, expected sales, status (won, open, past expected date, lost), created date and the sales orders made from it (SO number, date, amount). Filter by status, search by name or SO number, CSV. Deals won in the period but planned for another month are listed separately. |
| **Invoices & statements** | Posted customer invoices and credit notes not fully paid (as of today): outstanding, overdue, due in 30 days, by age and salesperson, every open invoice (INV No., date, order ref., product, outstanding, due date, days overdue). Per customer, **View** or **Print** a Statement of Account (letter, invoice table, total and overdue, ageing), or **Print all overdue** for one page per customer. Click **Edit** on the statement to change any text or untick invoices before printing (totals, ageing and the letter follow); use "Save as PDF" in the print window for a file. Needs the Odoo user to have Invoicing read access (e.g. "Billing"). Default texts: `SOA_COMPANY`, `SOA_GREETING`, `SOA_CLOSING`, `SOA_QUERY`, `SOA_SIGNATURE`, `SOA_EMAIL`. |
| **CRM** | Open pipeline (expected and weighted by probability); won value; win rate; average days to close; new leads; overdue activities. **Monthly target:** each month salespeople commit the opportunities they will close by setting the CRM **Expected Closing** date in that month. Target = expected sales of the opportunities whose Expected Closing date is in the period (won, lost or still open); won = opportunities won in the period; achievement = won ÷ target. Shown as target vs won per month, a period summary (still open, past date, lost) and a table per salesperson. A period running to today takes the target to the end of that month. Charts: pipeline by stage, won vs lost per month, lead sources, lost reasons. Tables: opportunities closing in the next 30 days and overdue activities, each linked to the record in Odoo. |
| **AMC renewals** | Expiry = order **creation date + 12 months**. Shows AMCs that expired and weren't renewed, those due in the next 30 and 31–60 days, and the contract value at stake. Each contract has a status. A contract counts as **Renewed** when a newer AMC order exists for the same customer. |
| **License renewals** | Microsoft, Fortinet and other vendor licenses sold on order lines. Expiry = order **confirmation date + term**. The term comes from the product ("1 Year", "36 Months", "annual", Fortinet SKU ending `-12`/`-36`/`-60`), otherwise 12 months. Same tiles and table as AMC, plus the vendor. A license counts as **Renewed** when a newer license order from the same vendor exists for the same customer. |

Every chart has a **Table** button. Customers, salespeople, pipeline and AMC have **CSV** downloads. There are light and dark themes, and it works on phones.

## Run it

```bash
npm install
npm run demo                 # sample data at http://localhost:3000, no Odoo needed
cp .env.example .env         # then fill in the ODOO_* values and DASHBOARD_PASSWORD
npm start
```

**Hosting on Render:** push this folder to a private GitHub repo, then in Render choose **New → Blueprint** and pick the repo. `render.yaml` sets everything up; Render asks for `ODOO_LOGIN`, `ODOO_API_KEY` and `DASHBOARD_PASSWORD`, and generates `SESSION_SECRET` and `TV_TOKEN`. Every push goes live automatically.

**Other hosts:** any small Node 22 host works: a VPS, Azure App Service or Railway. Serve it over HTTPS and set `COOKIE_SECURE=1` (and `TRUST_PROXY=1` behind the host's proxy). No database is needed.

## Connect to Odoo

1. **Choose the Odoo user.** Use an existing internal user, or a dedicated one such as "Dashboard API". That user needs read access to Sales and CRM, and access to every company you want to see.
   - With the **Sales: Administrator** or **Sales: User – All Documents** role, the dashboard shows everyone's numbers.
   - With **Own Documents Only**, it shows only that user's own data.
2. **Create the API key.** Sign in as that user, then go to **avatar → My Preferences / Preferences → Account Security → New API Key**. Copy it into `ODOO_API_KEY`.
3. **Check your plan.** On Odoo Online (odoo.com), the external API is only available on the **Custom** plan. Odoo.sh and self-hosted Odoo always have it.
4. **Fill in `.env`.**
   - `ODOO_URL`: `https://<your>.odoo.com`
   - `ODOO_DB`: the database name, shown in the URL of the database manager or under Settings → Developer tools.
   - `ODOO_LOGIN`: the user's login email.
5. **Mark the AMC orders.** Tag AMC sales orders with **AMC**, or make sure the product name contains "AMC" (e.g. "Network AMC (annual)"). You can change the keyword with `AMC_KEYWORD`.
6. **Check the license products.** A line counts as a license when its product or description names a vendor (`LICENSE_VENDORS`, default Microsoft and Fortinet) **and** looks like a license: license, subscription, annual, "1 Year", "36 Months", FortiCare/FortiGuard/UTP bundle, or a Fortinet SKU ending in `-12`/`-36`/`-60`. Hardware ("FortiGate 100F"), perpetual licenses and monthly subscriptions are left out. To add a vendor: `LICENSE_VENDORS=Microsoft=microsoft,m365,azure; Fortinet=fortinet,forti; Sophos=sophos; Veeam=veeam`.

## How it uses the Odoo API

It only **reads**. Every call goes through `POST {ODOO_URL}/jsonrpc`:

```json
{"jsonrpc":"2.0","method":"call","params":{
  "service":"object","method":"execute_kw",
  "args":["<db>", <uid>, "<api key>", "sale.order", "search_read",
          [[["date_order",">=","2025-01-01"]]],
          {"fields":["name","partner_id","amount_untaxed","state"],"limit":2000,"offset":0,
           "context":{"allowed_company_ids":[1,2]}}]}}
```

The `uid` comes from `common.login(db, login, api_key)`.

| Model | Used for | Filter (domain) |
|---|---|---|
| `res.users`, `res.company`, `res.currency` | Companies the user can see, home currency, exchange rates | – |
| `sale.order` | Sales, quotations, conversion, to invoice, AMC | created or ordered since 1 Jan last year / 25 months back |
| `sale.order.line` | Top products, AMC detection by product | lines of confirmed orders in that window |
| `crm.tag` | Order tags ("AMC") | ids from the orders |
| `crm.stage`, `crm.team` | Stage order, won stage, team filter | – |
| `crm.lead` (incl. archived) | Pipeline, won/lost, sources, lost reasons | created/closed in the window, or still open |
| `mail.activity` | Overdue CRM activities | `res_model = crm.lead` and past due |

The details:

- **Odoo versions.** It calls `fields_get` first and only asks for fields that exist, so the same code works on Odoo 16, 17, 18 and 19.
- **Pagination.** Records are read in pages of 2,000.
- **Currency.** Amounts are converted to the API user's company currency (AED) at Odoo's current rates. Sales is **untaxed**.
- **Won and lost.** A lead counts as won when it is in a stage marked "Is Won stage". It counts as lost when it is archived with 0% probability, which is how Odoo marks lost opportunities.
- **Caching.** Data is cached for `CACHE_MINUTES` (default 10). The Refresh button reloads it now. A TV screen reloads every 5 minutes.

## Its own API (if you want to reuse the numbers elsewhere)

All endpoints need a signed-in session.

- `GET /api/dashboard?from=2026-01-01&to=2026-10-20&compare=ly&company=1&team=2&user=11`: every KPI, chart and table as JSON.
- `GET /api/orders?...&range=period|ytd`, `GET /api/to-invoice?...`, `GET /api/target?...`, `GET /api/receivables?...`: the details screens as JSON.
- `GET /api/statement?partner=<id>`: one customer's statement of account.
- `GET /api/export/{orders|to-invoice|opportunities|target|receivables|amc|licenses|salespeople|customers|pipeline}.csv?...`: the same filters, as CSV.
- `GET /api/meta`: companies, teams, salespeople, data source and last refresh time.
- `POST /api/refresh`: reloads the data from Odoo.

## Files

```
src/odoo.js      JSON-RPC client: login, execute_kw, field detection, paging
src/data.js      what is fetched from Odoo and how it is normalised (+ cache)
src/metrics.js   every number on the screen, for a filter slice
src/demo.js      sample data (same shape) for DEMO=1
src/server.js    password / TV-link access, JSON + CSV endpoints
public/          the page (no build step); charts.js is a small SVG chart kit
```
