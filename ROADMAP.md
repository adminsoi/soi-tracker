# Dashboard redesign — roadmap

The agreed plan for the redesign, phase by phase. Each phase is meant to be
built in its own Claude Code session: start the session by reading this
file and only the code files that phase touches. Tick a phase off here when
it's merged and redeployed.

## Decisions so far

- **Sidebar order:** Operations, Administration · Overview · Mentions of You,
  Emails · Strategy Meeting · SOP · People · Documents · Department Chat ·
  then Calendar and Global at the bottom. Pentagon leaves the sidebar (its
  data still feeds the boards).
- **Operations** (was "Departments"): the combined Kanban board
  (Procurement + Purchasing + Warehouse), Business Development, US Gov.
  BD and US Gov lose their Tasks and SOP tabs; US Gov gets its own Kanban.
- **Administration:** IT, Admin, HR, Finance, each with **Staff-Facing** and
  **Department-Facing** sub-tabs. No SOP tabs, no Projects/Tasks split.
  - IT — Staff: ticket form → Department: Requests (first), Projects.
  - Admin — Staff: admin request form → Department: Projects.
  - HR — Staff: HR issue, leave request, performance comment →
    Department: Projects (ongoing "HR issues" and "Performance comments"
    projects collect the submissions as tasks), Payroll, Performance (the
    existing Tools → Performance tracker moves here).
  - Finance — Staff: reimbursement request → Department: Approvals
    (everything above "Approved to pay") and Transfers ("Approved to pay"
    and below). Every table gets per-column filters.
- **Kanban files** come in automatically from Pentagon (RFQ → Quote → SO →
  PO), with **+ Add file** by hand too. Columns: RFQ, Quoted (blue) · Sale
  Received, Purchased (indigo) · Item Received, Item Sent (violet).
  Departments are told apart by colour.
  - File heading: file number, platform(s), customer, Highlighted Items
    checkbox, due date, responsible person, on-time ✓ / ✗; adds the Sales
    Order number from Sale Received on. Heading refreshes on every move.
  - Line items are rows under the heading, each with a **Flag** at the start.
    Filters on every heading field plus flagged / unflagged; search covers
    headings, line items, notes and attachment names.
  - **Highlighted item** = a part that can't be found online (Google, ILS,
    PartsBase, Locatory). Ticked by hand on the line item; the file heading
    box is ticked when any line item is.
  - Clicking a line item opens a side panel: the file's documents (PDF,
    images, other files) and text notes. Managers add feedback and next
    steps with deadlines, which show on the assignee's Mentions of You.
  - Attachments are stored in S3 in a folder per file, also browsable from
    Documents.
- **Overview → Team breakdown:** remove Cullan, Lamar, Dina, Vicky and Renz
  from Procurement; remove Lamar and Renz from Purchasing and add Elvis
  (needs a login with his Pentagon code — check whether one exists).
- **People** and **spot bonuses:** Leadership only, enforced on the server.
  A spot bonus adds $100 to the person's next payroll in one click.
- **Department Chat:** one chat for the whole company (not one per
  department), backed by Claude and reading the S3 document folders.
  Waiting on compliance sign-off — see below.

## Open items

- **Compliance sign-off before Phases 8 and 9.** SOI policy keeps government
  client information, contract details and supplier pricing out of AI
  prompts; email drafting and the chat would send exactly that. Needs the
  administrator / compliance lead's decision (e.g. Claude through SOI's own
  AWS account via Bedrock, or limiting what the chat can read).
- **Payroll rules from HR:** how each kind of leave reduces weekly pay, per
  entity (US, NZ, Singapore, UK). A qualified person checks the numbers
  before any real payroll is sent. Phase 4 left a "Leave rules" box per
  entity on HR → Payroll for HR to fill in; nothing applies them yet.
- **Mail.Send** for each person's mailbox (Microsoft 365 admin) before
  email replies can be sent as that person.
- **Staging stack** `soi-tracker-staging` (port 8443, `staging` branch,
  S3 prefix `soi-tracker/staging` reading live data through
  `SEED_FROM_PREFIX`; README §4). Every phase goes to the `staging`
  branch and is tested there before `main`. To use `soi-tracker-staging/`
  instead, the host's AWS role `EC2S3AccessRole` needs write access to it.
- **Push access** to GitHub from the machine doing the work.
- The repo is **public**; consider making it private.

## Already built (commits #64–#70, 30 Oct 2026)

An earlier session built parts of this from the "AOG CRM spec" — see the
README's *Navigation* and *Operations board* sections. Build on it
rather than starting over:

- Sidebar: **Departments** and **Administration** (IT, Admin, HR, Finance);
  Overview, Calendar, Performance, Global and a **Master Chat** placeholder
  under Tools. Procurement / Purchasing / Warehouse share one tab.
- **AOG board:** one card per quote through RFQ → Quoted → Sale → Purchased
  → Received → Sent, case files (notes, pictures, PDFs, websites, emails,
  Teams, S3 files under `board_files/<card>/`), approvals and hard stops,
  Due / For approval / Highlighted / Quote rejected flags, search, filter by
  flag and person, customer files, history.
- Dark theme with a Light / Dark switch; new access grid in `/admin.html`.

Still different from the decisions above (done in Phases 1 and 2):
"Departments" → "Operations"; the sidebar order; Overview out of Tools;
Strategy Meeting, SOP, People and Documents pages; the board as one row per
file with line items underneath (instead of cards), a Flag on each line item
and a flagged / unflagged filter, filters on every heading field, the
on-time ✓ / ✗, column colours, manager next steps with deadlines on
Mentions of You, and files created automatically from Pentagon.

## Phases

- [x] **0. Split `index.html`** into `public/styles.css` and one script per
      area in `public/js/`, with no behaviour change, so later phases only
      read the part they change.
- [x] **1. Sidebar and navigation** per the decisions above; empty
      Staff-Facing / Department-Facing tabs; BD / US Gov tabs trimmed.
- [x] **2. Operations Kanban** — reshape the existing AOG board
      (`public/js/aog-board.js`, `board.js`) to the decisions above.
      Tested on staging with real data and redeployed 31 Oct 2026. Kept all
      approvals and hard stops, and cost / mark-up / margin with the same
      roles. Column headers show the stage colour; each file's stripe shows
      its responsible person's department. Attachments stay in
      `board_files/<file id>/`.
- [x] **3. US Gov Kanban** (reuses Phase 2). Tested on staging and
      redeployed 31 Oct 2026; Leadership still has to add the government
      customer list on the live board. The user's answers: columns Solicitation → Bid
      Submitted → Awarded → Purchased → Item Received → Delivered; only US
      Government (plus full-access and leadership) see or work it; Pentagon
      feeds it by a government-customer list; same cost / mark-up / margin
      roles, approvals and hard stops as Operations.
      - Same code as the Operations board with a board parameter: the
        routes take `?board=usgov`; `board.js` has `US_GOV_STAGES` (same
        stage ids, so every rule carries over); `aog-board.js` keeps one
        state per board (`BRDS`, `brd` is the one on screen).
      - Kept apart in S3: `usgov_board.json`, `usgov_board_files/<file>/`,
        `usgov_board_customers/`; settings under `settings.usgovBoard`
        (stage managers, global manager, big-ticket, `customers`).
      - Pentagon RFQs, quotes and sales orders whose account name matches
        the list (Stage managers on the US Gov board, leadership only) go
        to the US Gov board instead of Operations. POs carry the vendor,
        not the customer, so they stay on Operations until their number is
        typed on a US Gov file. Files already stored on Operations stay
        there.
      - Next steps on US Gov files become US Government tasks, so they show
        on Mentions of You (and bring back US Gov's Tasks tab while open).
      - Still open: the Procurement / Purchasing Pentagon list tabs (RFQs,
        Quotes, SOs, POs) still list government documents; and a Pentagon
        contact who isn't in US Government can be the responsible person
        on a US Gov file without being able to open the board.
- [x] **4. Administration** — IT, Admin, HR (incl. leave, payroll,
      performance), Finance. Tested on staging and redeployed 31 Oct 2026;
      Payroll still waits for HR's leave rules. The user's answers: leave
      needs a cover person, then a manager in the person's department, then
      an HR manager, one at a time on Mentions of You (no HR shortcut); reimbursements go
      Submitted → Finance checked → Approved to pay → Paid (plus
      Rejected), Finance only; the old Finance tables split into
      Approvals / Transfers / Balances (expected receipts later moved to
      Transfers, below Reimbursements, at the user's request); Payroll stores weekly base pay;
      leave types Annual, Sick, Unpaid, Parental, Bereavement, Jury duty,
      Other; admin request categories "Snacks, coffee & tea" and "Office
      & supplies"; a receipt is required for reimbursements.
      - Every login sees Administration. Staff-Facing (the forms and
        "What you've sent") is for everyone; Department-Facing is for the
        department's own people, plus Leadership on HR (read-only).
      - Rules in `staffforms.js`; routes `/api/staff-forms*` and
        `/api/payroll*` in `index.js`; S3 `staff_forms.json` (receipts
        under `staff_form_files/<id>/`) and `payroll.json`. Front end:
        `staff-forms.js`, `payroll.js`, `finance.js`.
      - IT: the ticket form makes an IT request (`source: "staff"`) on
        Requests, with the login's email. Department-Facing: Requests,
        Projects, Resolved.
      - Admin and HR Projects start with ongoing projects ("Admin
        requests", "HR issues", "Performance comments") that list every
        submission as a task with a person responsible, status and
        department-only notes.
      - HR's forms, leave and payroll: HR, Leadership and full access
        only, checked on the server.
      - Leave (changed 31 Oct 2026 at the user's request): the requester
        picks who covers for them (any login sharing one of their
        companies). Approved one step at a time — the cover person, then
        a manager in the requester's department, then an HR manager —
        each on their Mentions of You (also HR → Staff-Facing), with the
        request opening there. No HR shortcut. If the cover person says
        no, it goes back to the requester ("Needs a new cover person") to
        pick someone else; a no from the manager or HR declines it. Only
        fully approved leave reaches Payroll. Withdraw until approved.
      - **Payroll never works out pay.** Per entity and pay week it shows
        base pay, approved leave days and adjustments; each entity has an
        empty "Leave rules" box for HR, and the base-pay total is marked
        as needing a qualified person's check. For Phase 5: a spot bonus
        is an entry in `payroll.json` `adjustments`
        (`{ person, week (Monday), amount, currency, reason, source }`).
      - Still open: nothing is emailed yet (new submissions, approvals,
        decisions); leave approvals don't show on Mentions of You; a
        performance comment isn't copied into Performance automatically.
- [ ] **5. People** — employment file and spot bonus.
      Built 1 Nov 2026 on local `staging`; not yet tested on staging.
      - Leadership only (the `leadership` tick, not full access), checked on
        every route by `peopleOnly` in `index.js`; the sidebar item was
        already hidden from everyone else.
      - Rules in `people.js` (fields, next pay week, currency, when a spot
        bonus can be removed). Routes in `index.js`: `GET /api/people`,
        `GET|PUT /api/people/:username`,
        `POST /api/people/:username/files`, `GET|DELETE …/files/:fid`,
        `POST /api/people/:username/spot-bonus`, `DELETE …/spot-bonus/:id`.
        Front end `public/js/people.js` (after `company-pages.js`, whose
        placeholder was removed).
      - S3: `people.json` (`{ people: { username: { id, jobTitle,
        department, manager, startDate, employmentType, emergency, notes,
        files, history } } }`), documents under `people_files/<file id>/`.
        Base pay, pay currency and entity are written to `payroll.json`
        `people` — one source with HR → Payroll.
      - Spot bonus = `payroll.json` `adjustments` entry
        `{ id, person, week (Monday of next pay week), amount: 100,
        currency, reason, source: "spot-bonus", by, at }`. Currency: the
        person's pay currency, else their entity's currency set on Payroll,
        else USD. Not to yourself; a second click within 10 seconds adds
        nothing; the server refuses if the currency changed since the
        confirm.
      - Still open: Payroll has no "mark week done" yet, so Leadership can
        remove a spot bonus until its pay week ends (HR can still remove
        any adjustment on Payroll). Should Payroll get a "done" marker?
        Should the spot bonus fall back to the entity's usual currency
        (e.g. NZD for CAS) instead of USD when nothing is set? Performance
        comments link only when their "about" is exactly the login name.
- [ ] **6. Documents** — drag-and-drop S3 file manager, read-only with
      "request edit" raising an IT ticket.
- [ ] **7. Strategy Meeting agenda and SOP update form.**
- [ ] **8. Email replies** — draft, edit, send, ignore, open thread.
- [ ] **9. Company chat.**
- [ ] **10. README update and final review.**
