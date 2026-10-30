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
  before any real payroll is sent.
- **Mail.Send** for each person's mailbox (Microsoft 365 admin) before
  email replies can be sent as that person.
- **Staging stack** in Portainer (separate port and S3 prefix) for testing
  before each redeploy.
- **Push access** to GitHub from the machine doing the work.
- The repo is **public**; consider making it private.

## Already built (commits #64–#70, 30 Oct 2026)

An earlier session built parts of this from the "AOG CRM spec" — see the
README's *Navigation* and *AOG operations board* sections. Build on it
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

Still different from the decisions above (to do in Phases 1 and 2):
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
- [ ] **2. Operations Kanban** — reshape the existing AOG board
      (`public/js/aog-board.js`, `board.js`) to the decisions above.
- [ ] **3. US Gov Kanban** (reuses Phase 2).
- [ ] **4. Administration** — IT, Admin, HR (incl. leave, payroll,
      performance), Finance.
- [ ] **5. People** — employment file and spot bonus.
- [ ] **6. Documents** — drag-and-drop S3 file manager, read-only with
      "request edit" raising an IT ticket.
- [ ] **7. Strategy Meeting agenda and SOP update form.**
- [ ] **8. Email replies** — draft, edit, send, ignore, open thread.
- [ ] **9. Company chat.**
- [ ] **10. README update and final review.**
