# Security + DevOps Assessment — Deployment

## 1. Overview

I deployed the Next.js application on an Ubuntu server and configured it for production access using Nginx, HTTPS, PM2, and UFW.

The application runs under a dedicated non-root `deploy` user and listens only on localhost.

**Live URL:** https://nextjs.nkscloud.run.place

### Stack

* Ubuntu LTS
* Node.js 24.21.0
* NVM 0.40.3
* Next.js 15.1.0
* PM2 7.0.4
* Nginx 1.28.3
* Let's Encrypt / Certbot
* UFW
* Git / GitHub

---

## 2. Architecture

```text
                    INTERNET
                        |
                    HTTPS :443
                        |
                        v
                 +-------------+
                 |    Nginx    |
                 | Reverse Proxy
                 +-------------+
                        |
                 127.0.0.1:3000
                        |
                        v
                 +-------------+
                 |   Next.js   |
                 |     PM2     |
                 +-------------+

SSH :2222 -> deploy user

UFW:
2222 -> SSH
80   -> HTTP
443  -> HTTPS
3000 -> localhost only
```

The Next.js application is not directly exposed to the internet. Nginx is the only public web entry point.

---

## 3. Server & User

Application directory:

```text
/var/www/lt-test-app
```

Application user:

```text
deploy
```

The application runs as a non-root user.

Verified using:

```bash
whoami
id
ps aux | grep -E 'pm2|next|node'
```

---

## 4. SSH Hardening

SSH was configured with:

```text
Port: 2222
Root login: Disabled
Password authentication: Disabled
Public-key authentication: Enabled
```

Verified using:

```bash
sudo sshd -T | grep -E '^(port|passwordauthentication|permitrootlogin|pubkeyauthentication)'
sudo sshd -t
```

---

## 5. Firewall

UFW was enabled with a default-deny inbound policy.

Allowed ports:

```text
2222/tcp
80/tcp
443/tcp
```

Port `3000` was not opened publicly.

Verified using:

```bash
sudo ufw status verbose
```

---

## 6. Node.js & Application Deployment

Node.js was installed using NVM.

```text
Node.js: 24.21.0
npm:     11.19.0
NVM:     0.40.3
```

Dependencies were installed using:

```bash
cd /var/www/lt-test-app
npm ci
```

Production build:

```bash
npm run build
```

Dependency audit:

```bash
npm audit --omit=dev
```

---

## 7. PM2

The application is managed using PM2.

Start command:

```bash
pm2 start npm --name "lt-test-app" -- start
```

PM2 status:

```bash
pm2 status
```

Application process:

```text
lt-test-app -> online
```

PM2 startup was configured and the process list was saved:

```bash
pm2 save
```

A reboot test was also performed to confirm that the application starts automatically.

---

## 8. Application Binding

The Next.js production server runs on:

```text
127.0.0.1:3000
```

Production start command:

```bash
next start -H 127.0.0.1 -p 3000
```

Verified using:

```bash
sudo ss -tulpn
```

Port `3000` is therefore internal and is not publicly exposed.

Local health check:

```bash
curl -I http://127.0.0.1:3000
```

Result:

```text
HTTP/1.1 200 OK
```

---

## 9. Nginx Reverse Proxy

Nginx is used as the public reverse proxy.

Main configuration:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Nginx configuration was validated before reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## 10. HTTPS

Let's Encrypt was used for the application domain:

```text
nextjs.nkscloud.run.place
```

Certificate status:

```bash
sudo certbot certificates
```

Renewal was tested using:

```bash
sudo certbot renew --dry-run
```

The renewal test completed successfully.

---

## 11. HTTP → HTTPS

HTTP requests redirect to HTTPS.

Verified:

```bash
curl -I http://nextjs.nkscloud.run.place
```

Expected:

```text
HTTP/1.1 301 Moved Permanently
```

HTTPS:

```bash
curl -I https://nextjs.nkscloud.run.place
```

Result:

```text
HTTP/1.1 200 OK
```

---

## 12. Security Headers

The following security headers were configured at the Nginx layer:

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
add_header Strict-Transport-Security "max-age=31536000" always;
```

These were verified against the live HTTPS endpoint.

---

## 13. `.git` Protection

Git metadata was blocked at the Nginx layer:

```nginx
location ~ /\.git {
    deny all;
    return 404;
}
```

Tested against the live application:

```bash
curl -I https://nextjs.nkscloud.run.place/.git/
curl -I https://nextjs.nkscloud.run.place/.git/config
curl -I https://nextjs.nkscloud.run.place/.git/HEAD
```

All tested paths returned:

```text
HTTP/1.1 404 Not Found
```

---

## 14. Final Verification

### Application

```bash
curl -I http://127.0.0.1:3000
```

```text
200 OK
```

### HTTP

```bash
curl -I http://nextjs.nkscloud.run.place
```

```text
301 Moved Permanently
```

### HTTPS

```bash
curl -I https://nextjs.nkscloud.run.place
```

```text
200 OK
```

### Listening ports

```bash
sudo ss -tulpn
```

Expected:

```text
SSH       :2222
Nginx     :80
Nginx     :443
Next.js   127.0.0.1:3000
```

---

## 15. Assessment Evidence

Deployment evidence screenshots are attached inside the repository under:

```text
screenshots/
```

## Final State

```text
Internet
   |
   | HTTPS :443
   v
 Nginx
   |
   | 127.0.0.1:3000
   v
Next.js + PM2

SSH :2222 -> deploy

UFW:
2222 / 80 / 443 allowed
3000 not publicly exposed
```

**Live Application:**
https://nextjs.nkscloud.run.place

Deployment is complete. The application security findings and remediation are documented separately in `SECURITY_REPORT.md`.
