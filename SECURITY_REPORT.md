# Security Assessment Report

## 1. Assessment Overview

**Application:** Nilavan Realtors / `lt-test-app`  
**Repository:** `navin-kumar10/lt-test-app`  
**Live URL:** https://nextjs.nkscloud.run.place  
**Assessment Phase:** Phase 3 — Security Vulnerability Assessment  
**Assessment status:** In progress — source-code findings established; live PoC evidence is being captured separately.

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

No destructive load test is required. Email-abuse testing will use a small controlled request set to demonstrate the weakness without unnecessarily consuming SendGrid quota.

---

# 2. Executive Summary

The production deployment controls implemented during Phase 1 and Phase 2 are substantially stronger than the original application-level security controls.

The source review identified the following confirmed application weaknesses:

| ID | Finding | Severity | Status |
|---|---|---|---|
| SEC-001 | Unrestricted public email-sending endpoint / missing rate limiting | High | Confirmed by source review; live PoC pending |
| SEC-002 | Missing server-side input validation | High | Confirmed by source review; live PoC pending |
| SEC-003 | HTML injection / malicious-link injection into business email | Medium | Confirmed by source review; live PoC pending |
| SEC-004 | Outdated/vulnerable Next.js dependency | Critical | Confirmed from installed version; complete npm audit mapping pending |
| SEC-005 | Missing application-level abuse controls | High | Confirmed by design/source review; overlaps SEC-001 |
| SEC-006 | Clickjacking protection | Informational / Pass if live headers match deployment evidence | Live verification required |

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

These controls should remain in place during Phase 4 remediation.

---

# 3. Finding SEC-001 — Unrestricted Email-Sending Endpoint

**Vulnerability Name:** Missing rate limiting / unrestricted email submission  
**OWASP Top 10:** A04 — Insecure Design  
**Severity:** High  
**Affected File:** `app/api/sendgrid/route.ts`  
**Affected Lines:** 4–40

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

Use a small controlled test:

```bash
for i in $(seq 1 10); do
  echo "Request $i"
  curl -sS -o /tmp/sendgrid-$i.out \
    -w "%{http_code} %{time_total}\\n" \
    -X POST \
    https://nextjs.nkscloud.run.place/api/sendgrid \
    -H "Content-Type: application/json" \
    -d '{
      "name":"Security Test",
      "email":"security-test@example.com",
      "phone":"0000000000",
      "message":"Controlled security assessment request"
    }'
done
```

### Expected vulnerable behavior

If the endpoint accepts the requests without throttling, repeated requests return successful responses and trigger repeated SendGrid operations.

### Evidence to capture

Record:

- HTTP status for each request
- SendGrid activity
- Number of emails received
- PM2 logs
- SendGrid quota/activity if available

**Live evidence status:** Pending execution from the assessment workstation because the assessment environment must originate the request from the user's live network.

## Recommended Fix

Implement server-side rate limiting before calling SendGrid.

For example, use a shared rate limiter such as Redis in production:

```text
Client
  |
  v
/api/sendgrid
  |
  +-- Validate request
  |
  +-- Rate limit
  |
  +-- CAPTCHA / bot control
  |
  +-- SendGrid
```

Return:

`429 Too Many Requests`

when the limit is exceeded.

A practical initial policy could be:

- 5 submissions / 10 minutes / IP
- additional email-based throttling
- CAPTCHA after repeated failures
- maximum request-body size
- structured logging

---

# 4. Finding SEC-002 — Missing Server-Side Input Validation

**Vulnerability Name:** Insufficient server-side input validation  
**OWASP Top 10:** A03 — Injection / A04 — Insecure Design  
**Severity:** High  
**Affected File:** `app/api/sendgrid/route.ts`  
**Affected Lines:** 6–7

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
curl -i -X POST \
  https://nextjs.nkscloud.run.place/api/sendgrid \
  -H "Content-Type: application/json" \
  -d '{
    "name":"<script>alert(1)</script>",
    "email":"not-an-email",
    "phone":"invalid",
    "message":"<a href="https://attacker.example">Click this link</a>"
  }'
```

The important test is whether the server rejects malformed values before invoking SendGrid.

## Recommended Fix

Use a server-side schema validator such as Zod:

```ts
const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().email().max(254),
  phone: z.string().trim().min(7).max(20),
  message: z.string().trim().min(1).max(2000),
});
```

Then validate before any external API call:

```ts
const parsed = contactSchema.safeParse(await req.json());

if (!parsed.success) {
  return NextResponse.json(
    { error: "Invalid request" },
    { status: 400 }
  );
}
```

---

# 5. Finding SEC-003 — HTML Injection in Business Email

**Vulnerability Name:** Email HTML injection / malicious-link injection  
**OWASP Top 10:** A03 — Injection  
**Severity:** Medium  
**Affected File:** `app/api/sendgrid/route.ts`  
**Affected Lines:** 27–31

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

Use a controlled URL owned by the assessment operator:

```bash
curl -X POST \
  https://nextjs.nkscloud.run.place/api/sendgrid \
  -H "Content-Type: application/json" \
  -d '{
    "name":"Security Test",
    "email":"security-test@example.com",
    "phone":"0000000000",
    "message":"<a href="https://example.com">Controlled security test link</a>"
  }'
```

Then inspect the received email.

### Vulnerable result

If the received email renders the supplied HTML as an actual hyperlink, the finding is confirmed.

### Safe result

The message should appear as literal text:

`<a href="https://example.com">Controlled security test link</a>`

rather than as a clickable HTML element.

## Recommended Fix

Escape user-controlled values before placing them in HTML.

Alternatively, use plain-text email content for user-controlled fields.

Preferred approach:

```ts
text: [
  `Name: ${name}`,
  `Email: ${email}`,
  `Phone: ${phone}`,
  `Message: ${message}`,
].join("\\n")
```

If HTML formatting is required, HTML-escape every untrusted field before interpolation.

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

This establishes that the current dependency tree contains known vulnerable packages.

Next.js 15.1.0 is also below multiple security-fixed versions.

In particular, Next.js 15.1.0 falls inside the affected range for the critical React Server Components RCE tracked as CVE-2025-55182; the patched 15.1.x version is 15.1.9. It is also below later security fixes for Server Components DoS and source-code exposure issues.

## Business Impact

Depending on the vulnerable component and reachable feature, exploitation may result in:

- remote code execution
- denial of service
- source-code disclosure
- application compromise
- server compromise

The exact exposure must be mapped to the application's enabled Next.js features before claiming that every advisory is directly exploitable.

## Evidence

`package.json` explicitly pins:

```json
"next": "15.1.0"
```

Installed dependency tree:

```text
next@15.1.0
react@18.3.1
react-dom@18.3.1
```

The dependency audit reports 21 vulnerabilities.

## Recommended Fix

Upgrade Next.js to the latest supported patched release on the 15.x maintenance line, or migrate to the currently supported major version after compatibility testing.

Do not use:

```bash
npm audit fix --force
```

blindly in production.

Instead:

1. Update the vulnerable dependency.
2. Regenerate the lockfile.
3. Run tests.
4. Run `npm audit`.
5. Build the application.
6. Deploy through CI/CD.
7. Re-test the application.

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

This does not prevent an attacker from bypassing the browser and sending direct HTTP requests.

The server does not implement an equivalent control.

## Business Impact

A script can bypass the UI entirely and repeatedly call the endpoint.

## Recommended Fix

Implement controls server-side:

- rate limiting
- schema validation
- request size limits
- CAPTCHA/bot protection
- duplicate submission detection
- logging
- alerting
- SendGrid quota monitoring

---

# 8. Clickjacking Assessment

**Scenario:** Attacker embeds the site inside a malicious iframe.

The deployment documentation states that Nginx configures:

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
```

This is the correct type of control for preventing arbitrary cross-origin framing.

## Live Verification

Run:

```bash
curl -sSI https://nextjs.nkscloud.run.place/ | \
grep -Ei 'x-frame-options|content-security-policy'
```

Expected:

```text
X-Frame-Options: SAMEORIGIN
```

If this header is present on the live response, clickjacking is considered **mitigated**.

A stronger modern policy can additionally use:

```text
Content-Security-Policy: frame-ancestors 'self';
```

---

# 9. Source-Code Exposure Assessment

## Scenario

"I want to access the full source code of the application from the browser without credentials."

The deployment explicitly blocks Git metadata:

```nginx
location ~ /\.git {
    deny all;
    return 404;
}
```

The deployment documentation records tests for:

```text
/.git/
/.git/config
/.git/HEAD
```

with 404 responses.

## Assessment

**Status:** Mitigated at the web-server layer, subject to live re-verification.

The public GitHub repository itself contains source code, so source availability through GitHub is not considered a production-server source-disclosure vulnerability for this assessment.

## Live Verification

```bash
for path in /.git/ /.git/config /.git/HEAD /.env /.env.local; do
  echo "=== $path ==="
  curl -sSI "https://nextjs.nkscloud.run.place$path" | head -n 1
done
```

No environment file or Git metadata should be publicly retrievable.

---

# 10. Secrets / Configuration Assessment

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

No hardcoded SendGrid API key was identified in the reviewed application source.

**Status:** Pass based on source review; secret-store configuration should still be verified on the EC2 host and GitHub repository.

---

# 11. Authentication / Authorization

The application is a public marketing/contact website and no authenticated user/admin API was identified in the reviewed route structure.

The contact endpoint intentionally does not require authentication.

Therefore, lack of authentication on `/api/sendgrid` is **not independently classified as a broken-authentication vulnerability**.

The security requirement is instead to protect the intentionally public endpoint from abuse.

**Status:** Not applicable as an authentication finding; abuse controls are covered by SEC-001 and SEC-005.

---

# 12. Server/Application Security Assessment

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
| .git blocking | PASS |
| Security headers | Configured; live verification required |

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

# 13. Endpoint Inventory

Current application API route identified:

```text
POST /api/sendgrid
```

No authentication/admin API routes were identified in the reviewed repository tree.

The primary security testing focus is therefore the public email endpoint and the Next.js application runtime.

---

# 14. Required Threat Scenarios

## Scenario 1 — Flood the business inbox

**Result:** Vulnerable by design/source review.

Attack:

```text
Internet
   |
   | repeated POST
   v
/api/sendgrid
   |
   v
SendGrid
   |
   v
Business inbox
```

Root cause:

- no rate limit
- no CAPTCHA
- no abuse detection
- no server-side submission quota

**Finding:** SEC-001 / SEC-005

---

## Scenario 2 — Inject malicious link into business email

**Result:** Vulnerable by source review; live email-rendering PoC pending.

Root cause:

```text
User input
   |
   v
HTML email template
   |
   v
SendGrid
   |
   v
Business mailbox
```

User-controlled values are interpolated directly into HTML.

**Finding:** SEC-003

---

## Scenario 3 — Obtain source code from browser

**Result:** Production Git exposure is mitigated by Nginx configuration.

Test:

```bash
curl -I https://nextjs.nkscloud.run.place/.git/HEAD
```

Expected:

```text
404
```

The GitHub repository is publicly accessible by design, so public repository visibility is not classified as a server-side source-disclosure finding.

---

## Scenario 4 — Clickjacking

**Result:** Expected to be mitigated by:

```text
X-Frame-Options: SAMEORIGIN
```

Live header verification remains required.

---

## Scenario 5 — Application running as root

**Result:** Mitigated.

The production deployment uses a dedicated non-root user.

If the application were root-owned/root-executed, successful application compromise would immediately provide a privileged execution context.

---

# 15. Remediation Priority

## P0 — Immediate

### Upgrade Next.js

Current:

```text
15.1.0
```

Move to a security-patched supported release and regenerate the lockfile.

## P1 — High

### Protect `/api/sendgrid`

Implement:

- rate limiting
- input validation
- body-size limit
- CAPTCHA/bot protection
- duplicate detection
- monitoring

## P1 — High

### Validate all input server-side

Use Zod or equivalent.

## P2 — Medium

### Prevent HTML injection

Escape untrusted values before placing them in HTML email.

Prefer plain-text user content where possible.

## P2 — Medium

### Strengthen browser security policy

Keep:

```text
X-Frame-Options: SAMEORIGIN
X-Content-Type-Options: nosniff
Referrer-Policy
Permissions-Policy
Strict-Transport-Security
```

and consider a CSP with `frame-ancestors 'self'`.

---

# 16. Phase 4 Retest Plan

After remediation, create:

```text
security-fixes
```

Then re-test:

### Rate limiting

```bash
# controlled requests
# expected result after threshold:
HTTP/2 429
```

### Input validation

Malformed requests should return:

```text
400 Bad Request
```

and must not invoke SendGrid.

### HTML injection

Injected HTML should appear as escaped text rather than executable/rendered markup.

### Dependencies

```bash
npm audit
```

Expected result:

```text
0 known vulnerabilities
```

or documented residual findings with justification.

### Headers

```bash
curl -sSI https://nextjs.nkscloud.run.place/
```

### Source exposure

```bash
curl -I https://nextjs.nkscloud.run.place/.git/HEAD
```

Expected:

```text
404
```

---

# 17. Evidence Still Required

The following live evidence should be captured from the assessment workstation/server:

- [ ] `npm audit --json` full dependency mapping
- [ ] Controlled 10-request email abuse PoC
- [ ] SendGrid/email evidence
- [ ] Malicious-link email PoC
- [ ] Security headers
- [ ] Clickjacking verification
- [ ] `.git` exposure verification
- [ ] `.env` exposure verification
- [ ] PM2 non-root verification
- [ ] UFW verification
- [ ] Nginx configuration
- [ ] HTTPS certificate
- [ ] Public HTTPS verification

---

# 18. Current Assessment Conclusion

The infrastructure deployment is reasonably hardened, but the application layer has important weaknesses around its public email endpoint.

The highest-priority application risks are:

1. **Unrestricted email sending**
2. **Missing server-side validation**
3. **HTML injection in outbound business email**
4. **Severely outdated Next.js dependency with known security vulnerabilities**

The Phase 4 objective is to remediate these issues without weakening the existing production controls, redeploy through the existing CI/CD pipeline, and demonstrate the fixes with repeatable PoCs.
