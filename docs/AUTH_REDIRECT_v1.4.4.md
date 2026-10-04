# v1.4.4 hotfix: email confirmation and password-reset redirects

## 1. Audit of v1.4.3 (code as shipped)

| Area | v1.4.3 behaviour (file) |
|---|---|
| Signup | `signUp()` in `web/cloud-sync.js` sends `POST {supabaseUrl}/auth/v1/signup` with body `{email, password}`. It sends **no `redirect_to`** query parameter. |
| Password reset | `requestPasswordReset()` sends `POST /auth/v1/recover?redirect_to=<location.origin + location.pathname>`. The value depends on the page the user happens to be on: `/Campaign-Hunter/` or `/Campaign-Hunter/index.html`. |
| Callback parsing | `consumeAuthRedirect(location.hash)` reads `#access_token=…&type=…`. It is called inside `initAccount()`. |
| Boot order | `app.js` calls `wireNav()` → `showRoute()` **before** `initAccount()`. `resolveRoute('#access_token=…')` treats the unknown hash as a route and `history.replaceState`s it to `#/hangi-kart`. |
| Error callbacks | `#error=…&error_code=otp_expired` (or the same parameters in the query string) were not handled. They were treated as an unknown route. |
| Base path | Nothing derived the app's base path. Assets, the service worker (`register('./sw.js')`, scope = app directory) and the manifest (`scope: "./"`) are all relative, so the app itself is base-path safe. |
| Service worker | It intercepts navigations only within its scope (`/Campaign-Hunter/`). It cannot affect `https://melihdelier.github.io/` (outside its scope), and it doesn't rewrite paths. Network-first, with the cached `index.html` as offline fallback. |
| Tests | The mock Supabase served the app at the **root** of a local server and ignored `redirect_to`. No test opened a callback URL. |

## 2. Root cause

1. **Signup didn't request a redirect.** Without `redirect_to`, Supabase builds the confirmation link's final redirect from the project's **Site URL**. The production link landed on `https://melihdelier.github.io/`, so the production Site URL is the GitHub Pages **account root** (origin only), not the project path. GitHub Pages has no site at the account root, which gives the 404. The account was still confirmed, because Supabase verifies the token *before* redirecting.
2. **A second latent defect, found while reproducing.** Even when the link does reach the app, v1.4.3 throws the session away: the hash router normalizes `#access_token=…` to `#/hangi-kart` before `consumeAuthRedirect` reads it. The user would land on the login screen instead of being signed in. Password-reset links had the same problem. They would also lose their target screen (Profil › Hesap) during the loading state, and from `/index.html` they requested a redirect URL that may not be on the allow-list.

Both defects were reproduced against the v1.4.3 code in the new browser test before the fix.

## 3. Fix (client only)

- **`getAuthRedirectUrl()`** (`web/cloud-sync.js`) is the single canonical app root. It is derived from the deployed module's own URL (`new URL('./', import.meta.url)`), not from the current page path, route or the GitHub username:

  | Deployment | Redirect target |
  |---|---|
  | GitHub Pages project | `https://melihdelier.github.io/Campaign-Hunter/` |
  | Local development | `http://localhost:8080/` (or `…/web/` in a subfolder) |
  | Future custom domain at root | `https://<domain>/` |
  | `file://` | undefined → Supabase Site URL fallback |

- **Signup and password reset** both send `?redirect_to=<getAuthRedirectUrl()>`. It is built in exactly one place (`withRedirect`).
- **`captureAuthCallback(location)`** runs at boot **before** the hash router. Then:
  - **Session tokens** (`type=signup|recovery|…`) are stored. The URL becomes `<base path>#/hangi-kart`, or `#/profil/hesap` for recovery. Tokens are removed from the address bar, and `/Campaign-Hunter/` is preserved.
  - **Error parameters** (hash or query, e.g. `otp_expired`) produce the login screen with a clear message: the link expired or was already used, the account may be confirmed, sign in. The parameters are removed from the URL.
  - **`?code=` / `?token_hash=`** (flows this client doesn't request) show "E-posta adresin doğrulandı. Devam etmek için giriş yap."
  - **Callback in an already-open tab** (a same-document hash change) is caught on `hashchange`, cleaned, and the page reloads, so the same boot path runs.
- **After confirmation:**
  - A completed profile opens **Hangi Kart?**, and onboarding is not reopened. The router's existing profile gate decides this.
  - A new account opens onboarding.
  - Recovery opens **Profil › Hesap**.
- **No change** to the database, RLS, profile schema, onboarding logic, eligibility, rewards, crawler or master data. **No migration.**

## 4. Supabase dashboard / email template

**No email-template change is required.** The default **Confirm signup** template links to `{{ .ConfirmationURL }}`. That points at `/auth/v1/verify?…&redirect_to=<redirect_to>`, which honours the `redirect_to` the client now sends. The default **Reset Password** template does the same.

**Check the template, without changing it unnecessarily.** Under Authentication → Emails → *Confirm signup*, the button or link must use `{{ .ConfirmationURL }}`. A customised template that links to `{{ .SiteURL }}` would ignore `redirect_to` and send users to the Site URL again. In that case, change the link back to `{{ .ConfirmationURL }}`. Alternatively, use a token-hash link such as `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email`, but this client then only shows "doğrulandı, giriş yap"; it does not verify the token hash itself.

**A URL-configuration change *is* required (dashboard, not code).** Under Authentication → URL Configuration:

- **Redirect URLs** must allow `https://melihdelier.github.io/Campaign-Hunter/`. If it isn't allow-listed, Supabase rejects `redirect_to` and falls back to the Site URL, and the 404 comes back. An entry such as `https://melihdelier.github.io/Campaign-Hunter/**` also covers future sub-paths. Add `http://localhost:*/**` only if you test locally against production.
- **Site URL**: recommended `https://melihdelier.github.io/Campaign-Hunter/` (currently, by the evidence above, `https://melihdelier.github.io`). This makes any request without `redirect_to`, for example from a still-cached v1.4.3 client, land on the app too.

## 5. Old clients

The service worker cache name changes (`bka-v1.4.4` plus the CI build id), and navigations are network-first. Open clients pick up v1.4.4 on the next load, and the existing `controllerchange` reload applies it. Until a v1.4.3 client updates, its signups still omit `redirect_to`. Setting the Site URL to the project path (above) covers that window.

## 6. Production acceptance after deploy (real Supabase + real mailbox)

These have **not** been performed. The tests use a mock Supabase and no email is sent.

1. Info shows `v1.4.4` and the new build id. Reload once if the old version is still shown.
2. Dashboard: confirm the Redirect URLs entry and, optionally, the Site URL above. The Confirm signup template uses `{{ .ConfirmationURL }}`.
3. New test mailbox → Hesap oluştur → the email arrives. Hover over or copy the link and check that it contains `redirect_to=https%3A%2F%2Fmelihdelier.github.io%2FCampaign-Hunter%2F`.
4. Tap the link (on phone and on desktop) → Campaign Hunter opens at `/Campaign-Hunter/#/kurulum` (onboarding), **signed in**, and the address bar shows no `access_token`. If the browser opens the link in a different app or browser, the login screen with "E-posta adresin doğrulandı…" or onboarding is acceptable. A 404 or blank page is not.
5. Tap the same link again → the login screen shows the "süresi dolmuş / daha önce kullanılmış" message. No 404, no loop.
6. An existing completed account → Şifremi unuttum → tap the link → Profil › Hesap with "Yeni şifreni bu ekrandan belirleyebilirsin.", signed in → set a new password → sign out and back in with it.
7. Re-check that the completed profile does not reopen onboarding after steps 4–6.
