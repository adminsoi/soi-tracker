# SOI Aviation — Department Task Tracker

A small internal Kanban tracker with real logins: each account belongs to
one department and only sees/edits that department's tasks. An
full-access account sees and can touch everything. Data is stored as JSON
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

## Layout (the "Daily Edit" look)

A left sidebar (Departments, Overview, Mentions you, Calendar, Global,
Pentagon), a company switcher (SOI · CAS · RedSun · Nano, plus All for
full-access accounts) and one tab per department. Every department is an
editable table; changes save to the server when you leave a field.

- **Procurement, Purchasing, Warehouse:** Task, Part number, Platform,
  Customer, Obsolete, Due date, Responsible, Done ✓ / ✗, Notes. Pentagon
  RFQs / Quotes / SOs / POs appear as rows too, and each Pentagon list is
  still there as its own view with date filters.
- **IT, Admin, HR, Business Development, US Government:** projects with sub-tasks
  (a sub-task is a task with `parentId`; deleting a project deletes its
  sub-tasks).
- **Accounting & Finance → Finance:** bank balances, daily payments
  (Approve moves a row to Approved to pay), expected receipts — stored per
  company in `finance.json` in the bucket. Only Accounting & Finance and
  full-access logins see it; only managers approve or tick paid / received.
  Nothing is connected to a bank.

## Calendar

The **Calendar** page (sidebar → Tools) has up to three tabs:

- **Personal calendar** (everyone) — the signed-in person's own Outlook events for the next
  1–4 weeks, read live from Microsoft 365. Read-only: the tracker never
  writes to anyone's calendar. It looks the mailbox up by the **email on
  that person's login** in `/admin.html` (never from the browser), so
  people only see their own calendar — make sure each login's email is
  their Microsoft 365 address.
- **HR global calendar** — Leadership only (tick **Leadership** on a login
  in `/admin.html`). Shown in the same **List** / **Month** views as the
  Personal calendar, read from the calendar's Outlook **ICS** feed. In Outlook
  on the web: Settings → Calendar → Shared calendars → Publish a calendar →
  choose **"Can view titles and locations"** (or all details; "busy only" has
  no names) → copy the **ICS** link into **HR global calendar** in
  `/admin.html`. The link stays on the server; browsers only get the events.
  It needs no Microsoft permission. (An HTML link can be set instead, in
  which case Outlook's own page is embedded.)
- **Who's in office** — Leadership only. One row per person, Mon–Fri, each
  day **In office**, **Out** or **Remote** (with times for part of a day).
  It reads only *Out of office* / *Working elsewhere* time from each
  person's own Outlook, plus HR calendar entries whose title names the
  person and says they're out or remote (e.g. "Greg – PTO", "Alexis WFH").
  Event titles and details never reach the browser. Add nicknames per login
  under **Names on the HR calendar**. Days use `OFFICE_TIMEZONE` (default
  Pacific Standard Time).

The Personal calendar can be shown as a **List** or a **Month** grid. The open Calendar tab quietly
re-checks every 3 minutes (and when you come back to the browser tab) and
redraws only if something changed, so new Outlook events appear on their
own. The server caches personal calendars for 2 minutes and the HR feed and
Who's in office for 5; Outlook also updates a published calendar's feed on
its own schedule, so HR entries can take a bit longer.

### One-time Microsoft 365 setup for the calendars

It uses the same app registration as assignment emails (`MS_TENANT_ID`,
`MS_CLIENT_ID`, `MS_CLIENT_SECRET`). A Microsoft 365 admin needs to:

1. Azure portal → **Microsoft Entra ID → App registrations** → open the app
   whose Application (client) ID is `MS_CLIENT_ID`.
2. **API permissions → Add a permission → Microsoft Graph → Application
   permissions → `Calendars.Read`** → Add.
3. Click **Grant admin consent** for the tenant.
4. Recommended: limit the app to SOI staff mailboxes instead of the whole
   tenant, using Exchange Online's RBAC for Applications (or the older
   Application Access Policy). If you do, include the `MS_FROM_EMAIL`
   mailbox so assignment emails keep working.

No redeploy is needed after consent; it can take a few minutes to apply.
Until then the page says the permission hasn't been granted yet.

## Default person per department

Under **Default person per department** in `/admin.html`, pick who new
tasks in each department go to when nobody else is chosen (for example IT →
Shreya, Admin → Melissa, HR → Alexis, Accounting & Finance → Mark, Business
Development → Ramin). This applies to everyone's new tasks, so a request
added in IT lands with IT; the person who added it can still edit it, and
only managers tick things off. A manager can still pick anyone.

## Business Development

"Operations" was renamed **Business Development**; logins, tasks and
per-department settings move over automatically the first time the new
version starts. Its tab has **Analytics** (SOI, Business Development and
full-access logins): RFQs, Quotes, Sales Orders and Purchase Orders over the
last 30 or 90 days — totals, weekly activity, top customers by sales order
value, and activity by person (Pentagon contact) — from the same Pentagon
queries as the department tabs. Its tasks are under **Projects**. If a
query's `TOP 200` limit is hit for the range, the page says so.

## Work inbox

**Work inbox** (sidebar → You) shows the signed-in person's own unread Outlook
mail from the last day / 3 days / week, one card per conversation, newest
first. There's no AI: each card shows Outlook's own preview text, and
conversations are sorted into **Needs you** (flagged, high importance, or
sent to you directly) and **FYI** (CC'd, group or list mail). **Done** is
remembered on that device and a conversation comes back if a newer message
arrives. It's read-only — replying happens in Outlook via **Open in Outlook**.
The mailbox is the email on the person's login; nothing is stored (results
are cached in memory for a minute).

One-time Microsoft 365 setup: add **Microsoft Graph → Application permission
→ `Mail.Read`** to the same app registration as the calendar, grant admin
consent, and (strongly recommended) limit it to SOI staff mailboxes with
Exchange Online RBAC for Applications. Until then the page says the
permission hasn't been granted.

## IT requests from the Microsoft Form

Each response to the IT request form becomes a task on the **IT** page,
assigned to the IT default person (see above), marked "From the IT form" with
who asked. Urgent requests come in as **high** priority. Everything the
person answered goes into the task's notes.

How it gets there: the server isn't reachable from Microsoft's cloud, so
the Power Automate flow can't send to it directly. Instead the flow emails
each response, and the tracker reads those emails every 3 minutes through
the same Microsoft app as the Work inbox (needs **`Mail.Read`**).

1. In the flow, after **Get response details**, add **Office 365 Outlook →
   Send an email (V2)**:
   - **To:** the mailbox in `IT_REQUESTS_MAILBOX`.
   - **Subject:** `[IT Request] ` followed by the issue answer. The tag must
     be spelled exactly like that.
   - **Body:** one `Label: value` per line, for example
     `Response ID: <Response Id>`, `Requested by: <Responders' Email>`,
     `Urgent: <answer>`, `Details: <answer>`. Response ID stops duplicates;
     `Urgent` set to Yes / Urgent / High makes the task high priority. Any
     other lines go into the notes too.
2. In Portainer, set `IT_REQUESTS_MAILBOX` on the stack and redeploy.

The emails stay in the mailbox untouched (an Outlook rule can file them in a
folder; every folder is read) and are left out of the Work inbox. Each
response is added once and only from the last two weeks; deleting the task
won't bring it back.

### Requests tab (history, priority, by person)

**IT → Requests** lists every form response: past ones imported once from
Excel, plus each new one the flow emails. It's visible to anyone with the IT
department (or full access); only managers change things.

- **Import past answers:** in Microsoft Forms open the form → **Responses →
  Open results in Excel**, download it, then click **Import from Excel** on
  the Requests tab. Imported requests start as **In progress**. Importing
  the same file again updates the answers and keeps your ratings and
  statuses.
- **Status tabs:** **New** (just came in through the flow), **In
  progress** and **Resolved**, plus All. Change one with its status menu,
  or tick several rows (or the header box for everything shown) and use
  **Mark as**. Resolved requests appear on the Resolved tab.
- **Duplicates:** when the same person sends something similar (or
  anything on the same day) within 7 days, the newer one says "Looks like a
  repeat" with **Mark duplicate** / **Not a duplicate**. Or tick several and
  **Merge as duplicates, keep newest / keep oldest**. On a duplicate, **Make
  this the main one** swaps it with its original (the others become its
  duplicates), **Undo** or its status menu takes it back out. Duplicates
  are closed, listed on their own **Duplicates** tab, and left out
  of the other tabs, the numbers, the charts and the Resolved notebook. The
  original shows "+N duplicates".
- **One person, any spelling:** "ELVIS", "elvis" and "Elvis Smith" are
  grouped as one person (same name ignoring capitals, or same email when
  the names agree; a first name alone joins the only full name that starts
  with it). Names show in normal capitals.
- **Internal priority:** managers rate each request **P1 Critical** (drop
  everything), **P2 High** (today), **P3 Normal** (this week) or **P4 Low**
  (when there's time). This is separate from the form's own urgency, which
  most people set to Immediate. On a request that's also an IT task, the
  rating sets the task's priority too (P1–P2 high, P3 medium, P4 low).
  Resolving the request ticks the task done, and ticking the task done
  resolves the request.
- **By person:** filter or sort by person, or click a name; the **By
  person** table shows requests, open, P1/P2 and last request for everyone.
- **Overview** shows requests per week (last 12 weeks) and open requests
  by priority, for IT and full-access logins.

The responses (names, emails, phone numbers) are stored in the tracker's S3
bucket as `it_requests.json`, never in this repo.

### Resolved tab (private IT notebook)

**IT → Resolved** is a private notebook, shown only to logins with
**Private IT notebook** ticked in `/admin.html`. Other managers and full-access
logins can't see or open it; the server checks the saved login on every
request.

- **Resolved tickets:** every request marked done on the Requests tab. Add
  a category, **what fixed it** and private notes. "Needs write-up" shows
  the ones you haven't written up yet.
- **Turn into article:** makes a knowledge base article from the ticket
  (problem, fix, notes) and links them.
- **Knowledge base:** your articles with a title, category and body. Read
  mode formats `# headings`, `- bullets` and `` `commands` ``. "Find an
  article" filters the list.

Everything saves as you type. It's stored in S3 as `it_notebook.json`.

## Finance from Pentagon

For SOI Aviation, the Finance view also fills in from three Pentagon queries
(defined in `pentagonViews.js` → `FINANCE_QUERIES`):

| Query | Fills | Columns it must return |
|---|---|---|
| `dashboards.ap_open` | Daily payments / Approved to pay | `BILL_NO`, `VENDOR`, `AMOUNT`, `DUE_DATE` (optional `PO_NO`) |
| `dashboards.ar_open` | Expected receipts | `INVOICE_NO`, `CUSTOMER`, `AMOUNT`, `DUE_DATE` (optional `SO_NO`) |
| `dashboards.bank_balances` | Bank accounts | `ACCOUNT_NAME`, `BALANCE`, `AS_OF` |

Amounts are read-only (they change in Pentagon). Approve, Paid, Received and
notes are kept in the tracker (`finance.json` → `pentagon`), keyed by
document number; approve / paid / received stay manager-only. A query that
doesn't exist yet just leaves its table to hand-entered rows, with a note.
These queries run only on the server, never from the browser.

## How access control works

- Every login belongs to one or more departments (or has full access, which
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

### RFQs, Sales Orders, Purchase Orders

Procurement → **RFQs** and Purchasing → **Sales Orders** / **Purchase
Orders** show Part number, Customer (Vendor on POs), Pentagon user, Due
date, Assigned to, Status (✓ / ✗) and Notes ("Show all Pentagon columns"
brings back everything). Each view's exact Pentagon field names are listed
in `PENTAGON_VIEWS` in `index.html`.

Pentagon is read-only from here, so Assigned to, ✓ / ✗ and notes are stored
by the tracker (`rfq_marks.json` in the bucket) and only managers can set
them. Whatever a manager assigns to someone shows up in that person's
**Mentions You** tab under "Assigned to you", and they get an email if
email is configured. Rows whose Pentagon user matches someone's Pentagon
code show up in their Mentions You as before.

### Pentagon rows on the board

Every row of the RFQ, Quote, Sales Order and Purchase Order queries also
appears as a card on its department's board (configured in
`pentagonViews.js`, `tasks: true`). Cards aren't copied into `tasks.json`;
the server builds them from the Pentagon rows (cached for a minute) plus
their marks, so a card's column and the table's ✓ / ✗ are the same thing.
A card's owner is whoever a manager assigned it to, or otherwise the login
whose Pentagon code matches the row's Pentagon user. Regular users only see
cards that are theirs.

Above the board, **Show:** filters by source (All · Tasks · RFQs · Quotes on
Procurement; Sales Orders · Purchase Orders on Purchasing), and managers can
pick one person.

### Team breakdown (Overview, managers only)

Tick **Show in team breakdown** on a login in `/admin.html` (and set their
Pentagon code). Managers then see, per person, their RFQs, Quotes and tasks
created (Procurement) and Sales Orders, Purchase Orders and tasks created
(Purchasing) on Overview. Pentagon counts cover what each query returns (by
default the last 14 days).

Anyone in Procurement or Purchasing can open their own department's lists.
The server only runs the dashboards' own Pentagon queries (listed in
`pentagonViews.js`, plus `dashboards.mine` for Mentions you, which always
uses the signed-in person's own Pentagon code); there's no free-form query
page. Each query receives `date_from`, `date_to`, `status` and `account_no`
(blank when not filtered) and a row limit.

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
