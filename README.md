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

## Tasks vs projects

Every department has two tabs:

- **Tasks** — quick, one-off items: a name, who's responsible, a due date,
  done and notes. Procurement, Purchasing and Warehouse keep their wider
  table (part number, aircraft, customer, obsolete) and the Pentagon rows.
- **Projects** — longer-term work, each with sub-tasks underneath
  (**+ Sub-task** on a project).

Existing rows stay where they were: Procurement / Purchasing / Warehouse rows
and IT form tickets are tasks, everything else was a project. New rows are
whichever tab you add them on.

**IT → Requests → + Add ticket** adds a ticket that didn't come through the
form (a call, a walk-up, a Teams message): who it's for, company, priority
and the issue. It starts as New, is marked "Added by hand", and goes on
IT → Tasks for the IT default person, like form tickets.

## Performance (Tools → Performance)

A quick-view tracker for HR's **Global Performance Management Escalation
Process**, for the CEO and Leadership. **PerformYard stays the system of
record.** Only logins with **Performance access** ticked in `/admin.html` can
see it (per HR: Greg, Alexis and Nyssa); the server checks every request.

- **People:** everyone with *Show in team breakdown*, plus anyone added —
  with a login, or without one by name / initials / employee ID and entity
  (SOI · California, CAS · New Zealand, Red Sun · Singapore, Nanotech · UK).
  *Show initials / IDs only* hides names on screen.
- **Notes:** date of incident, date received, from, a factual description,
  **employee was told** (and when), **entered in PerformYard**, and **serious
  misconduct** (handled under the separate process; never counted). A
  wording check flags opinion or emotive words (notes are discoverable).
- **What counts:** a note counts only if the employee was told, it isn't
  misconduct, the incident is within the rolling window, and it's after the
  last step.
- **Cards:** each person is a collapsible card (stage, countable notes, next
  step and flags on the closed card). Open it for a **description**, files,
  the step cards, notes and risk factors. Each step — verbal warning, written
  warning, PIP, PIP outcome review — is its own card: done steps have an
  editable description and **attachments** (e.g. the signed written
  warning); the next step has the form to record it, with attachments.
- **Ladder:** verbal warning → written warning → PIP → PIP outcome review.
  Enough countable notes makes a **review due** — a count is a guide, not a
  trigger. Steps are recorded by a person, only in order, with a date and
  reason; the latest can be undone (kept, with a reason). Termination is
  never a step: it always needs HR and legal review.
- **Risk factors** (protected leave, medical, complaints / whistleblowing,
  grievance, pregnancy / parental, length of service, pending claims): if
  any are ticked, a step can't be recorded until HR / legal review is
  confirmed.
- **Jurisdiction reminders** from HR's document show when recording a step
  (reminders, not legal advice).
- **Download record** prints a person's steps and notes (e.g. for an access
  request — Labor Code 1198.5, NZ Privacy Act, PDPA, UK GDPR).
- **Settings** in `/admin.html` → *Performance escalation*: months notes stay
  live (default 12), notes before a verbal review (3), and further notes
  before a written warning (2) and PIP (2). HR's numbers are placeholders.

Notes from the first version ("warnings") show as notes to check and don't
count until someone confirms the employee was told. Records are in S3 as
`performance.json`; attachments under `performance_files/`.

## SOPs (every department)

Each department has an **SOPs** tab, readable by everyone in that department
(managers add and change things):

- **Quick answers** — the "our manager is out, how do we…?" questions. Click
  a question to see the answer; *Find a question* filters them. Each can
  link to an SOP. **+ Add question**, or **Paste a list** in one go (each
  as `Q:` … `A:` …, or a question line ending in `?` with the answer
  underneath). An answer can be shown in **every department**.
- **SOP documents** — upload the PDFs (up to 20 MB each). The number, title
  and version come from the file name (`SOP-WH002_v01.pdf` → WH-002 ·
  Receiving · v01) and can be fixed in the table. An SOP can be shown in
  every department (e.g. CUST-001). **Open** shows the PDF in a new tab.

PDFs are stored privately in S3 under `sop_files/`, the rest in `sops.json`.
Nothing here uses AI.

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
- **Company colours** — on the HR calendar (List and Month), each entry
  about someone being away (OOO, PTO, WFH…) is coloured by that person's
  company, with a legend: names listed under SOI, CAS, Red Sun, Nanotech or
  **Global** (people who work across all four companies) under **HR
  calendar colours** in `/admin.html`, then logins by their own company,
  and everyone else SOI. An entry that names a company ("CAS
  CLOSED …") takes that company. **Holidays and closures** (public holiday,
  closed, Labour Day, Christmas, …) are striped and bold, and the day is
  tinted. A first name on two companies' lists stays uncoloured — use full
  names. Colours are set on the same admin card. On **Who's in office**,
  each person's initials (and a dot by their name in the week table) use
  their company's colour, with the same lists deciding the company.
- **Who's in office** — Leadership only. At the top, **Today** at a glance:
  everyone grouped into In the office / Remote / Part of the day / Out as
  name badges (pick another weekday to see that day). Below, one row per
  person, Mon–Fri, each
  day **In office**, **Out** or **Remote** (with times for part of a day).
  It reads only *Out of office* / *Working elsewhere* time from each
  person's own Outlook, plus HR calendar entries whose title names the
  person and says they're out or remote (e.g. "Greg – PTO", "Alexis WFH").
  Event titles and details never reach the browser. Add nicknames per login
  under **Names on the HR calendar**. People named on the HR calendar who
  don't have a login yet (for example on another Microsoft domain) still
  show, marked "From the HR calendar · no login yet": their name is taken
  from the entry title ("OOO - Maria Lopez", "Greg – PTO"), office closures
  and holidays are skipped, and days the HR calendar doesn't mention show
  "—" since there's no Outlook to check. Days use `OFFICE_TIMEZONE` (default
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

## Quarterly business review (Overview, Leadership)

The QBR slides as live numbers on the **Overview**, for leadership logins
(it includes customer and profit figures). Pick the quarter with ‹ ›.

| Panel | Numbers | Query (Transmute) — columns it returns |
|---|---|---|
| Procurement | Total quoted value, total orders won, quote-to-sale conversion, top customers (quoted vs. order value) | `dashboards.qbr_customers` — one row per customer: `CUSTOMER`, `QUOTED_VALUE`, `ORDER_VALUE` |
| Purchasing | Open POs, new POs issued, avg. PO cycle time, line items received with / without extension | `dashboards.qbr_purchasing` — one row: `OPEN_POS`, `NEW_POS`, `AVG_CYCLE_DAYS`, `RECEIVED_NO_EXT`, `RECEIVED_WITH_EXT` |
| Warehouse | Lines received, supplier on-time %, lines shipped, customer on-time %, rejections | `dashboards.qbr_warehouse` — one row: `LINES_RECEIVED`, `SUPPLIER_ON_TIME_PCT`, `LINES_SHIPPED`, `CUSTOMER_ON_TIME_PCT`, `REJECTIONS` |
| Rejections list | Part, customer / supplier, reason, date | `dashboards.qbr_rejections` — rows: `PART`, `PARTY`, `REASON`, `REJECT_DATE` |
| Target attainment | Procurement: orders won vs. target. Purchasing: gross profit vs. target | `dashboards.qbr_gross_profit` — one row: `GROSS_PROFIT` |

Every query gets `:date_from` and `:date_to` (the quarter's first and last
day). Columns a query doesn't return just show "No data yet". Any number can
be **typed in** for the quarter (marked "Typed in", with *use Pentagon* to go
back), and while there's no rejections query the list can be kept by hand.
Each panel has a notes box. The Warehouse panel is also on **Warehouse →
Insights** for everyone in the Warehouse department (warehouse figures only;
managers can type numbers in and keep the rejections list — the same data
as the Overview). Targets (quarterly and annual, for Procurement
sales orders and Purchasing gross profit) are set in `/admin.html` →
*Quarterly review targets*. Typed numbers and notes are in S3 as `qbr.json`.

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

**Shared inboxes:** in `/admin.html`, a login's **Extra inboxes** field
adds shared mailboxes (for example `it@` or `info@`), separated by commas and
on the same domain as their own email. Only an admin can set these. Work
inbox then shows tabs for **All inboxes**, **Mine** and each shared one, and
each card says which inbox it came from. If Mail.Read is limited to certain
mailboxes, add the shared ones to that policy too, or the page says it
can't read them.

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

The tracker lists the last two weeks of mail by date and matches subjects
starting with `[IT Request]` (or `IT Request` without brackets when the body
has a `Response ID:` line). It doesn't use Outlook search, which skips
common words like "it". Replies, forwards and Sent Items are ignored.
**IT → Requests** shows a status line (which mailbox, when it last
checked, how many form emails it found, or what went wrong) and a **Check
now** button for managers.

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
- **Resolve with a note and email:** marking a request **Resolved** (one at
  a time or in bulk) opens a short form: what the issue was (filled in from
  the request), what caused it, how you fixed it and anything they need to
  do. Only the fix really matters; the rest is optional. It's saved on the
  request and copied into the Resolved notebook's fix when that's empty. If
  the requester gave an email, tick **Email them** and the form turns into a
  formatted "Resolved: your IT request [Ticket IT-XXXXX]" email (there's a
  preview), asking them to reply if they still have the issue. It's sent from
  `MS_FROM_EMAIL` (needs Graph **Mail.Send**, application permission, with
  admin consent).
- **Replies show up on the ticket:** the email's Reply-To is you *and*
  `IT_REQUESTS_MAILBOX`. You get the reply in Outlook, and the tracker picks
  it up from the IT mailbox on its next check (every few minutes) by the
  ticket number in the subject. The reply shows on the ticket, and a banner
  on Requests says who replied, with **Reopen** (back to In progress) or
  **Keep resolved**.
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

- **KB numbers:** every article is numbered (KB-0001, KB-0002…; older
  articles were numbered oldest first). Type a number in "Find an article".
- **Photos and screenshots:** in Edit, **Add image**, paste a screenshot
  (⌘V) or drag a picture into the article (PNG, JPEG, GIF or WebP, up to
  8 MB). It's written as `![caption](kb-img:…)` and shows inline in Read;
  click to open full size. Stored privately in S3 under
  `it_notebook_images/`; only notebook logins can load them, and an
  article's images are removed when it's deleted.
- **✨ Suggest title:** writes a title from the Problem section (or the
  ticket's issue) with simple rules — "Fix: …" for something broken, "How
  to …" for a request. No AI and nothing leaves the server. Turning a
  ticket into an article uses it automatically.
- **Download PDF:** a clean print page (KB number, title, category, date,
  the article and its images); choose **Save as PDF** or print it.

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

## Dependencies

`package-lock.json` pins the exact version of every package, and the Docker
build installs exactly those (`npm ci`), so a broken new release of a
dependency can't break a redeploy. To update packages on purpose, run
`npm install` (or `npm update`) locally, check the app still works, and
commit the new `package-lock.json`.

## Local testing (optional, before you deploy)

```
cd server
npm install
JWT_SECRET=test ADMIN_PASSWORD=test S3_BUCKET=your-bucket AWS_REGION=us-east-1 node index.js
```

Needs valid AWS credentials available locally (e.g. via `aws configure` or
env vars) to reach S3. Then open `http://localhost:4000`.
