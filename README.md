# SOI Aviation — Department Task Tracker

A small internal Kanban tracker with real logins: each account belongs to
one department and only sees/edits that department's tasks. An
`Operations` account sees and can touch everything. Data is stored as JSON
in an S3 bucket — no separate database container needed.

## What's here

```
server/       Express API (login, tasks, admin user management)
public/       Frontend — index.html (the tracker) and admin.html (manage logins)
Dockerfile    Builds one image that serves both the API and the frontend
docker-compose.yml   Stack file for Portainer
.env.example  Required environment variables
```

## 1. Set up the S3 bucket

Create (or pick) an S3 bucket and, if you want, a prefix/folder inside it
(defaults to `soi-tracker/`). The app will write two objects there:
`soi-tracker/users.json` and `soi-tracker/tasks.json`. They're created
automatically on first write — nothing to pre-populate.

**Permissions:** whatever runs this container needs `s3:GetObject` and
`s3:PutObject` on `arn:aws:s3:::YOUR_BUCKET/soi-tracker/*` (adjust the
prefix to match `S3_PREFIX`).

- **Recommended:** if the EC2 instance running Docker/Portainer already has
  an IAM role attached, just add that permission to the role's policy and
  leave `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` blank — the AWS SDK
  picks the role up automatically.
- **Otherwise:** create an IAM user scoped to just that bucket/prefix and
  put its access key + secret in the env vars.

## 2. HTTPS on an internal server

This server has no public IP, so a real (Let's Encrypt) certificate isn't
possible — Let's Encrypt has to reach your server over the public internet
to verify you own a domain, and here it can't. Instead, the included
`caddy` service uses Caddy's built-in **internal** CA to self-sign a
certificate for your server's private IP. This still encrypts traffic
between browsers and the server; the only difference from a "real" cert is
that each person's browser shows a one-time warning to click past on first
visit (their browser remembers the exception after that).

1. In **EC2 → Instances → your instance**, find **Private IPv4 addresses**.
2. Edit `Caddyfile` in this repo, replacing `10.0.0.0` with that exact IP.
3. That's it — no DNS record needed. Your team reaches the app at
   `https://<that-private-ip>`, either over VPN or directly when on the
   office network.

If you'd like a friendlier name later (e.g. `tracker.internal`) instead of
a raw IP, that's a small follow-up using an internal/private DNS zone —
not required to get this running today.

## 3. AWS security group

Since the server has no public IP, nobody on the open internet can reach
it regardless of these rules — but it's still good practice to scope
access to your own network rather than leaving it wide open to anything
that *can* route to this instance (other things in the VPC, etc).

On the EC2 instance's **Security** tab → click the security group →
**Edit inbound rules**:

| Type | Port | Source | Why |
|---|---|---|---|
| HTTPS | 443 | Your VPC's CIDR block (see **VPC → Your VPCs** for the exact range) | Covers VPN and office traffic routed into the VPC |
| SSH | 22 | My IP only | However you already access the server |

Leave your existing Portainer rule as-is. You do **not** need to open port
80 or port 4000 — 4000 is internal to the Docker network only.

## 4. Deploy the stack in Portainer (from GitHub)

1. Push this whole folder to a GitHub repo (see the walkthrough in chat
   for exact steps if you're doing this via GitHub Desktop).
2. In Portainer: **Stacks → Add stack → Repository**.
3. Paste your repo URL, branch (`main`), and Compose path
   (`docker-compose.yml`).
4. Under **Environment variables**, set:
   - `JWT_SECRET` — a long random string (`openssl rand -hex 32`)
   - `ADMIN_PASSWORD` — the password that gates `/admin.html`
   - `S3_BUCKET`, `S3_PREFIX`, `AWS_REGION`
   - `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` only if you're not using
     an attached IAM role
5. Deploy. Since this is a **public** repo, never commit real values for
   these — they only ever live in Portainer's environment variables field
   (that's exactly what `.gitignore` excluding `.env` protects against).

## 5. Create logins

Go to `https://<your-private-ip>/admin.html`, sign in with
`ADMIN_PASSWORD`, and add a username, password (8+ characters), and
department for each person. Each person then signs in at
`https://<your-private-ip>/` with that username and password (over VPN or
the office network — this server isn't reachable from outside either).

## How access control works

- Every login belongs to exactly one department (or `Operations`, which
  sees and can edit every department's board).
- The server enforces this on every request — `GET /api/tasks` only
  returns that department's tasks, and `PATCH`/`DELETE` reject anything
  outside it with a 403. A person can't get around this from the browser;
  it isn't just a UI filter like the earlier version.
- Sessions are JSON Web Tokens, valid for 12 hours, then you sign in again.

### Managers vs. everyone else

Tick **Manager** on a login in `/admin.html` (full-access logins are managers
automatically).

| | Manager | Everyone else |
|---|---|---|
| Sees | every task in their departments | only tasks assigned to them or that they created |
| Creates tasks | for anyone | for themselves only |
| Changes status (moves cards) | yes | **never** |
| Edits / deletes | any task in their departments | only tasks they created |
| Tasks a manager gave them | — | read-only |
| Ticks RFQs ✓ / ✗, edits RFQ notes | yes | read-only |

The server enforces all of this; the page just hides what you can't do.
Existing sessions pick up the Manager flag at their next sign-in.

### RFQs

Procurement → **RFQs** shows Part number, Customer, Person, Due date,
Status (✓ / ✗) and Notes, in that order ("Show all Pentagon columns" brings
back everything). Pentagon is read-only from here, so the ✓ / ✗ and notes
are stored by the tracker (`rfq_marks.json` in the bucket), keyed by RFQ
number.

### Claude

claude.ai can't be embedded inside another site, so the tracker links to it:
a **Claude** button in the top bar, and a **Claude project** button on each
department's tab once its link is saved under **Claude projects** in
`/admin.html` (only `https://claude.ai` links are accepted).

## Known limitations (fine for a small internal tool, worth knowing)

- **Single-container writes only.** The app serializes writes within one
  running process. If you ever scale this to more than one replica behind
  a load balancer, two replicas could race writing to the same S3 object.
  For one container (the normal Portainer setup) this isn't an issue.
- **No password reset self-service.** Only the admin page can set/reset
  passwords — there's no "forgot password" email flow. Fine for a handful
  of internal accounts; add one if this grows past that.
- **No audit log beyond `createdBy` on each task.** If you need a change
  history (who moved what, when), that'd be a follow-up addition.

## Local testing (optional, before you deploy)

```
cd server
npm install
JWT_SECRET=test ADMIN_PASSWORD=test S3_BUCKET=your-bucket AWS_REGION=us-east-1 node index.js
```

Needs valid AWS credentials available locally (e.g. via `aws configure` or
env vars) to reach S3. Then open `http://localhost:4000`.
