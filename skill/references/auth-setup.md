# Auth setup — strategy taxonomy + setup dialogue

How to get a part's authenticated routes to screenshot. Four strategies; pick
one per part with the decision tree, fill its config block, put any secret in
`.screenshots-auth/secrets.env` (never in the config), then verify.

## Decision tree

- **Login form you can script with test credentials** → `credentials`.
- **OAuth, magic-link, SSO, or any login you can't script** → `manual-session`
  (you log in once by hand; the session is saved and reused).
- **API key / basic / bearer token** (no interactive login) → `header`.
- **No login needed** → `none` (or omit the `auth` block).

## The auth probe (setup time, PLAN §6.3)

Run this per part **after its server is up**, before the auth Q&A, to decide
whether a wall exists and pre-fill the dialogue:

1. **Wall detection.** Headless-fetch `/` and one deep route. An auth wall is
   likely if any of: a redirect to a login-looking URL (`/login`, `/signin`,
   `/auth/…`); a rendered password field on the page; or an auth dependency in
   the app's `package.json` (`next-auth`, `@clerk/*`, `@auth0/*`, `lucia`,
   `firebase/auth`, or `supabase` auth usage).
2. **Field auto-detection** (for the `credentials` path). Navigate the sign-in
   URL headlessly and read the form: the username/email input, the password
   input (`input[type=password]`), and the submit control. These become
   `auth.fields`.
3. **`gateSignal` derivation.** Use the login URL observed during the probe as
   `gateSignal.urlMatching` (e.g. a bounce that lands on `/login`). At capture
   time a route whose final URL matches this is recorded **gated**, not failed.

Then run the Q&A: which strategy → sign-in URL → (credentials) confirm the
auto-detected selectors → ask for test credentials → write `secrets.env` →
verify by logging in and confirming you land on real content.

## Strategy: `none`

No login. Omit the `auth` block entirely, or:

```jsonc
"auth": { "strategy": "none" }
```

Nothing in `secrets.env`. All routes capture as public.

**Exception — a wall was detected but the user declined to set it up.** Do *not*
drop to a bare `none` block here. Without a `gateSignal`, `capture.mjs` can't tell
a gated route apart from a real page: it follows the redirect and silently
screenshots the *login page* under the gated route's name, recording it `ok`. That
violates the hard rule "unconfigured auth gate → flag the gated ones, never
silently drop." Keep the `gateSignal` you derived in the probe (and mark the
walled routes `auth: true`) so the bounce is caught and the route is recorded
**gated** with a `--login` remedy:

```jsonc
"auth": {
  "strategy": "none",
  "gateSignal": { "urlMatching": "/login" }   // bounce here → route recorded gated, not a bogus shot
}
```

## Strategy: `credentials` (scripted form login)

`capture.mjs` logs in once per part per run: opens `loginPath`, fills the fields
from env, submits, verifies `success`, and reuses the resulting session across
that part's viewports.

```jsonc
"auth": {
  "strategy": "credentials",
  "loginPath": "/login",
  "fields": {
    "username": "input[name=email]",
    "password": "input[type=password]",
    "submit": "button[type=submit]"
  },
  "env": { "username": "SR_WEB_USER", "password": "SR_WEB_PASSWORD" },
  "success": { "urlNotMatching": "/login" },
  "gateSignal": { "urlMatching": "/login" }
}
```

- **`secrets.env`:** the two env vars named in `env` —
  `SR_WEB_USER=...` and `SR_WEB_PASSWORD=...`.
- **`success`:** post-login check. `urlNotMatching` fails if you're still on the
  login path; `urlMatching` (also supported) requires the landing URL to contain
  a substring. Omit → the tool can't verify and assumes success.
- **Verification:** at setup, log in with the test creds and confirm you land on
  real content (not back on the login page).

## Strategy: `manual-session` (one-time headed login)

For OAuth / magic-link / SSO — anything you can't script. You log in by hand
once; the browser session is saved to
`.screenshots-auth/<part>.storageState.json` and reused.

```jsonc
"auth": {
  "strategy": "manual-session",
  "gateSignal": { "urlMatching": "/login" }
}
```

- **Setup:** run `node capture.mjs --login <part>` (the skill runs this itself,
  in the background). It opens a headed browser at the sign-in URL; the user
  completes the login there. With a `success`/`gateSignal` configured the script
  detects the logged-in page and finishes on its own; without one, closing the
  browser window saves the session. Either way the session is written to the
  state file (also used to refresh an expired one) — no terminal interaction.
- **`secrets.env`:** nothing (no scripted credentials).

## Strategy: `header` (inject a credential)

For API-key / basic / bearer auth — no interactive login. The value is read from
env and injected on every request.

```jsonc
"auth": {
  "strategy": "header",
  "inject": {
    "kind": "header",
    "name": "Authorization",
    "valueEnv": "SR_API_TOKEN",
    "format": "Bearer {value}"
  }
}
```

- **`inject.kind`:** `header` → sent as an HTTP header; `cookie` → set as a
  cookie on the part's host; `query` → appended to every navigated URL.
- **`inject.name`:** the header / cookie / query-param name.
- **`inject.valueEnv`:** env-var **name** holding the secret (never the value).
- **`inject.format`:** optional template; `{value}` is replaced with the env
  value (e.g. `"Bearer {value}"`). Omit → the raw value is used.
- **`secrets.env`:** the one env var named in `valueEnv`, e.g.
  `SR_API_TOKEN=...`.

## Failure modes

| Symptom | Cause | Remedy |
|---|---|---|
| `auth: true` routes show **gated** in the gallery with a 🔒 and `node capture.mjs --login <part>` | `manual-session` state file missing/expired, or `credentials` env vars unset | Run the `--login` command, or set the env vars in `secrets.env`. The run never fails — public routes still capture. |
| Setup login lands back on the login page | Wrong test credentials, or wrong field selectors | Re-ask credentials; re-check the auto-detected `fields`. |
| `header` route gated with "credential env … not set" | `valueEnv` var missing | Add it to `secrets.env`. |

Gated routes are always **flagged, never dropped** — they render as a full-width
row in the gallery with the reason and the remedy command, and still carry a
comment field.

## Invariants

- **Secrets never live in the config** — only env-var *names*. Actual values go
  in `.screenshots-auth/secrets.env`, which is gitignored.
- **`.screenshots-auth/` must stay gitignored.** The skill verifies the
  `.gitignore` line exists on every Capture run.
- An unconfigured auth wall never fails a run: public routes capture, gated ones
  are flagged with a remedy.
