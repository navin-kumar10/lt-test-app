# Nilavan Realtors — lt-test-app

Marketing + contact site for Nilavan Realtors (Coimbatore), built with Next.js. Includes a contact form backed by a single API route that emails submissions to the business owner via SendGrid.

**Live:** https://nextjs.nkscloud.run.place

## Stack

- Next.js 15 + React 18 + TypeScript + Tailwind CSS
- SendGrid (`@sendgrid/mail`) for the contact form
- Production: Ubuntu (AWS EC2) + Nginx reverse proxy + PM2 + HTTPS (Let's Encrypt) + UFW
- CI/CD: GitHub Actions (`.github/workflows/deploy.yml`)

## Repo layout

```text
app/
  page.tsx                 # homepage
  api/sendgrid/route.ts    # contact-form endpoint (validated, rate-limited, escaped)
components/
  contact-section.tsx      # contact form (client)
  ...                      # page sections + shadcn/ui primitives
DEPLOYMENT.md              # server setup, every step documented
SECURITY_REPORT.md         # vulnerability findings, PoCs, fixes, retest evidence
PIPELINE.md                # CI/CD notes
screenshots/               # deployment evidence
```

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
npm run build && npm start   # production build
```

The contact endpoint needs SendGrid config to actually send mail:

```bash
SENDGRID_API_KEY=... SENDGRID_TO_EMAIL=... npm run dev
```

Without them it returns `503` (generic message, detail stays in server logs).

## API

`POST /api/sendgrid` — `{ name, email, phone, message }`

- Server-side zod validation (400 on bad input), 100/254/20/2000 char caps
- 5 requests/min/IP, then `429` + `Retry-After: 60`
- User input HTML-escaped before going into the owner email
- Malformed JSON → 400; all responses `Cache-Control: no-store`

See `SECURITY_REPORT.md` for the full assessment: findings SEC-001…008, reproduction commands, before/after behavior, and known limitations (in-memory limiter, `X-Forwarded-For` trust, no CSP yet).

## Branches

- `main` — production
- `security-fixes` — security remediation (merged to `main` via PR #1)
