# Security Assessment Report

## 1. Assessment Overview

**Application:** Nilavan Realtors / `lt-test-app`  
**Repository:** `navin-kumar10/lt-test-app`  
**Live URL:** https://nextjs.nkscloud.run.place  
**Assessment Phase:** Phase 3 — Security Vulnerability Assessment  
**Branch:** `security-fixes`  
**Assessment status:** Complete — findings remediated on `security-fixes`; every finding below has a local PoC plus retest evidence. Live-only re-verification (real SendGrid send, `/.git` re-check) is called out where it still applies.

Fix commits: `security: validate, escape, and rate-limit contact API; bump next and sendgrid client` followed by this report.

### Scope

The assessment covers:

- Next.js application source code
- `/api/sendgrid` contact endpoint
- Input validation and email handling
- Email abuse / SendGrid usage
- Source-code exposure
- Security headers / clickjacking
- Dependency security
- Secrets and configuration
- Production server/application security

### Methodology

The review uses:

- Manual source-code review
- Dependency audit using `npm audit`
- `curl`
- Browser/DevTools
- Nginx configuration review
- PM2/process review
- UFW/firewall review
- Controlled proof-of-concept requests

No destructive load test was required. Email-abuse testing used a small controlled request set (12 requests) against a local server with dummy SendGrid credentials, so no real emails were sent and no quota was consumed. Server logs confirmed each PoC reached the send stage, which is what separates an actual reproduction from a scanner claim.

Tools actually used: code review, `curl`, `npm audit`, `grep`, local Next.js dev/prod servers. Not used: Burp Suite, OWASP ZAP (the attack surface is a single JSON endpoint; curl covers it).

---

# 2. Executive Summary

The production deployment controls implemented during Phase 1 and Phase 2 are substantially stronger than the original application-level security controls.

The source review identified the following application weaknesses. All are now fixed on `security-fixes`:

| ID | Finding | Severity | Status |
|---|---|---|---|
| SEC-001 | Unrestricted public email-sending endpoint / missing rate limiting | High | Fixed — 429 verified |
| SEC-002 | Missing server-side input validation | High | Fixed — 400 verified |
| SEC-003 | HTML injection / malicious-link injection into business email | Medium | Fixed — escaping verified |
| SEC-004 | Outdated/vulnerable Next.js dependency | Critical | Fixed — 15.5.27, build green |
| SEC-005 | Missing application-level abuse controls | High | Fixed (rate limit + validation + size caps); CAPTCHA/logging noted as future layers |
| SEC-006 | Clickjacking protection | Informational | Mitigated at Nginx layer (`X-Frame-Options: SAMEORIGIN` observed once live) |
| SEC-007 | Backend config state disclosed via distinct 500 errors | Low | Fixed — generic 503 verified |
| SEC-008 | Malformed JSON returned 500; no request size limits | Medium | Fixed — 400 verified |

The production infrastructure already contains several positive controls:

- Non-root application user
- SSH key-only authentication
- Non-default SSH port
- UFW inbound filtering
- Nginx reverse proxy
- Next.js bound to localhost
- PM2 process management
- PM2 reboot persistence
- HTTPS
- HTTP-to-HTTPS redirect
- Nginx `.git` protection
- Security headers configured at the Nginx layer
- CI/CD deployment through GitHub Actions

These controls were left untouched during remediation.

---

# 3. Finding SEC-001 — Unrestricted Email-Sending Endpoint

**Vulnerability Name:** Missing rate limiting / unrestricted email submission  
**OWASP Top 10:** A04 — Insecure Design  
**Severity:** High  
**Affected File:** `app/api/sendgrid/route.ts`  
**Affected Lines:** 4–40 (pre-fix; no limiting code existed anywhere)

## Description

The contact form exposes a public POST endpoint:

`/api/sendgrid`

The route accepts a request and immediately calls SendGrid:

`await sendgrid.send(msg)`

There is no:

- IP-based rate limiting
- request throttling
- CAPTCHA/bot protection
- per-email quota
- abuse detection
- cooldown
- server-side submission limit

The endpoint therefore allows an unauthenticated internet user to repeatedly trigger outbound email operations.

## Business Impact

An attacker could:

1. Send repeated contact-form requests.
2. Trigger repeated SendGrid API calls.
3. Flood the business owner's mailbox.
4. Consume SendGrid quota.
5. Increase email-sending costs.
6. Damage the business's email reputation.
7. Use the legitimate business sender identity for spam delivery.

## Source Evidence

The handler parses the request and calls SendGrid without an abuse-control layer.

The critical flow is:

`await req.json()`  
→ build email  
→ `await sendgrid.send(msg)`

No request counter or rate limiter is present.

## Proof of Concept

The live 10-request loop from the initial draft was deliberately **not** run against production (it would send real emails / burn quota). It was run identically against a local server with dummy SendGrid credentials instead — same code path, zero production impact:

```bash
for i in $(seq 1 12); do curl -s -o /tmp/r.txt -w "%{http_code} " \
  -X POST http://127.0.0.1:3100/api/sendgrid \
  -H "Content-Type: application/json" \
  -d '{"name":"t","email":"t@t.com","phone":"0000000000","message":"spam"}'; done
```

### Observed vulnerable behavior

```text
500 500 500 500 500 500 500 500 500 500 500 500
```

All 12 processed, zero `429`s. (The 500s come from SendGrid rejecting the dummy API key with 401 — i.e. every request sailed through to the send stage. Server log confirmed `POST /api/sendgrid 500` per request.)

## Fix Applied (`security-fixes`)

In-memory fixed-window limiter in `app/api/sendgrid/route.ts:7-8,40-61`: 5 requests/minute/IP, keyed off `x-forwarded-for` first entry with `x-real-ip` fallback (`:21-29`). Over-limit responses:

```text
HTTP 429 {"error":"Too many requests. Please try again later."}
Retry-After: 60, Cache-Control: no-store
```

The original draft suggested 5 submissions / 10 minutes / IP plus CAPTCHA and email-based throttling. Implemented: 5/min/IP fixed window (contact forms legitimately get retried; a tighter window would annoy real users, a looser one wouldn't stop a script). CAPTCHA, duplicate detection, and quota monitoring are recommended follow-ups, not claimed as done.

Known limitation, stated openly: in-memory means per-process — correct for a single EC2 box, needs Redis/Upstash if the app ever scales out. `X-Forwarded-For` is client-influenceable; it is safe here because Nginx sits in front and appends the real IP, but the robust setup is `proxy_set_header X-Real-IP $remote_addr;` in Nginx with the app preferring that header.

## Retest After Fix (production build, `next start`, same 12-request shape)

```text
500 429 429 429 429 429 429 429   (first requests of the window, then blocked)
{"error":"Too many requests. Please try again later."}
```

**Status:** Fixed

---

# 4. Finding SEC-002 — Missing Server-Side Input Validation

**Vulnerability Name:** Insufficient server-side input validation  
**OWASP Top 10:** A03 — Injection / A04 — Insecure Design  
**Severity:** High  
**Affected File:** `app/api/sendgrid/route.ts`  
**Affected Lines:** 6–7 (pre-fix)

## Description

The API directly destructures user-controlled JSON:

```ts
const body = await req.json();
const { name, email, phone, message } = body;
```

No server-side schema validation is performed.

The application does not verify:

- that the request is an object
- required fields are present
- field types are strings
- maximum lengths
- email format
- phone format
- message size
- unexpected fields
- malicious HTML content

Client-side form controls do not provide sufficient protection because an attacker can directly call the API.

## Business Impact

An attacker can bypass the browser form completely and send arbitrary JSON directly to the endpoint.

This enables:

- oversized input
- malformed email addresses
- HTML injection
- spam content
- resource abuse
- downstream email abuse

## Proof of Concept

```bash
curl -X POST http://127.0.0.1:3100/api/sendgrid \
  -H "Content-Type: application/json" \
  -d '{"name":"x","email":"not-an-email","phone":"abc","message":"hi"}'
```

### Observed vulnerable behavior

```text
{"error":"Error sending email"}  HTTP 500
```

Garbage (`not-an-email`, `abc`) was processed exactly like valid input — the 500 came from the SendGrid 401 stage, proving there was no validation gate in front of it.

## Fix Applied (`security-fixes`)

Zod schema (`route.ts:14-19`; `zod` was already a dependency, no new packages):

```ts
const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(7).max(20),
  message: z.string().trim().min(1).max(2000),
});
```

Failures return `400 {"error":"Invalid contact form data"}` with `Cache-Control: no-store` (`:96-108`), before any SendGrid code runs.

## Retest After Fix

```bash
# same garbage payload:
{"error":"Invalid contact form data"}  HTTP 400
# 100 KB message body:
{"error":"Invalid contact form data"}  HTTP 400
```

**Status:** Fixed

---

# 5. Finding SEC-003 — HTML Injection in Business Email

**Vulnerability Name:** Email HTML injection / malicious-link injection  
**OWASP Top 10:** A03 — Injection  
**Severity:** Medium  
**Affected File:** `app/api/sendgrid/route.ts`  
**Affected Lines:** 27–31 pre-fix (`<p><strong>Name:</strong> ${name}</p>` etc.); fixed lines 132–135, 160–175

## Description

The application places untrusted fields directly into an HTML email:

```html
<p><strong>Name:</strong> ${name}</p>
<p><strong>Email:</strong> ${email}</p>
<p><strong>Phone:</strong> ${phone}</p>
<p><strong>Message:</strong> ${message}</p>
```

The user-controlled values are not HTML-escaped before being inserted into the `html` field.

Therefore, an attacker can submit HTML markup instead of plain text.

## Attack Scenario

An attacker submits:

```html
<a href="https://attacker.example">Verify your property account</a>
```

as the message.

The email is then constructed with the business's legitimate configured sender:

```ts
from: toEmail
```

This can make a malicious link appear inside a legitimate business email.

## Business Impact

An attacker could:

- place malicious links in business emails
- impersonate business messaging
- trick recipients into visiting attacker-controlled websites
- damage customer trust
- facilitate phishing/social engineering

This is especially significant because the message originates through the application's legitimate SendGrid integration.

## Proof of Concept

Pre-fix, the injection payload below was accepted and flowed to the send stage (SendGrid 401 in the test env), with the raw markup embedded in the `html:` body per source:

```bash
curl -X POST http://127.0.0.1:3100/api/sendgrid \
  -H "Content-Type: application/json" \
  -d '{"name":"<script>alert(1)</script>","email":"attacker@evil.example","phone":"0000000000","message":"Click <a href=\"https://evil.example/phish\">verify your plot booking</a>"}'
# accepted — reached send stage (HTTP 500 via dummy key, no 400)
```

### Vulnerable result

The supplied HTML would render as an actual hyperlink (and the script tag travels raw) in the owner's email. Whether `<script>` executes depends on the owner's mail client — link injection is the reliable impact, script execution is conditional.

### Safe result

The message should appear as literal text:

`<a href="https://example.com">Controlled security test link</a>`

rather than as a clickable HTML element.

## Fix Applied (`security-fixes`)

Every field passes through a 5-line `escapeHtml()` (`route.ts:31-39`) before HTML interpolation; newlines in the message become `<br />` after escaping. The plaintext `text:` version keeps raw values (safe in plaintext). Verified statically against the fixed file that the `html:` block interpolates only `safeName/safeEmail/safePhone/safeMessage`:

```text
interpolations inside html email body: ['safeName', 'safeEmail', 'safePhone', 'safeMessage']
```

A structurally-valid injection payload post-fix still passes validation (correct — it is well-formed input) but reaches SendGrid only in escaped form; end-to-end rendering was not observed because the test env has no real SendGrid key — stated, not fudged.

**Status:** Fixed

---

# 6. Finding SEC-004 — Vulnerable Next.js Version

**Vulnerability Name:** Outdated Next.js with known security vulnerabilities  
**OWASP Top 10:** A06 — Vulnerable and Outdated Components  
**Severity:** Critical  
**Affected File:** `package.json`  
**Affected Line:** 51

## Affected Version

```text
next: 15.1.0
```

The assessment workstation reported:

```text
21 vulnerabilities
3 moderate
16 high
2 critical
```

This establishes that the original dependency tree contains known vulnerable packages.

Next.js 15.1.0 is below multiple security-fixed versions. In particular, Next.js 15.1.0 falls inside the affected range for the critical React Server Components RCE tracked as CVE-2025-55182; the patched 15.1.x version is 15.1.9. It is also below later security fixes for Server Components DoS and source-code exposure issues.

## Business Impact

Depending on the vulnerable component and reachable feature, exploitation may result in:

- remote code execution
- denial of service
- source-code disclosure
- application compromise
- server compromise

The exact exposure must be mapped to the application's enabled Next.js features before claiming that every advisory is directly exploitable. Nuance recorded during remediation: the headline middleware auth-bypass class (CVE-2025-29927 family) needs middleware — this app has none — and the bundled `axios` 1.8.3 (via `@sendgrid/mail` 8.1.4) only ever calls `api.sendgrid.com` with a fixed URL, so its SSRF/DoS advisories are not reachable through this app. The upgrade below was done anyway: old is old, and the RSC-class issues do not need middleware.

## Evidence

`package.json` explicitly pins:

```json
"next": "15.1.0"
```

## Fix Applied (`security-fixes`)

```bash
npm install next@^15.5.27 @sendgrid/mail@^8.1.6   # no --force, no breaking majors
```

- `next` 15.1.0 → 15.5.27 (past all 15.1.x security patches including the CVE-2025-55182 fix line)
- `@sendgrid/mail` 8.1.4 → 8.1.6 (brings `axios` 1.20.0, clearing the axios advisory cluster)
- Lockfile regenerated; `npm run build` passes; `tsc --noEmit` clean.

Post-upgrade `npm audit --omit=dev`: 17 remaining (3 moderate, 14 high), all in build-time-only chains (tailwind/chokidar/brace-expansion, yaml, browserslist). Clearing those requires `npm audit fix --force` → tailwind 4.x, a breaking rewrite of the styling stack for findings that never touch the production runtime. Deliberately declined, documented here instead.

**Status:** Fixed where it matters (runtime); residual build-time findings accepted with reason.

---

# 7. Finding SEC-005 — Missing Application-Level Abuse Controls

**Vulnerability Name:** No anti-automation / abuse protection on contact form  
**OWASP Top 10:** A04 — Insecure Design  
**Severity:** High  
**Affected Files:**

- `components/contact-section.tsx`
- `app/api/sendgrid/route.ts`

## Description

The client submits directly to:

`POST /api/sendgrid`

The client contains only UI-level controls such as the disabled submit button while a request is in progress.

The server does not implement an equivalent control.

## Business Impact

A script can bypass the UI entirely and repeatedly call the endpoint.

## Fix Applied (`security-fixes`)

Server-side, in the route handler (the only place that counts):

- rate limiting (SEC-001)
- schema validation (SEC-002)
- request size limits via zod `.max()` caps (message ≤2000 chars)
- `Cache-Control: no-store` on all API responses

Not implemented and not claimed: CAPTCHA/bot protection, duplicate-submission detection, structured abuse logging/alerting, SendGrid quota monitoring. Those are the honest next layers (quota monitoring in particular, since it catches distributed abuse a per-IP limiter cannot).

**Status:** Fixed at the application layer; operational layers recommended.

---

# 8. Finding SEC-007 — Backend Config State Disclosed via 500 Errors (added during remediation)

**Severity:** Low — **Status:** Fixed  
**OWASP:** A05 Security Misconfiguration  
**Affected File:** `app/api/sendgrid/route.ts:12-20` (pre-fix)

Missing env vars produced distinct unauthenticated messages (`SendGrid API key not configured` vs `Recipient email not configured`), both HTTP 500 — telling a stranger which half of the email backend is misconfigured. Reproduced locally (no env vars → `{"error":"SendGrid API key not configured"}`, 500). Fixed to a single generic `503 {"error":"Email service is temporarily unavailable"}` with detail kept in server logs; retest confirmed the 503.

# 9. Finding SEC-008 — Malformed JSON Returned 500; No Size Limits (added during remediation)

**Severity:** Medium — **Status:** Fixed  
**OWASP:** A05 / A04  
**Affected File:** `app/api/sendgrid/route.ts` (pre-fix)

`await req.json()` threw on bad JSON into the generic catch → 500; a 100 KB message was accepted without any cap. Fixed: explicit `req.json()` try/catch → `400 Invalid JSON request body`; zod `.max()` caps → `400` on oversized bodies. Both retested green.

---

# 10. Clickjacking Assessment (was §8 / SEC-006)

**Scenario:** Attacker embeds the site inside a malicious iframe.

Nginx configures:

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
```

This is the correct type of control for preventing arbitrary cross-origin framing.

## Live Verification

One live GET succeeded before the host began resetting connections from the assessment IP, and its headers showed the proxy controls in place:

```text
X-Frame-Options: SAMEORIGIN
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Strict-Transport-Security: max-age=31536000
```

No `Content-Security-Policy` is set anywhere. Re-check with:

```bash
curl -sSI https://nextjs.nkscloud.run.place/ | \
grep -Ei 'x-frame-options|content-security-policy'
```

Expected `X-Frame-Options: SAMEORIGIN`. Clickjacking is **mitigated**; adding `Content-Security-Policy: frame-ancestors 'self';` is the recommended next step, not an emergency for a no-auth form site. The app itself sets no headers (no `next.config`, no middleware) — acceptable since Nginx owns that layer; headers were deliberately not duplicated in code.

---

# 11. Source-Code Exposure Assessment (was §9)

## Scenario

"I want to access the full source code of the application from the browser without credentials."

The deployment explicitly blocks Git metadata:

```nginx
location ~ /\.git {
    deny all;
    return 404;
}
```

The deployment documentation records 404s for `/.git/`, `/.git/config`, `/.git/HEAD`.

## Assessment

**Status:** Mitigated at the web-server layer, subject to live re-verification.

A live re-check was attempted (`GET /.git/HEAD`) but the host was resetting connections from the assessment IP by then (see §10), so testing was stopped rather than persisted with. Re-run from the reviewer's network:

```bash
for path in /.git/ /.git/config /.git/HEAD /.env /.env.local; do
  echo "=== $path ==="
  curl -sSI "https://nextjs.nkscloud.run.place$path" | head -n 1
done
```

No environment file or Git metadata should be publicly retrievable. The public GitHub repository itself contains source code, so GitHub visibility is not a production-server disclosure finding.

---

# 12. Secrets / Configuration Assessment (was §10)

## Positive Controls

The repository `.gitignore` excludes:

```text
.env
.env.*
!.env.example
```

The SendGrid API key is read from:

```text
process.env.SENDGRID_API_KEY
```

rather than being hardcoded into the application.

The deployment workflow uses GitHub Actions secrets for SSH configuration.

## Assessment

No hardcoded SendGrid API key was identified in the reviewed application source, and a scan of the full `security-fixes` diff for key patterns (`SG.*`, private-key headers, passwords) came back clean. Git history was checked for committed `SG.*` keys — none found. (Note: no `.env.example` exists in the repo; adding one documents required vars without leaking values.)

**Status:** Pass based on source review; secret-store configuration should still be verified on the EC2 host and GitHub repository.

---

# 13. Authentication / Authorization (was §11)

The application is a public marketing/contact website and no authenticated user/admin API was identified in the reviewed route structure.

The contact endpoint intentionally does not require authentication.

Therefore, lack of authentication on `/api/sendgrid` is **not independently classified as a broken-authentication vulnerability**.

The security requirement is instead to protect the intentionally public endpoint from abuse.

**Status:** Not applicable as an authentication finding; abuse controls are covered by SEC-001 and SEC-005.

---

# 14. Server/Application Security Assessment (was §12)

The deployment contains the following security controls:

| Control | Result |
|---|---|
| Non-root application user | PASS |
| SSH key-only authentication | PASS |
| Root SSH login disabled | PASS |
| Non-default SSH port | PASS |
| UFW | PASS |
| Public ports restricted | PASS |
| Next.js localhost binding | PASS |
| Nginx reverse proxy | PASS |
| HTTPS | PASS |
| HTTP → HTTPS | PASS |
| PM2 | PASS |
| PM2 reboot persistence | PASS |
| .git blocking | PASS (per deployment docs; live re-check pending, §11) |
| Security headers | Observed live once (§10); CSP still open |

## Root Privilege Scenario

If the Node.js process were running as root and an attacker achieved application-level code execution, the attacker would initially inherit root privileges.

That could allow:

- modification of application files
- access to protected files
- credential theft
- service modification
- persistence
- privilege escalation without needing a second local exploit

Running the application as the dedicated `deploy` user limits the initial privilege level.

Therefore the non-root deployment decision is a security control, not merely an operational preference.

---

# 15. Endpoint Inventory (was §13)

Current application API route identified:

```text
POST /api/sendgrid
```

No authentication/admin API routes were identified in the reviewed repository tree.

The primary security testing focus is therefore the public email endpoint and the Next.js application runtime.

Also verified during review: no middleware, no redirects, no query-parameter handling, no cookies/sessions, no file I/O, no database, no `eval`/child processes. The single `dangerouslySetInnerHTML` in the tree (`components/ui/chart.tsx:81`) renders only developer chart-theme colors — no user data, not a finding.

---

# 16. Required Threat Scenarios (was §14)

## Scenario 1 — Flood the business inbox

**Result:** Was vulnerable; **fixed and verified.**

```text
Internet
   |
   | repeated POST  →  5/min/IP, then 429 + Retry-After: 60
   v
/api/sendgrid
   |
   v
SendGrid → Business inbox
```

Retest: allowance then `429 {"error":"Too many requests..."}`. Distributed floods remain a job for upstream layers (Nginx `limit_req` / WAF / quota monitoring).

**Finding:** SEC-001 / SEC-005

---

## Scenario 2 — Inject malicious link into business email

**Result:** Was vulnerable; **fixed and verified** (with one stated caveat).

```text
User input → zod validation → escapeHtml → SendGrid → Business mailbox
```

Retest: garbage → 400; well-formed injection payload passes validation but only escaped values reach the HTML body (asserted in §5). Caveat: end-to-end email rendering not observed (no real SendGrid key in test env).

**Finding:** SEC-003 (gated by SEC-002)

---

## Scenario 3 — Obtain source code from browser

**Result:** No app-layer disclosure; Nginx `/.git` deny-block per deployment docs; **live re-verification still open** (§11).

The GitHub repository is publicly accessible by design, so public repository visibility is not classified as a server-side source-disclosure finding.

---

## Scenario 4 — Clickjacking

**Result:** Mitigated — `X-Frame-Options: SAMEORIGIN` observed on a live response (§10). CSP `frame-ancestors` recommended as hardening.

---

## Scenario 5 — Application running as root

**Result:** Mitigated by deployment (dedicated non-root `deploy` user). Compromise of the app process does not hand over uid-0. Verify on host with `ps -o user= -C node`.

---

# 17. Remediation Priority (was §15 — all items below are done)

## P0 — Immediate: Upgrade Next.js — DONE

15.1.0 → 15.5.27, lockfile regenerated, `npm run build` green, `tsc --noEmit` clean.

## P1 — High: Protect `/api/sendgrid` — DONE

Rate limiting, input validation, body-size limits implemented and retested. CAPTCHA/bot protection, duplicate detection, monitoring: recommended, not claimed.

## P1 — High: Validate all input server-side — DONE

Zod schema in the route handler; client validation left as UX only.

## P2 — Medium: Prevent HTML injection — DONE

Escaped values in HTML email; plaintext part unchanged.

## P2 — Medium: Strengthen browser security policy — PARTIAL

Existing headers kept (Nginx-owned). CSP with `frame-ancestors 'self'` still open — needs whoever holds SSH/Nginx access.

---

# 18. Phase 4 Retest Plan (was §16 — executed 2026-10-07, local prod build)

### Rate limiting

```text
burst → 500 (in-window) then 429 {"error":"Too many requests. Please try again later."} + Retry-After: 60
```

### Input validation

```text
garbage → 400 {"error":"Invalid contact form data"} — SendGrid never invoked
malformed JSON → 400 {"error":"Invalid JSON request body"}
100 KB body → 400
```

### HTML injection

Injected markup reaches only escaped interpolation (`safe*` vars asserted); renders as text, not markup. Live-render check needs a real key in staging.

### Dependencies

```bash
npm audit --omit=dev
```

```text
17 vulnerabilities (3 moderate, 14 high) — all build-time chains; runtime advisories cleared.
```

`--force` (tailwind 4.x) declined with reason in §6.

### Headers

Observed once live (§10). Post-deploy re-check:

```bash
curl -sSI https://nextjs.nkscloud.run.place/
```

### Source exposure

```bash
curl -I https://nextjs.nkscloud.run.place/.git/HEAD   # expect 404
```

Live re-check still open (connection resets from assessment IP; §11).

---

# 19. Evidence Still Required (was §17 — updated)

- [x] Controlled abuse PoC (12 requests, local, dummy key) — §3
- [x] Validation PoCs (garbage / malformed / oversized) — §4, §9
- [x] HTML-injection handling evidence (HTTP layer + static assertion) — §5
- [x] `npm audit` before/after mapping — §6
- [x] Security headers (one live observation) — §10
- [ ] Live `/.git` + `/` header re-verification from a clean network — §10, §11
- [ ] Real SendGrid email-render check in staging — §5
- [ ] PM2 non-root / UFW / Nginx config host verification — §14 (docs-based)
- [ ] HTTPS certificate / public-URL checks — deployment evidence already in `screenshots/`

---

# 20. Assessment Conclusion (was §18)

The infrastructure deployment was already reasonably hardened; the application layer had real, demonstrated weaknesses around its public email endpoint. All of them are now fixed on `security-fixes` with before/after evidence:

1. **Unrestricted email sending** → 5/min/IP with 429 (verified)
2. **Missing server-side validation** → zod gate with 400 (verified)
3. **HTML injection in outbound business email** → escaped interpolation (verified at HTTP + source level)
4. **Outdated Next.js with known vulnerabilities** → 15.5.27, build green (verified)

Residual, openly documented: in-memory limiter (single-instance OK), `X-Forwarded-For` trust (fine behind this Nginx; prefer `X-Real-IP`), no CSP yet, no CAPTCHA/quota monitoring, build-time-only audit leftovers, and the live re-checks above. Redeploy through the existing CI/CD pipeline whenever ready — `npm run build` passes, normal form submits are unaffected.

---

# Appendix A — Verification Log (remediation session, 2026-10-07)

```bash
git checkout -b security-fixes        # from pre-fix state
npm run dev -- -p 3101                # local repro server (dummy SENDGRID_*; nothing real sent)
# PoCs: baseline, invalid email, <script>/<a href> injection, malformed JSON,
#       100 KB body, 12-request burst, no-env config disclosure
npm install next@^15.5.27 @sendgrid/mail@^8.1.6
npm run build                          # ✓ Compiled successfully, types + lint checks pass
npx tsc --noEmit                       # exit 0
npm run start -- -p 3103               # retest against production build
# Retests: 400s, 429s, 503 as documented above
npm audit --omit=dev                   # 17 residual, build-time only
git diff | grep -iE 'SG\.|PRIVATE|password'  # no secrets (excluding env-var names)
```

Test-env notes: `node_modules` initially disagreed with the lockfile, so packages were reinstalled and the lockfile regenerated — tests ran on exactly what is committed. Dummy key used throughout was the literal string `SG.dummy-key-for-local-repro`, never a real credential. `npm run lint` is unconfigured in this repo (Next 15 prompts for fresh ESLint setup) and was left alone rather than scaffolding new tooling in a security branch.
