# Stock Picker

Store owners swipe through your product catalog on their phone — "I stock this" / "I don't" —
and download an Amazon SmartBiz upload file containing only their items.

**One file in, one file out.** Everything else exists to produce that file.

---

## For the person running this (you)

### First-time setup — about 10 minutes, done once

You need a free Cloudflare account. No credit card, ever.

**1. Make a Cloudflare account**
Go to <https://dash.cloudflare.com/sign-up>, sign up with your email, verify it. That's all —
don't buy anything, don't add a card.

**2. Open a terminal in this folder and run these, one at a time:**

```bash
npm install          # downloads what the app needs (once)
npx wrangler login   # opens your browser — click "Allow"
npm run setup        # creates your database and file store
npm run deploy       # puts the app on the internet
```

The last command prints a link like `https://stock-picker.<your-name>.workers.dev`.
**That link is the app.** Send it to your store owners.

### Every day after that

| I want to… | Do this |
|---|---|
| Put a new/updated catalog online | Open the link, log in as `admin`, go to Admin, choose your Excel file. Shop owners' choices and price fixes are kept automatically; if the upload fails the previous list stays live |
| See who has done how much | Log in as `admin` — the progress table on the Admin screen shows stocked / not stocked / left / last active per shop |
| Download one shop's file yourself | Admin screen → that shop's row → File. It builds exactly the file that shop would get |
| Change the code and re-publish | `npm run deploy` |
| Add or change a user | `npm run user:add <username> <password>` then paste the printed line into `worker/users.ts` and run `npm run deploy` |

### Logins

Starter accounts. **Change these before giving the link to anyone**, using `npm run user:add`.

| Username | Password | Can do |
|---|---|---|
| `admin` | `admin123` | Upload catalogs, see everyone's progress, pick |
| `store1` | `store1pass` | Pick and download their own file |
| `store2` | `store2pass` | " |
| `store3` | `store3pass` | " |
| `store4` | `store4pass` | " |

Each person only ever sees their own choices. There is no way for one store owner to see or
overwrite another's.

---

## For a store owner (what to tell them)

1. Open the link. Log in with the username and password you were given.
2. You'll see how many items you stock, and a button to start or continue where you stopped. Tap it.
3. For each product: **✓ Stock it if you sell it, ✗ Don't stock if you don't.** You can swipe the card, or switch to List to tick many at once.
4. To find a product fast, use the search box on the first screen.
5. If our price or pack size is wrong for your shop, fix it right on the card: use the **− / +**
   buttons under the price and under the pack size — tap to nudge by one, hold one down to move
   faster, or drag the number left and right to slide it. Price can never go above MRP. For
   anything else, like the product name, tap **⋯** on the card. A changed product shows a
   "Changed" tag everywhere.
6. Got one wrong? Open **Review my list** (menu ⋯, or after finishing a category) and flip anything — any decision can be changed at any time.
7. Stop whenever you like. Close the browser, come back tomorrow — you carry on exactly where
   you stopped, even on a different phone.
8. When you're done, tap **Make my file**. When it is ready, **Share** it (for example to
   WhatsApp) or save it to your phone. Send that file as it is — **do not open it or change
   anything first.**

---

## What it costs

Nothing, and it is designed to stay that way rather than to be free until it gets used.

| Resource | Free allowance | What this app uses |
|---|---|---|
| Requests | 100,000/day | ~500/day |
| Database storage | 5 GB | under 10 MB |
| Database writes | 100,000/day | ~3,000/day |

The heavy work — reading your Excel file and building the download — happens **in the browser**,
not on the server. That is why it fits in the free tier with room to spare, and why there is no
loading spinner when someone opens the link.

---

## If something looks wrong

**"The download won't upload to SmartBiz."**
Don't open or re-save the file first — Excel can rewrite it on save. Upload it exactly as
downloaded. If it still fails, SmartBiz will name the column it dislikes; send that message on.

**"I uploaded a sheet and it was rejected."**
The app only accepts a real SmartBiz bulk-upload template: it must have the
`bulk_upload_template` sheet. Column A (SKU ID) is allowed to be blank — SmartBiz normally fills
that in itself once you upload to it, so the app quietly makes up its own internal ID for each
product instead, and nothing is lost. What it won't accept is two rows already carrying the
*same* SKU ID — the error message names the exact row.

**"Someone lost their progress."**
Unlikely — choices save to the server continuously, and the phone keeps its own copy too. Have
them log in again on any device; their work follows the login, not the phone. Any wrong choice
can be fixed from Review my list.

**Applying the price-fix update to an existing database.**
The per-shop price/name fixes need one new table. On an existing live database run once:
`npm run db:migrate` (local equivalent:
`npx wrangler d1 execute stock-picker-db --local --config wrangler.local.toml --file=./scripts/migrate-v2.sql`).
Fresh setups (`npm run setup` / `npm run db:local`) already include it via `schema.sql`.

**"Images aren't loading."**
The pictures come straight from Amazon's servers. If Amazon is slow, cards may briefly show a
placeholder. Choices still save normally.

---

## For a developer

```
web/src/xlsx.js     the Excel engine — parse + lossless export. Heavily tested; change with care.
web/src/            the phone UI (vanilla TS, no framework)
worker/             the Cloudflare Worker: auth, D1, KV. Thin by design (10 ms CPU budget).
scripts/verify-*    the test suites
SPEC.md             the frozen contract and full test plan
```

```bash
npm test                # Excel fidelity + independent openpyxl check + scale
npm run typecheck       # both tsconfigs
npm run dev             # UI on :5173  (run `npm run dev:api` alongside for the API)
npm run verify:api      # T-2 suite against a running Worker
npm run verify:catalog  # checks the QuickVerse catalog parses, SKUs stay stable across
                        # re-parses, and overridden exports stay byte-faithful
npm run seed:quickverse # uploads QuickVerse_Master_Catalog.xlsx to a local dev server
                        # (run `npm run dev:api` first)
```

**The one thing to understand before changing `xlsx.js`:** exports are lossless because chosen
rows keep their **original XML verbatim** and are spliced into an otherwise byte-identical copy
of the workbook. Nothing is re-encoded, so shared strings, styles, dropdowns and the sheet's
SHA-512 protection all survive. The only edit is a row's number. Rebuilding the workbook with a
spreadsheet library instead would quietly break the SmartBiz upload — see `SPEC.md` §4.2.
