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
- [x] **5. People** — employment file and spot bonus.
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
        department, manager, startDate, birthday, employmentType,
        emergency, notes, otherNotes, files, history } } }`), documents
        under `people_files/<file id>/`. History records which fields
        changed, never the notes' text.
      - After the staging test (1 Nov 2026, at the user's request): the file
        is read-only tables in sections (Employment, Pay, Emergency
        contact, Other notes), each with its own Edit / Save / Cancel that
        sends only that section; added Birthday and Other notes (HR's notes
        on preferences; still Leadership-only on the server).
      - History linking fixed (1 Nov 2026, from the staging test):
        performance comments were matched only when "Who is it about"
        (free text) was exactly the username. Now `matchLogin` in
        `people.js` matches username, email, local part, first / full name
        and calendar names; a name fitting several logins is attached to
        none and shown as "Unmatched". The form's field is now a list of
        logins plus "Someone else (type the name)"; the server still takes
        any text. The tracker summary was dropped silently for Leadership
        without Performance access and never looked at records without a
        login (`x-…`): now it says records exist, matches `x-…` records by
        name, and offers "Open in Performance". Leave (`by`, status
        `approved`, `fields.from` / `to`) and adjustments (`person`)
        already matched how they're stored. Tightened the same day (user
        approved): a name of more than one word links only when every word
        is one of that login's names (username, email's first part,
        calendar names), so "Elvis Presley" no longer lands on
        `elvis.santos`; a one-word name links only when exactly one login
        has it as a first name. Anything uncertain stays unmatched (a name
        that fits nobody shows on no file; HR still has it on Projects).
        Base pay, pay currency and entity are written to `payroll.json`
        `people` — one source with HR → Payroll.
      - Spot bonus = `payroll.json` `adjustments` entry
        `{ id, person, week (Monday of next pay week), amount: 100,
        currency, reason, source: "spot-bonus", by, at }`. Currency: the
        person's pay currency, else their entity's currency set on Payroll,
        else USD. Not to yourself; a second click within 10 seconds adds
        nothing; the server refuses if the currency changed since the
        confirm.
      - Payroll approval (1 Nov 2026, at the user's request): "Approve and
        send to accountants" under each entity's table on the week shown.
        Rules, snapshot and email in `payrollcheck.js`; routes
        `POST /api/payroll/approve` and `POST /api/payroll/approve/undo`
        (reason required), HR managers and full access only (`hrManager`,
        as for every Payroll change; Leadership still sees Payroll
        read-only). Accountants' addresses per entity in
        `payroll.json` `entities[ent].accountants` (none preset — **add
        them on live**). Approval at `approvals[ent][week]` = `{ by, at,
        sentTo, mailed, mailError?, snapshot }`, plus `approvalLog`. Sent
        with `sendMail` (now takes a list in `to`) from `MS_FROM_EMAIL`
        using the existing Mail.Send app permission, `saveCopy`, replyTo
        the approver. An approved week shows its snapshot and is locked:
        adjustments and spot bonuses can't be added or removed for it
        (this replaced "until the pay week ends"). Without email (staging)
        it's recorded with `mailed: false` and says nothing was sent.
      - Exempt (salaried, no overtime): SOI (US) only, on People → Pay,
        stored as `payroll.json` `people[u].exempt`; the server refuses it
        for other entities. A flag for HR / Leadership, shown on the SOI
        Payroll table and in the email; no overtime rules.
      - Still open: should the spot bonus fall back to the entity's usual
        currency (e.g. NZD for CAS) instead of USD when nothing is set?
      - Decided: only HR managers (and full access) approve payroll for
        the accountants; Leadership stays read-only on Payroll.
- [x] **6. Documents** — drag-and-drop S3 file manager, read-only with
      "request edit" raising an IT ticket.
      Built 2 Nov 2026 on `staging`; not yet tested on staging. The user's
      answers: each login sees its own departments' folders (full access
      and Leadership all); edit = upload, new version (old ones kept),
      rename, move within the department, archive (never a hard delete,
      IT restores); IT grants edit access to a whole folder (and
      everything in it) for 30 days by default; HR's people files,
      receipts, payroll and performance stay out of Documents.
      - Rules in `documents.js`; routes `/api/documents*` in `index.js`;
        front end `public/js/documents.js` (after `people.js`; the
        placeholder in `company-pages.js` was removed). README
        *Documents (file manager on S3)*.
      - Spaces: `dept:<company>|<department>` per company and department
        on the login, plus `board:ops` / `board:usgov` — read-only views
        of `board_files/` and `usgov_board_files/`, one folder per board
        file with documents, checked with `canSeeBoardCard`.
      - S3: `documents.json` (`folders`, `files` with `versions` and
        `history`, `grants`), bytes under
        `documents_files/<file id>/<version id>`.
      - Request edit = an IT ticket (`source: "staff"`, with
        `docEdit: { space, folder, where }`) on IT → Requests and the
        requester's "What you've sent". IT (or full access) grants or
        declines it on Documents → Edit access (IT), which resolves the
        ticket with a note; nobody decides their own request; grants can
        be revoked; resolving the ticket on IT → Requests closes the
        request too. Full access can always edit; Leadership is read-only.
      - View-only: PDFs, pictures, text and CSV stream inline through
        `/api/documents/view` (no public S3 links, `no-store`), shown in a
        viewer with a login-and-time watermark; no download button;
        right-click, save, print and copies over 200 characters are
        blocked. The page and README say plainly that this only
        discourages copying (screenshots still work). Word, Excel,
        PowerPoint and email files have no preview.
      - Tested locally against a mock server (no Node on the Mac): folder
        tiles, browsing, text and picture viewer, Excel "no preview",
        Request edit, IT grant with end date, drag-to-move, drag-in
        upload, large-copy block, light and dark. Staging test passed
        (user, 2 Nov 2026).
      - After the staging test (2 Nov 2026, at the user's request):
        **Add to…** copies a document onto a board file's case file (any
        Operations / US Gov file you can open, searchable by file, RFQ,
        quote, SO, PO number or customer; Pentagon quotes not yet on the
        board are adopted first) or, for Leadership, a person's employment
        file. A copy, not a link; both histories record it. Route
        `POST /api/documents/add-to`, sharing `docSource` with the viewer.
        Also (same day, at the user's request) **Business Development
        projects** as a target: copies listed under the project on BD →
        Projects, opened view-only, removable by whoever can edit the
        project; `task.files`, `task_files/<task id>/<file id>`, routes
        `GET /api/documents/projects`, `GET /api/tasks/:id/files/:fid/view`,
        `DELETE /api/tasks/:id/files/:fid`. Deleting a project leaves its
        copies in S3.
        **No downloads anywhere** (same day, at the user's request: "All
        documents should ever only be read only"): every route that serves
        a stored file (board case and customer files, People, Performance,
        IT request attachments, staff form receipts, SOP PDFs, Documents,
        BD projects) goes through `sendViewOnly` — inline PDFs, pictures,
        text only, `no-store`, never an attachment; other types refused.
        Every page opens them with `viewDocument` (documents.js) in the
        Documents viewer; SOPs no longer open in a new browser tab. Word /
        Excel / email files therefore can't be opened anywhere until a
        PDF conversion exists. Left alone: Performance's "Download record"
        and the IT notebook's "Download PDF" (print pages of the tracker's
        own records) and IT's emailed replies with attachments.
        US Government folders exist only under SOI Aviation
        (`DEPT_COMPANIES` in `documents.js`). PDFs did show in the viewer
        on the second local test.
      - Still open: Word / Excel previews would need converting to PDF on
        the server (e.g. LibreOffice in the container); the board's case
        files still download their attachments; nothing is emailed when
        edit access is granted or declined (the ticket's note shows it).
- [ ] **7. Strategy Meeting agenda and SOP update form.**
- [ ] **8. Email replies** — draft, edit, send, ignore, open thread.
- [ ] **9. Company chat.**
- [ ] **10. README update and final review.**
