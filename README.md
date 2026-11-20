# Family Address Book

A small, private address book for a family. Everyone who is invited can keep postal
addresses in one place and print them as sticker labels for postcards (A4 sheets,
12 or 21 labels per sheet). It runs entirely on Cloudflare's free plan: static files plus a
few serverless functions plus a small SQLite database (Cloudflare D1). There is no build
step and nothing to install on a server.

## Features

- Login with email and password. Emails are not case sensitive.
- One **owner** (created on first login from two secrets you set) and any number of
  **members**.
- Any signed-in user can add a co-user: the server generates a 12-character password,
  shows it once, and the new user must choose their own password at first login.
- Owner-only: disable and re-enable a user, reset a user's password. Users are never
  deleted. A disabled user is locked out immediately, even if they are already signed in.
- Everyone sees all addresses and can add and edit any of them; only the owner can delete
  (a soft delete: the row is kept but hidden).
- Address fields: first name, surname, address lines 1 and 2, landmark, city, state, PIN
  (6 digits), phone (10 digits; `+91` or a leading `0` is removed on save), email
  (optional), group (for example Family or Friends), notes. Each entry shows who added it.
- Saving a phone number that already exists shows a warning with the existing entry; you
  can still choose "Save anyway".
- Search by name, surname, city, PIN or phone; filter by group.
- PDF sticker labels (A4; 21-up L7160 or several 12-up layouts, or a custom sheet): print
  everything in the current search/filter or only selected entries, optionally start at
  label N to reuse a partly used sheet, optionally include the phone number.
- CSV export of all addresses, for any signed-in user (also your backup, see below).
- Sign-in protection: after 5 failed attempts for an email within 15 minutes, further
  attempts for that email are refused until the window passes.

## Run it on your computer

You need Node.js 22 or newer (the test scripts use glob patterns that older versions
do not understand).

```sh
npm install

# 1. local secrets (this file is git-ignored; never commit it)
cp .dev.vars.example .dev.vars
#    open .dev.vars and set SESSION_SECRET (at least 32 characters, for example the
#    output of `openssl rand -base64 48`), OWNER_EMAIL and OWNER_PASSWORD

# 2. create the local database tables (applies all migrations)
npx wrangler d1 migrations apply family-address-book --local

# 3. start the app
npx wrangler pages dev public
```

Wrangler prints the address (normally `http://localhost:8788`). Log in with the
`OWNER_EMAIL` and `OWNER_PASSWORD` from `.dev.vars`; the owner account is created the
first time those credentials are used. Local data is kept under `.wrangler/` and can be
deleted at any time to start again.

The session cookie is marked `Secure`. Chrome and Firefox accept that on
`http://localhost`; some browsers (notably Safari) refuse it on plain http, in which case
login appears to succeed but you are sent back to the login page. Use Chrome or Firefox
for local work. The deployed site is https, so this does not affect it.

`npm run dev` starts the same server on port 8788.

## Tests

```sh
npm test            # unit tests: validation, password hashing, sessions, label maths
npm run test:e2e    # API tests against a real local wrangler server and a temporary database
npm run test:ui     # browser tests: the real front end driven in headless Chrome
```

- The end-to-end and UI tests start their own `wrangler pages dev` server (ports 8791 and
  8792) with a throwaway database in a temporary folder, and stop it afterwards. They do
  not touch your normal local data.
- They need a `.dev.vars` file. If there is none, the tests create one with throwaway
  values; an existing `.dev.vars` is never overwritten, and its owner credentials are the
  ones the tests use.
- The UI tests need Chrome or Chromium. They look in the usual places; set `CHROME_PATH`
  to point at a specific binary. All test data is fictional.
- `UI_SCREENSHOTS=/some/folder npm run test:ui` also saves screenshots of each view at
  360 px wide and a sample label PDF to that folder.

## Deploy to Cloudflare (first time, free personal account)

You will need: a free Cloudflare account, a GitHub account, and this project pushed to a
GitHub repository. Everything below stays within Cloudflare's free plan.

### 1. Sign in with Wrangler

```sh
npx wrangler login
```

A browser window opens so you can allow Wrangler to use your Cloudflare account.

### 2. Check the database

The database for this deployment already exists and its id is already in `wrangler.toml`.
First list the databases in your Cloudflare account:

```sh
npx wrangler d1 list
```

Check that a database named `family-address-book` is listed and that its id matches the
`database_id` in `wrangler.toml`. If so, there is nothing to create: go to the next step.

Only if you are deploying to a **different Cloudflare account** (so the database is not
listed), create one:

```sh
npx wrangler d1 create family-address-book
```

The command prints a `database_id` (a long identifier made of letters, digits and
dashes). Open `wrangler.toml`, paste the new id as the `database_id` value, then commit
and push the change. The id is not a secret, so it is fine to commit.

### 3. Create the tables in the live database

```sh
npx wrangler d1 migrations apply family-address-book --remote
```

This applies **all** migrations in `migrations/` that the live database does not have yet.
Answer yes when asked to confirm. These are the same migrations you ran locally, but this
command needs `--remote` to act on the real database. Run it again after pulling updates
that add new files to `migrations/`, and before (or together with) deploying the code
that needs them.

### 4. Create the Pages project

In the Cloudflare dashboard, go to the Workers & Pages area and create a new **Pages**
project by importing an existing Git repository. Connect your GitHub account, pick this
repository, and when asked for build settings use:

- Framework preset: none
- Build command: leave empty
- Build output directory: `public`

Save and deploy. The first deployment will work as a website but login will not work
until the next steps are done. Your site address will look like
`https://<project-name>.pages.dev`. Use `family-address-book` as the project name if you
want the commands below to work unchanged.

### 5. Check the database is attached

Because `wrangler.toml` is in the repository, Cloudflare reads the database binding from
it. In the project's settings, find the list of bindings (it may sit under the Functions
settings) and confirm there is a D1 database binding named exactly `DB` that points to
`family-address-book`. If it is missing, check that you pushed the `wrangler.toml` with
the real `database_id`, then redeploy. If your dashboard lets you add the binding by
hand instead, add a D1 binding with the variable name `DB` and select the database.

### 6. Set the three secrets

| Name | What to put |
| --- | --- |
| `SESSION_SECRET` | a random string of **at least 32 characters** (below) |
| `OWNER_EMAIL` | the email you will log in with as owner |
| `OWNER_PASSWORD` | a strong password you will use for the first login |

`SESSION_SECRET` must be at least 32 characters. If it is missing or shorter, the server
refuses to log anyone in or serve the API (it answers with a `server_misconfigured`
error). Generate a suitable value with either of these:

```sh
openssl rand -base64 48
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Set the three values as **encrypted** (secret) variables for the production environment
of the project, either in the project's settings in the dashboard (look for the variables
and secrets section and choose the encrypted type) or from your terminal:

```sh
npx wrangler pages secret put SESSION_SECRET --project-name family-address-book
npx wrangler pages secret put OWNER_EMAIL    --project-name family-address-book
npx wrangler pages secret put OWNER_PASSWORD --project-name family-address-book
```

Wrangler asks for each value; the value is not echoed. Keep `SESSION_SECRET` private and
do not change it later unless you want to sign everybody out.

### 7. Redeploy

Secrets only apply to deployments made after they were set. Trigger a new deployment:
in the project's deployments list, retry or redeploy the latest one, or push any small
commit to the repository.

### 8. First login

Open your `https://<project-name>.pages.dev` address and log in with `OWNER_EMAIL` and
`OWNER_PASSWORD`. The owner account is created at that moment. Use **More > Change password**
to change the owner password to one only you know.

After the first successful owner login you can delete the `OWNER_PASSWORD` secret (and
`OWNER_EMAIL`). They are only used to create the owner account, and that happens only
while no owner exists; once the owner row exists they are ignored for logging in.

There is no "forgot password" email. If a member forgets their password, the owner resets
it. There is no in-app way to recover the owner's own password, so keep it in a password
manager.

### First deployment check

Cloudflare's free plan gives each request only a small amount of CPU time (about 10 ms),
and password hashing is CPU-heavy. To fit, hashing is deliberately set to 10,000 PBKDF2
iterations (`PBKDF2_ITERATIONS` in `functions/_lib/crypto.js`). The count is stored with
each user's password hash (`users.password_iterations`), so it can be changed later without
locking anyone out.

Be aware that this is weaker against offline guessing than a higher count: if the database
were ever leaked, short or common passwords could be guessed quickly. That is why generated
passwords are long and random, and why members should keep long passwords (a few unrelated
words or a password-manager value, not a short or reused one).

After deploying, log in and change a password a few times, and watch for intermittent
failures such as "Error 1102" or "exceeded CPU". If you see them, tell the maintainer
before changing anything.

## Security notes

- **Ending sessions.** Disabling a user, resetting their password, or the user changing
  their own password ends all of that user's existing sessions at once. This also holds
  after a disabled user is enabled again: sessions from before the disable stay dead and
  the person must log in again. When a user changes their own password, the session they
  used stays signed in.
- **Lost or stolen phone.** Open **Users** and **Disable** that person (or **Reset
  password...**). Either one signs the phone out immediately. If you disabled them, press
  **Enable** afterwards and give them the new password if you also reset it.
- **Turn off preview deployments.** Preview deployments of a Pages project use the same
  `wrangler.toml`, so they would be bound to the same production database. In the project's
  build/branch settings, turn off preview deployments (or limit builds to the production
  branch only), so that only the production branch is deployed.
- **Browser security headers.** `public/_headers` sets a strict Content-Security-Policy,
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` on every page.

## Everyday use

### Adding people and passing on the password

Open **More > Users**, enter the person's name and email and press **Add user**. A box shows the
generated password **once**: copy it and send it to the person yourself (for example in a
private message). The app does not send email. When they first log in they are asked to
choose their own password before they can see anything else. Any signed-in user can add
co-users, not only the owner.

### Disabling a user (owner only)

Open **More > Users** and press **Disable** next to the person. They are locked out at once, even
if they are signed in on a phone. **Enable** restores access with their existing password, but they have to log in again:
sessions that existed before the disable do not come back.
**Reset password...** gives a new one-time password and forces a change at next login.
Users cannot be deleted, and the owner cannot be disabled.

### Printing labels

1. On **Addresses**, search or filter as needed, and tick the boxes of entries if you want
   to print only some of them. A bar at the bottom shows how many are selected; its
   **Print labels** button opens the Labels page.
2. Open **Labels**. Under **Label sheet** pick the sticker sheet you bought. It starts on
   12 per sheet, 2 x 6, 99.1 x 42.3 mm (L7177); the other choices are 21 per sheet
   (3 x 7, 63.5 x 38.1 mm, L7160), 12 per sheet 3 x 4 (63.5 x 72 mm, L7164), and three
   2 x 6 sheets of 105 x 48, 105 x 49.5 (edge to edge) and 100 x 44 mm. If yours is none of
   these, choose **Custom** and enter the columns, rows, label size, top and left margin and the
   gaps in millimetres; choosing Custom first fills the fields with the sheet you had selected, so
   you can nudge it by a millimetre. Sizes that do not fit on A4 are refused with a message. Your
   choice and custom sizes are remembered in this browser.
   Then choose "current search/filter" or "only selected addresses", set "Start
   at label" if the sheet is partly used (for example 4 to skip the first three labels; you
   can also tap the first empty label on the sheet picture, which shows where each label
   will go; the number is limited to the labels on the chosen sheet), and tick
   "Include phone number" if wanted.
3. Press **Download PDF**.
4. Open the PDF and print on **A4** label sheets. In the print dialog set scale to **100% /
   "Actual size"** and turn off **"Fit to page"** and any "shrink to printable area" option;
   otherwise the text will drift off the labels.

**Test print.** Tick **Draw label outlines (for a test print on plain paper)** and download the
PDF: a thin grey rectangle is drawn around every label slot of every page (empty ones too). Print
it on plain paper at 100% and hold it against a sticker sheet up to a window or lamp. If
everything is a little off in the same direction, use **Shift right (mm)** / **Shift down (mm)**
(each -5 to 5, decimals allowed, remembered in this browser) to move all labels and outlines
without changing the layout. Text starts 3 mm inside each label (4 mm on labels at least 90 mm
wide); on sheets with no margin at the paper edge, many printers cannot print that close to the
edge, so check the test print. Layout sizes come from the sheet makers' published figures or the
owner's measurements; always confirm with a test print.

Long lines wrap, and the text shrinks if an entry would not otherwise fit on a label.

### Excel export

**More > Export to Excel (.xlsx)** downloads every address as `addresses.xlsx`. On the Labels
page, **Export these addresses to Excel** exports exactly the set that would be printed (the
current search/filter or the selected addresses, file `addresses-selected.xlsx` for a subset).
The file is built in the browser (no server involved) by `public/xlsx.js`, a small writer with
a store-only ZIP container; there is no dependency. Columns: First name, Surname, Address
line 1, Address line 2, Landmark, City, State, PIN, Phone, Email, Group, Notes, Added by. Every
cell is text, so PIN and phone keep leading zeros and a value starting with `=` stays text
(Excel may show a "number stored as text" marker on PIN and phone, which is harmless).

### Backup

Use **Export CSV** in the **More** menu to download every (non-deleted) address as `addresses.csv`.
Do this now and then and keep the file somewhere safe. It opens in any spreadsheet (the file starts with a UTF-8 byte order mark so Excel shows
non-English letters correctly). Cells
that begin with `=`, `+`, `-` or `@` get a leading apostrophe so a spreadsheet will not
run them as formulas. The CSV contains addresses only: it does not contain user accounts
or passwords, and the app has no import feature, so it is a safety copy rather than a way
to restore the database automatically.

## Costs

Everything uses Cloudflare's free plan: Pages hosting, Pages Functions and D1. There are
no paid services and no external calls at runtime. A family-sized address book is far
below the free limits. If you ever want to check, Cloudflare's pricing and limits pages
for Pages, Workers and D1 have the current figures.

## Known limitations

- **Labels use a Latin-only font** (the standard Helvetica built into PDF). Names or
  addresses in other scripts (for example Devanagari or Kannada) will not print
  correctly; write them in English letters.
- **English only.** The interface has no translations.
- Phone numbers must be 10 digits (an Indian format) and PINs must be 6 digits.
- Sessions are signed cookies valid for 30 days. Logging out removes the cookie from that
  browser; to cut off a session that exists elsewhere, disable the user or reset their
  password (see Security notes). Session start times have one-second resolution, so a
  session created in the very same second as one of those actions is not cut off.
- One owner only; no user deletion; no password recovery by email; no CSV import.
- Soft-deleted addresses are hidden but remain in the database.

## Project layout

```
public/           static app (index.html, app.js, labels.js, xlsx.js, styles.css, _headers) and vendored jsPDF
functions/api/    Pages Functions (the JSON API)
functions/_lib/   shared auth, validation, crypto and HTTP helpers
migrations/       D1 SQL migrations
tests/            unit, e2e (API) and ui (browser) tests, plus tests/helpers
wrangler.toml     Pages config with the D1 binding
SPEC.md           the build specification
```
