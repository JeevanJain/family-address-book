# Family Address Book — build spec

Private, family-only address book. Logged-in users keep postal addresses and
print them as PDF sticker labels for postcards. Must cost nothing to run.

## Stack (decided)

- Hosting: Cloudflare Pages (free plan). Static files in `public/`, no build step.
- API: Cloudflare Pages Functions in `functions/api/` (plain JavaScript, ES modules).
- Database: Cloudflare D1 (SQLite), binding name `DB`. Schema in `migrations/`.
- Front end: plain HTML + CSS + vanilla JS. No framework, no bundler, no CDN.
  Any third-party library is vendored into `public/vendor/`.
- PDF: generated in the browser with jsPDF (vendored). Excel: own minimal writer, no library.
- No Firebase, no paid service, no external API calls at runtime.
- English only. UI is deliberately plain and mobile-first; visual design comes later,
  so keep CSS small and in one file.

## Secrets / config (never committed)

- `SESSION_SECRET` — HMAC key for session cookies.
- `OWNER_EMAIL`, `OWNER_PASSWORD` — used once to create the owner account.
- Local development reads them from `.dev.vars` (git-ignored). Commit `.dev.vars.example`
  with placeholder values only. No real names, emails or addresses anywhere in the repo.

## Users and login

- Login is email + password. Emails are stored lower-cased and are unique.
- Table `users`: id, email, name, password_hash, password_salt, role (`owner` | `member`),
  disabled (0/1), must_change_password (0/1), created_by, created_at.
- Password hashing: PBKDF2-SHA256 via WebCrypto, 10,000 iterations (deliberately low: the free plan allows about 10 ms CPU per request), 16-byte random salt
  per user. Constant-time comparison.
- Owner bootstrap: on login, if no owner exists and the submitted email/password equal
  `OWNER_EMAIL`/`OWNER_PASSWORD`, create the owner row and log in. There is exactly one owner.
- Any logged-in user can add a co-user (name + email). The server generates the password
  (12 characters, unambiguous alphabet, `crypto.getRandomValues`) and returns it ONCE in the
  response so the creator can pass it on. New users have must_change_password = 1 and are
  asked to set their own password at first login.
- Any user can change their own password (current password required, minimum 8 characters).
- Owner only: disable / re-enable a user, reset a user's password (new generated password
  shown once). The owner cannot be disabled.
- Users are NEVER deleted. There is no delete-user endpoint.
- A disabled user cannot log in and existing sessions stop working immediately
  (check the user row on every request).
- Session: signed cookie (HMAC-SHA256 over user id + expiry), HttpOnly, Secure,
  SameSite=Lax, Path=/, 30 days. Logout clears it.
- Brute force: after 5 failed logins for an email within 15 minutes, refuse further
  attempts for that window (table `login_attempts`).
- Login errors must not reveal whether an email exists.

## Addresses

- Table `addresses`: id, first_name (required), surname, address_line1 (required),
  address_line2, landmark, city (required), state (required), pin (required, exactly 6 digits),
  phone (required; 10 digits, optional +91 / leading 0 stripped on save), email (optional,
  validated if present), group_name (optional free text, e.g. Family / Friends), notes,
  created_by, updated_by, created_at, updated_at, deleted_at.
- All logged-in users see all addresses, and can add and edit any of them.
- Delete is owner only, and is a soft delete (`deleted_at`).
- Saving an address whose phone already exists returns a warning with the existing entry;
  the client can resubmit with `confirm_duplicate: true`.
- List supports search over name, surname, city, pin, phone, and filter by group.
- Each entry shows who added it.
- CSV export of all (non-deleted) addresses for any logged-in user.
- Excel (.xlsx) export, built in the browser (`public/xlsx.js`, no server work): More menu
  (all addresses) and Labels view (the set that would be printed). Single sheet "Addresses",
  bold frozen header, all cells text.

## PDF labels

- A4 portrait. The sheet layout is chosen on the Labels view (default 12 per sheet, 2 x 6,
  99.1 x 42.3 mm, L7177). Presets (cols x rows, label mm, top / side margin, col gap, row gap
  in mm): 21-up 3 x 7 63.5 x 38.1 (L7160; 15.15 / 7.25 / 2.5 / 0); 12-up 2 x 6 99.1 x 42.3
  (L7177; 21.6 / 4.65 / 2.5 / 0); 12-up 3 x 4 63.5 x 72 (L7164; 4.5 / 7.25 / 2.5 / 0); 2 x 6
  105 x 48 (4.5 / 0 / 0 / 0); 2 x 6 105 x 49.5 edge to edge (0 / 0 / 0 / 0); 2 x 6 100 x 44
  (16.5 / 4 / 2 / 0). "Custom" takes the same eight numbers, validated to fit A4. The choice,
  custom values and the shift are remembered per browser (localStorage, optional).
- "Shift right / down (mm)" (-5..5) offsets all labels and outlines for printer correction.
- Optional "draw label outlines": thin light-grey rectangle around every slot, for a test print.
  Print at 100% / Actual size.
- Font: starts at 11 pt (L7160) growing with label height up to 14 pt, shrinking to fit;
  padding 3 mm, 4 mm on labels at least 90 mm wide.
- User chooses: everything in the current search/filter, or ticked entries.
- Optional "start at label N" (1 to the labels per sheet) so a partly used sheet can be reused.
- Label content: full name in bold, address lines, landmark, "City, State", then PIN on its
  own line in bold. Phone optional via a checkbox. Long lines wrap; text shrinks if needed
  so nothing is clipped.

## API (all JSON, under `/api`)

- `POST /api/login`, `POST /api/logout`, `GET /api/me`, `POST /api/password`
- `GET /api/users`, `POST /api/users`, `POST /api/users/:id/disable`,
  `POST /api/users/:id/enable`, `POST /api/users/:id/reset-password`
- `GET /api/addresses`, `POST /api/addresses`, `GET /api/addresses/:id`,
  `PUT /api/addresses/:id`, `DELETE /api/addresses/:id`
- `GET /api/export.csv`

Rules: every route except login requires a valid session (401 otherwise); owner-only routes
return 403 for members. Mutating requests must send `Content-Type: application/json` and an
`Origin` matching the host (CSRF defence). All SQL is parameterised. Validate on the server;
the client validates too but is not trusted.

## Front end

- Single page app in `public/` (index.html, app.js, styles.css). Views: login,
  change password, address list with search, add/edit form, label printing, users.
- Never insert user data with innerHTML; use textContent / DOM APIs.
- Works on a 360 px wide phone: large tap targets, single column, `inputmode` set on
  phone and PIN fields.

## Repo layout

```
public/            static app + vendor/jspdf
functions/api/     Pages Functions
functions/_lib/    shared auth, validation, db helpers
migrations/        D1 SQL migrations
tests/             automated tests
wrangler.toml      Pages config with D1 binding (database_id placeholder)
README.md          what it is, local run, deploy steps for Cloudflare, how to add users
```

## Testing

- Unit tests (node --test) for validation, password hashing, session signing, label layout maths.
- End-to-end API tests against `wrangler pages dev` with a local D1 database, covering every
  rule above, especially the permission rules and disabled users.
