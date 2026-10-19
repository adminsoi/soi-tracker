require("dotenv").config();

const path = require("path");
const fs = require("fs");
const https = require("https");
const { execSync } = require("child_process");
const express = require("express");

const {
  COMPANIES,
  DEPARTMENTS,
  DEFAULT_COMPANY,
  hashPassword,
  verifyPassword,
  signUserToken,
  signAdminToken,
  authMiddleware,
  adminMiddleware,
  isManager,
} = require("./auth");
const {
  getUsers,
  getTasks,
  withUsers,
  withTasks,
  getRfqMarks,
  withRfqMarks,
  getSettings,
  withSettings,
  getFinance,
  withFinance,
  getItRequests,
  withItRequests,
  getItNotebook,
  withItNotebook,
  putFile,
  getFile,
  deleteFile,
  getSops,
  withSops,
  getPerformance,
  withPerformance,
  getQbr,
  withQbr,
} = require("./s3store");
const { sendMail, mailConfigured } = require("./mailer");
const { eventsBetween, whosIn, CalendarError, nameFromTitle } = require("./calendar");
const { hrEvents, cleanFeedUrl, FeedError } = require("./hrcal");
const { itRequestsConfigured, fetchItRequests, IT_REQUESTS_MAILBOX, parseFormWorkbook, recordFromEmail, FormFileError, officeStamp } = require("./itrequests");
const { unreadThreads, MailError } = require("./mail");
const { pentagonQuery } = require("./pentagon");
const {
  PENTAGON_VIEWS,
  FINANCE_QUERIES,
  FIELD_GUESSES,
  allViews,
  viewById,
  resolveField,
  markKey,
  resultRows,
} = require("./pentagonViews");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error("Missing required env var: ADMIN_PASSWORD");
  process.exit(1);
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Accounts created before companies/multi-department access existed only
// have a single "department" string (and maybe no "companies" at all).
// Migrate those shapes on the fly so old accounts keep working until
// someone re-saves them via the admin page with the current fields.
function normalizeUser(u) {
  let departments = u.departments;
  if (!Array.isArray(departments) || departments.length === 0) {
    departments = u.department ? [u.department] : [];
  }
  return {
    ...u,
    companies: u.companies && u.companies.length ? u.companies : [DEFAULT_COMPANY],
    departments,
    fullAccess: !!u.fullAccess,
    manager: !!u.manager,
    breakdown: !!u.breakdown,
    leadership: !!u.leadership,
    itNotebook: !!u.itNotebook,
    performance: !!u.performance,
    extraMailboxes: Array.isArray(u.extraMailboxes) ? u.extraMailboxes : [],
    calendarNames: Array.isArray(u.calendarNames) ? u.calendarNames : [],
    pentagonCode: u.pentagonCode || "",
  };
}

function sameUser(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

const TASK_STATUSES = ["todo", "in_progress", "blocked", "done"];
const TASK_PRIORITIES = ["low", "medium", "high"];
const TASK_KINDS = ["task", "project"];

function taskCompany(t) {
  return t.company || DEFAULT_COMPANY;
}

function taskLabel(task) {
  return task.title || task.part || "Untitled task";
}

// Extra fields from the table layout. Procurement / Purchasing / Warehouse
// rows use part, platform, customer and obsolete; any task may have them.
function cleanTaskFields(body, target) {
  const text = (v, n) => String(v || "").trim().slice(0, n);
  if ("title" in body) target.title = text(body.title, 140);
  if ("part" in body) target.part = text(body.part, 60);
  if ("platform" in body) target.platform = text(body.platform, 80);
  if ("customer" in body) target.customer = text(body.customer, 120);
  if ("obsolete" in body) target.obsolete = body.obsolete === "Yes" ? "Yes" : "No";
  if ("dueDate" in body) target.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate || "") ? body.dueDate : "";
  if ("notes" in body) target.notes = text(body.notes, 500);
}

async function notifyOwner(task, previousOwner) {
  if (!task.owner || task.owner === previousOwner) return;
  const users = await getUsers();
  const ownerUser = users.find((u) => u.username === task.owner);
  if (!ownerUser || !ownerUser.email) return;
  try {
    await sendMail({
      to: ownerUser.email,
      subject: `New task assigned: ${taskLabel(task)}`,
      html:
        `<p>You've been assigned a task in the SOI Aviation tracker — ${escapeHtml(taskCompany(task))} / ${escapeHtml(task.department)}:</p>` +
        `<p><strong>${escapeHtml(taskLabel(task))}</strong></p>` +
        (task.notes ? `<p>${escapeHtml(task.notes)}</p>` : "") +
        (task.dueDate ? `<p>Due: ${escapeHtml(task.dueDate)}</p>` : "") +
        `<p>Priority: ${escapeHtml(task.priority)}</p>`,
    });
  } catch (err) {
    console.error("Failed to send assignment email:", err);
  }
}

const PORT = process.env.PORT || 443;
const SERVER_IP = process.env.SERVER_IP;

// Never let one bad request take the whole server down. Any error that
// slips past a route's own try/catch lands here, gets logged, and the
// process keeps running instead of crashing (which would otherwise show up
// to users as "Failed to fetch" with no useful message anywhere).
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (server kept running):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server kept running):", err);
});

const app = express();
app.use(express.json());

// Wraps an async route handler so a thrown/rejected error becomes a JSON
// 500 response instead of a hung connection or a crashed process.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error(`Error in ${req.method} ${req.path}:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Something went wrong on the server. Check the container logs." });
      }
    });
  };
}

// ---------- Login ----------

app.post(
  "/api/login",
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }
    const users = await getUsers();
    const rawUser = users.find(
      (u) => u.username.toLowerCase() === String(username).toLowerCase()
    );
    if (!rawUser) return res.status(401).json({ error: "Invalid username or password" });

    const ok = await verifyPassword(password, rawUser.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid username or password" });

    const user = normalizeUser(rawUser);
    const token = signUserToken(user);
    res.json({
      token,
      username: user.username,
      companies: user.companies,
      departments: user.departments,
      fullAccess: user.fullAccess,
      manager: isManager(user),
      leadership: user.leadership,
      itNotebook: !!user.itNotebook,
      performance: !!user.performance,
      pentagonCode: user.pentagonCode,
      pentagonMentions: getsPentagonMentions(user),
    });
  })
);

app.get("/api/me", authMiddleware, asyncHandler(async (req, res) => {
  res.json({
    itNotebook: await hasItNotebook(req.user),
    performance: await hasPerformance(req.user),
    username: req.user.username,
    companies: req.user.companies,
    departments: req.user.departments,
    fullAccess: req.user.fullAccess,
    manager: isManager(req.user),
    leadership: req.user.leadership,
    pentagonCode: req.user.pentagonCode,
    pentagonMentions: getsPentagonMentions(req.user),
  });
}));

app.get("/api/companies", (req, res) => {
  res.json(COMPANIES);
});

app.get("/api/departments", (req, res) => {
  res.json(DEPARTMENTS);
});

// Directory of real logins, for picking a task's Owner. Scoped to people
// who have access to this company, and who are either assigned to this
// department or have full access — so people don't see the whole
// company's account list unnecessarily.
app.get(
  "/api/users",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const company = req.query.company;
    const rawUsers = await getUsers();
    const users = rawUsers.map(normalizeUser);
    const filtered = users
      .filter((u) => !company || u.companies.includes(company))
      .map((u) => ({ username: u.username, departments: u.departments, fullAccess: u.fullAccess }));
    res.json(filtered);
  })
);

// ---------- Tasks (scoped by company + department) ----------

app.get(
  "/api/tasks",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const company = req.query.company;
    const tasks = await getTasks();

    if (!company) {
      // No company specified — this is the "Global" view, only meaningful
      // (and allowed) for full-access accounts with more than one company.
      if (!req.user.fullAccess || req.user.companies.length <= 1) {
        return res.status(400).json({ error: "Missing company" });
      }
      const scoped = tasks.filter((t) => req.user.companies.includes(taskCompany(t)));
      return res.json(withParents(scoped, req.user));
    }

    if (!req.user.companies.includes(company)) {
      return res.status(403).json({ error: "You don't have access to that company" });
    }
    const inCompany = tasks.filter((t) => taskCompany(t) === company);
    const scoped = req.user.fullAccess
      ? inCompany
      : inCompany.filter((t) => req.user.departments.includes(t.department));
    res.json(withParents(scoped, req.user));
  })
);

// Everything assigned to the signed-in person, across all their companies
// and departments, for "Mentions you". A manager can assign someone a task
// outside their own departments; this is where they'll still see it.
app.get(
  "/api/tasks/mine",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const tasks = await getTasks();
    res.json(
      tasks.filter((t) => req.user.companies.includes(taskCompany(t)) && sameUser(t.owner, req.user.username))
    );
  })
);

app.post(
  "/api/tasks",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const title = String(body.title || "").trim().slice(0, 140);
    const part = String(body.part || "").trim();
    if (!title && !part) return res.status(400).json({ error: "Give it a name or a part number" });

    if (!body.company || !req.user.companies.includes(body.company)) {
      return res.status(400).json({ error: "Choose a valid company" });
    }

    if (!DEPARTMENTS.includes(body.department)) {
      return res.status(400).json({ error: "Choose a valid department" });
    }
    if (!req.user.fullAccess && !req.user.departments.includes(body.department)) {
      return res.status(403).json({ error: "That's not one of your departments" });
    }
    const department = body.department;

    const priority = TASK_PRIORITIES.includes(body.priority)
      ? body.priority
      : "medium";

    // Who it's on: a manager can pick anyone. Otherwise — or when a manager
    // leaves it unassigned — it goes to the department's default person
    // (set in /admin.html, e.g. IT -> Shreya), so requests land with the
    // right owner. Without a default, a regular user's task is their own.
    const defaults = (await getSettings()).departmentDefaults || {};
    const chosen = isManager(req.user) ? String(body.owner || "").trim().slice(0, 60) : "";
    const owner = chosen || defaults[department] || (isManager(req.user) ? "" : req.user.username);

    const task = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      title,
      company: body.company,
      department,
      status: "todo",
      priority,
      owner,
      dueDate: "",
      notes: "",
      createdAt: Date.now(),
      createdBy: req.user.username,
    };
    cleanTaskFields(body, task);
    if (body.parentId) task.parentId = String(body.parentId);
    // Tasks (quick, one-off) vs projects (long-term, with sub-tasks). Sub-tasks
    // belong to their project and don't need one.
    else if (TASK_KINDS.includes(body.kind)) task.kind = body.kind;

    let parentProblem = null;
    await withTasks((tasks) => {
      // A sub-task lives under a project in the same company and department,
      // and only someone who can edit that project may add to it.
      if (task.parentId) {
        const parent = tasks.find((x) => x.id === task.parentId);
        if (!parent || parent.parentId || taskCompany(parent) !== task.company || parent.department !== task.department) {
          parentProblem = "That project doesn't exist here";
          return;
        }
        if (!canEdit(req.user, parent)) {
          parentProblem = "Only a manager or the project's creator can add sub-tasks to it";
          return;
        }
      }
      tasks.unshift(task);
    });
    if (parentProblem) return res.status(403).json({ error: parentProblem });

    res.status(201).json(task);
    notifyOwner(task, null);
  })
);

function canTouch(user, task) {
  if (!user.companies.includes(taskCompany(task))) return false;
  return user.fullAccess || user.departments.includes(task.department);
}

// Managers see every task in their departments. Everyone else sees only the
// tasks assigned to them or that they created themselves.
function canSee(user, task) {
  if (isManager(user)) return true;
  return sameUser(task.owner, user.username) || sameUser(task.createdBy, user.username);
}

// A non-manager who is on a sub-task also gets its parent project, so the
// sub-task has somewhere to sit in the table. canEdit still makes it
// read-only for them.
function withParents(scoped, user) {
  const visible = scoped.filter((t) => canSee(user, t));
  const ids = new Set(visible.map((t) => t.id));
  for (const t of visible) {
    if (t.parentId && !ids.has(t.parentId)) {
      const parent = scoped.find((x) => x.id === t.parentId);
      if (parent) {
        visible.push(parent);
        ids.add(parent.id);
      }
    }
  }
  return visible;
}

// Non-managers may change only tasks they created themselves. Anything a
// manager assigned them is read-only.
function canEdit(user, task) {
  if (!canTouch(user, task) || !canSee(user, task)) return false;
  return isManager(user) || sameUser(task.createdBy, user.username);
}

app.patch(
  "/api/tasks/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};
    const manager = isManager(req.user);
    let updated = null;
    let forbidden = null;
    let previousOwner = null;

    if ("status" in body && !TASK_STATUSES.includes(body.status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    if ("priority" in body && !TASK_PRIORITIES.includes(body.priority)) {
      return res.status(400).json({ error: "Invalid priority" });
    }

    await withTasks((tasks) => {
      const t = tasks.find((x) => x.id === id);
      if (!t || !canSee(req.user, t)) return;
      if (!canEdit(req.user, t)) {
        forbidden = canTouch(req.user, t)
          ? "This task was assigned by a manager — it's read-only for you"
          : "That task isn't accessible to you";
        return;
      }
      // Status and owner are a manager's call. Sending back the same value
      // (the edit form always does) is fine; changing it is not.
      if (!manager && "status" in body && body.status !== t.status) {
        forbidden = "Only a manager can change a task's status";
        return;
      }
      if (!manager && "owner" in body && !sameUser(body.owner, t.owner)) {
        forbidden = "Only a manager can assign a task to someone else";
        return;
      }
      const nextTitle = "title" in body ? String(body.title || "").trim() : t.title;
      const nextPart = "part" in body ? String(body.part || "").trim() : t.part;
      if (!nextTitle && !nextPart) {
        forbidden = "Give it a name or a part number";
        return;
      }
      previousOwner = t.owner;
      cleanTaskFields(body, t);
      if ("status" in body) t.status = body.status;
      if ("priority" in body) t.priority = body.priority;
      if (manager && "owner" in body) t.owner = String(body.owner || "").trim().slice(0, 60);
      updated = t;
    });

    if (forbidden) return res.status(403).json({ error: forbidden });
    if (!updated) return res.status(404).json({ error: "Task not found" });
    res.json(updated);
    notifyOwner(updated, previousOwner);
  })
);

app.delete(
  "/api/tasks/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    let removed = false;
    let forbidden = false;

    await withTasks((tasks) => {
      const idx = tasks.findIndex((x) => x.id === id);
      if (idx === -1 || !canSee(req.user, tasks[idx])) return;
      if (!canEdit(req.user, tasks[idx])) {
        forbidden = true;
        return;
      }
      // Deleting a project takes its sub-tasks with it.
      const doomed = new Set([id]);
      for (const t of tasks) if (t.parentId === id) doomed.add(t.id);
      for (let i = tasks.length - 1; i >= 0; i--) if (doomed.has(tasks[i].id)) tasks.splice(i, 1);
      removed = true;
    });

    if (forbidden) return res.status(403).json({ error: "You can only delete tasks you created" });
    if (!removed) return res.status(404).json({ error: "Task not found" });
    res.status(204).end();
  })
);

// ---------- Finance (per company) ----------
// Bank balances, payments waiting for approval, approved payments and
// expected receipts — typed in by people, not connected to any bank.
// Visible to Accounting & Finance and full-access logins for their
// companies. Ticking things off (approve, paid, received) is a manager's
// call, like everywhere else.

const FINANCE_LISTS = {
  accounts: { name: 120, balance: "money", asOf: "date", notes: 500 },
  dailyPayments: { vendor: 120, amount: "money", due: "date", notes: 500 },
  approvedToPay: { vendor: 120, amount: "money", due: "date", notes: 500, paid: "bool" },
  expectedReceipts: { party: 120, amount: "money", expected: "date", received: "bool", notes: 500 },
};
const FINANCE_TICKS = ["paid", "received"];

function canSeeFinance(user, company) {
  return user.companies.includes(company) && inDepartment(user, "Accounting & Finance");
}

function emptyFinance() {
  return { accounts: [], dailyPayments: [], approvedToPay: [], expectedReceipts: [] };
}

function cleanFinanceFields(list, body, target) {
  const spec = FINANCE_LISTS[list];
  for (const [field, kind] of Object.entries(spec)) {
    if (!(field in body)) continue;
    const v = body[field];
    if (kind === "money") target[field] = Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0;
    else if (kind === "date") target[field] = /^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : "";
    else if (kind === "bool") target[field] = !!v;
    else target[field] = String(v || "").trim().slice(0, kind);
  }
}

// ---- Finance rows from Pentagon (SOI Aviation only) ----
// Open bills -> Daily payments / Approved to pay, open customer invoices ->
// Expected receipts, bank balances -> Bank accounts. The money columns come
// from Pentagon and are read-only here; Approve, Paid, Received and notes are
// kept in the tracker under fin.pentagon, keyed by document number. Rows are
// cached for a minute. A query that fails (or doesn't exist yet) just leaves
// that table to the hand-entered rows, with a note saying why.
const FINANCE_PENTAGON_COMPANY = "SOI Aviation";
const FINANCE_CACHE_MS = 60_000;
const financeRowCache = new Map(); // queryName -> { at, rows, error }
const PG_KIND = { dailyPayments: "ap", approvedToPay: "ap", expectedReceipts: "ar", accounts: "bank" };

async function financeRows(q) {
  const hit = financeRowCache.get(q.queryName);
  if (hit && Date.now() - hit.at < FINANCE_CACHE_MS) return hit;
  let entry;
  try {
    const data = await pentagonQuery(q.queryName, { params: {}, limit: 500 });
    entry = { at: Date.now(), rows: resultRows(data), error: null };
  } catch (err) {
    entry = { at: Date.now(), rows: [], error: /not configured/i.test(err.message) ? "Pentagon isn't connected" : `Query ${q.queryName} didn't run — has it been created in Transmute?` };
    console.error(`Finance rows from ${q.queryName} failed: ${err.message}`);
  }
  financeRowCache.set(q.queryName, entry);
  return entry;
}

function emptyPg() {
  return { approved: {}, received: {}, notes: {} };
}

async function pentagonFinance(fin) {
  const pg = Object.assign(emptyPg(), fin.pentagon || {});
  const [ap, ar, banks] = await Promise.all([
    financeRows(FINANCE_QUERIES.payables),
    financeRows(FINANCE_QUERIES.receivables),
    financeRows(FINANCE_QUERIES.banks),
  ]);
  const val = (q, row, name) => {
    const col = q.fields[name];
    return col && Object.prototype.hasOwnProperty.call(row, col) ? row[col] : undefined;
  };
  const text = (v) => (v === null || v === undefined ? "" : String(v));
  const money = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0);
  const date = (v) => text(v).slice(0, 10);
  const out = { dailyPayments: [], approvedToPay: [], expectedReceipts: [], accounts: [] };

  for (const row of ap.rows) {
    const key = text(val(FINANCE_QUERIES.payables, row, "key"));
    if (!key) continue;
    const r = {
      id: `pg:${key}`, source: "pentagon", docNo: key,
      vendor: text(val(FINANCE_QUERIES.payables, row, "party")),
      amount: money(val(FINANCE_QUERIES.payables, row, "amount")),
      due: date(val(FINANCE_QUERIES.payables, row, "due")),
      ref: text(val(FINANCE_QUERIES.payables, row, "ref")),
      notes: pg.notes[`ap:${key}`] || "",
    };
    const a = pg.approved[key];
    if (a) out.approvedToPay.push(Object.assign(r, { approvedAt: a.approvedAt, approvedBy: a.approvedBy, paid: !!a.paid }));
    else out.dailyPayments.push(r);
  }
  for (const row of ar.rows) {
    const key = text(val(FINANCE_QUERIES.receivables, row, "key"));
    if (!key) continue;
    out.expectedReceipts.push({
      id: `pg:${key}`, source: "pentagon", docNo: key,
      party: text(val(FINANCE_QUERIES.receivables, row, "party")),
      amount: money(val(FINANCE_QUERIES.receivables, row, "amount")),
      expected: date(val(FINANCE_QUERIES.receivables, row, "due")),
      ref: text(val(FINANCE_QUERIES.receivables, row, "ref")),
      received: !!pg.received[key],
      notes: pg.notes[`ar:${key}`] || "",
    });
  }
  for (const row of banks.rows) {
    const key = text(val(FINANCE_QUERIES.banks, row, "key"));
    if (!key) continue;
    out.accounts.push({
      id: `pg:${key}`, source: "pentagon", docNo: key, name: key,
      balance: money(val(FINANCE_QUERIES.banks, row, "balance")),
      asOf: date(val(FINANCE_QUERIES.banks, row, "asOf")),
      notes: pg.notes[`bank:${key}`] || "",
    });
  }
  const status = (e) => ({ connected: !e.error, error: e.error, count: e.rows.length });
  return { rows: out, status: { payables: status(ap), receivables: status(ar), banks: status(banks) } };
}

app.get(
  "/api/finance",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const company = String(req.query.company || "");
    if (!canSeeFinance(req.user, company)) {
      return res.status(403).json({ error: "Finance isn't available for your account" });
    }
    const all = await getFinance();
    const fin = { ...emptyFinance(), ...(all[company] || {}) };
    const manual = {
      accounts: fin.accounts, dailyPayments: fin.dailyPayments,
      approvedToPay: fin.approvedToPay, expectedReceipts: fin.expectedReceipts,
    };
    if (company !== FINANCE_PENTAGON_COMPANY) return res.json(manual);
    const pentagon = await pentagonFinance(fin);
    // Pentagon rows first, then anything typed in by hand.
    const merged = {};
    for (const list of Object.keys(manual)) merged[list] = pentagon.rows[list].concat(manual[list]);
    res.json(Object.assign(merged, { pentagon: pentagon.status }));
  })
);

// One endpoint for every change: add / update / delete a row, or move a
// payment between "Daily payments" and "Approved to pay".
app.post(
  "/api/finance",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const company = String(body.company || "");
    const list = String(body.list || "");
    const op = String(body.op || "");
    if (!canSeeFinance(req.user, company)) {
      return res.status(403).json({ error: "Finance isn't available for your account" });
    }
    if (!FINANCE_LISTS[list]) return res.status(400).json({ error: "Unknown finance table" });
    const fields = body.fields && typeof body.fields === "object" ? body.fields : {};
    const manager = isManager(req.user);
    if ((op === "approve" || op === "unapprove") && !manager) {
      return res.status(403).json({ error: "Only a manager can approve payments" });
    }
    if (FINANCE_TICKS.some((k) => k in fields) && !manager) {
      return res.status(403).json({ error: "Only a manager can tick that off" });
    }

    let problem = null;
    let result = null;
    // Rows from Pentagon ("pg:<document number>"): the money columns are
    // Pentagon's; only approve / paid / received / notes are kept here.
    const pgKey = typeof body.id === "string" && body.id.startsWith("pg:") ? body.id.slice(3).slice(0, 80) : null;
    if (pgKey) {
      if (company !== FINANCE_PENTAGON_COMPANY) return res.status(400).json({ error: "Unknown row" });
      const kind = PG_KIND[list];
      const extra = Object.keys(fields).filter((k) => !["notes", "paid", "received"].includes(k));
      if (op === "add" || op === "delete" || extra.length) {
        return res.status(400).json({ error: "That row comes from Pentagon — change it in Pentagon. Only approval, ticks and notes are kept here." });
      }
      await withFinance((all) => {
        const fin = (all[company] = { ...emptyFinance(), ...(all[company] || {}) });
        const pg = (fin.pentagon = Object.assign(emptyPg(), fin.pentagon || {}));
        if (op === "approve" && kind === "ap") {
          pg.approved[pgKey] = { approvedAt: new Date().toISOString(), approvedBy: req.user.username, paid: false };
          result = pg.approved[pgKey];
        } else if (op === "unapprove" && kind === "ap") {
          delete pg.approved[pgKey];
          result = { ok: true };
        } else if (op === "update") {
          if ("notes" in fields) pg.notes[`${kind}:${pgKey}`] = String(fields.notes || "").trim().slice(0, 500);
          if ("paid" in fields) {
            if (!pg.approved[pgKey]) { problem = "Approve it before marking it paid"; return; }
            pg.approved[pgKey].paid = !!fields.paid;
          }
          if ("received" in fields && kind === "ar") pg.received[pgKey] = !!fields.received;
          result = { ok: true };
        } else {
          problem = "Unknown change";
        }
      });
      if (problem) return res.status(400).json({ error: problem });
      return res.json(result);
    }
    await withFinance((all) => {
      const fin = (all[company] = { ...emptyFinance(), ...(all[company] || {}) });
      const rows = fin[list];
      const idx = rows.findIndex((r) => r.id === body.id);
      if (op === "add") {
        const row = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8) };
        cleanFinanceFields(list, fields, row);
        row.createdBy = req.user.username;
        rows.push(row);
        result = row;
      } else if (idx === -1) {
        problem = "That row no longer exists";
      } else if (op === "update") {
        cleanFinanceFields(list, fields, rows[idx]);
        rows[idx].updatedBy = req.user.username;
        result = rows[idx];
      } else if (op === "delete") {
        rows.splice(idx, 1);
        result = { ok: true };
      } else if (op === "approve" && list === "dailyPayments") {
        const [row] = rows.splice(idx, 1);
        const approved = { ...row, approvedAt: new Date().toISOString(), approvedBy: req.user.username, paid: false };
        fin.approvedToPay.push(approved);
        result = approved;
      } else if (op === "unapprove" && list === "approvedToPay") {
        const [row] = rows.splice(idx, 1);
        delete row.approvedAt;
        delete row.approvedBy;
        delete row.paid;
        fin.dailyPayments.push(row);
        result = row;
      } else {
        problem = "Unknown change";
      }
    });
    if (problem) return res.status(400).json({ error: problem });
    res.json(result);
  })
);

// ---------- Pentagon queries ----------
// Only the queries the dashboards use can be run, and only by people in that
// view's department (or with full access): RFQs, Quotes, Sales Orders,
// Purchase Orders, Invoices — defined in pentagonViews.js — plus
// "dashboards.mine" for Mentions you. The API key never reaches the browser.

// Someone in a view's department (or with full access) may run that view's
// query. The views themselves are defined in pentagonViews.js.
const VIEW_DEPARTMENTS = Object.fromEntries(allViews().map((v) => [v.id, v.department]));
const QUERY_DEPARTMENTS = Object.fromEntries(allViews().map((v) => [v.queryName, v.department]));
const MENTIONS_QUERY = "dashboards.mine";
const LIST_PARAMS = ["date_from", "date_to", "status", "account_no"];

// Pentagon documents (RFQs, quotes, orders, invoices) only show in Mentions
// you for people with one of these departments ticked on their login.
// Full access and leadership don't count on their own.
const PENTAGON_MENTION_DEPARTMENTS = ["Procurement", "Purchasing", "Warehouse", "US Government"];
function getsPentagonMentions(user) {
  return (user.companies || []).includes("SOI Aviation") &&
    (user.departments || []).some((d) => PENTAGON_MENTION_DEPARTMENTS.includes(d));
}

function inDepartment(user, dept) {
  return !!dept && (user.fullAccess || user.departments.includes(dept));
}

// Can see the ticks / notes / assignments on Pentagon rows at all.
function canSeeRowMarks(user) {
  return user.companies.includes("SOI Aviation") &&
    Object.values(VIEW_DEPARTMENTS).some((d) => inDepartment(user, d));
}

app.post(
  "/api/pentagon/:queryName",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { queryName } = req.params;
    if (!req.user.companies.includes("SOI Aviation")) {
      return res.status(403).json({ error: "Not available for your account" });
    }
    const body = req.body || {};
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 200, 1), 500);
    let params;
    if (queryName === MENTIONS_QUERY) {
      if (!getsPentagonMentions(req.user)) return res.json({ rows: [] });
      // Always your own Pentagon code, never one sent by the browser.
      if (!req.user.pentagonCode) return res.status(400).json({ error: "No Pentagon code is set on your login" });
      params = { code: req.user.pentagonCode };
    } else if (inDepartment(req.user, QUERY_DEPARTMENTS[queryName])) {
      // Only the list filters, as text.
      const sent = body.params && typeof body.params === "object" ? body.params : {};
      params = Object.fromEntries(LIST_PARAMS.map((k) => [k, String(sent[k] || "").trim().slice(0, 40)]));
    } else {
      return res.status(403).json({ error: "Not available for your account" });
    }
    try {
      res.json(await pentagonQuery(queryName, { params, limit }));
    } catch (err) {
      console.error(`Pentagon query failed: ${err.message}`);
      res.status(502).json({ error: "Pentagon query failed: " + err.message });
    }
  })
);

// ---------- Ticks (✓ / ✗), notes and assignments on Pentagon rows ----------
// Pentagon is read-only from here, so these live in the tracker
// (rfq_marks.json). RFQs are keyed by RFQ number; other views by
// "<view>:<doc number>". Anyone who can see those lists can read them; only
// managers can set them. Each mark keeps a small snapshot (doc number,
// customer/vendor, due date) so "Mentions You" can list what's assigned to
// someone without re-running Pentagon queries.

app.get(
  "/api/rfq-marks",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!canSeeRowMarks(req.user)) {
      return res.status(403).json({ error: "Not available for your account" });
    }
    res.json(await getRfqMarks());
  })
);

// Rows a manager assigned to the signed-in person, for "Mentions You".
app.get(
  "/api/rfq-marks/mine",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!getsPentagonMentions(req.user)) return res.json([]);
    const marks = await getRfqMarks();
    const mine = Object.entries(marks)
      .filter(([, m]) => m.assignee && sameUser(m.assignee, req.user.username))
      .map(([key, m]) => ({ key, ...m }));
    res.json(mine);
  })
);

async function notifyRowAssignee(mark, previousAssignee) {
  if (!mark.assignee || sameUser(mark.assignee, previousAssignee)) return;
  const users = await getUsers();
  const user = users.find((u) => sameUser(u.username, mark.assignee));
  if (!user || !user.email) return;
  const what = `${mark.label || "Item"} ${mark.docNo || ""}`.trim();
  try {
    await sendMail({
      to: user.email,
      subject: `Assigned to you: ${what}`,
      html:
        `<p>You've been assigned ${escapeHtml(what)} in the SOI Aviation tracker.</p>` +
        (mark.party ? `<p>${escapeHtml(mark.party)}</p>` : "") +
        (mark.dueDate ? `<p>Due: ${escapeHtml(mark.dueDate)}</p>` : "") +
        `<p>It's listed under "Mentions You".</p>`,
    });
  } catch (err) {
    console.error("Failed to send assignment email:", err);
  }
}

app.put(
  "/api/rfq-marks/:key",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const view = String(body.view || "rfqs");
    const dept = VIEW_DEPARTMENTS[view];
    if (!dept || !req.user.companies.includes("SOI Aviation") || !inDepartment(req.user, dept)) {
      return res.status(403).json({ error: "Not available for your account" });
    }
    if (!isManager(req.user)) {
      return res.status(403).json({ error: "Only a manager can tick, assign or add notes here" });
    }
    const key = String(req.params.key || "").trim().slice(0, 80);
    if (!key) return res.status(400).json({ error: "Missing document number" });
    if ("status" in body && !TASK_STATUSES.includes(body.status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    if ("priority" in body && !TASK_PRIORITIES.includes(body.priority)) {
      return res.status(400).json({ error: "Invalid priority" });
    }

    // Assign only to a real login (or "" to unassign), stored as its username.
    let assignee;
    if ("assignee" in body) {
      const wanted = String(body.assignee || "").trim();
      if (wanted) {
        const users = await getUsers();
        const match = users.find((u) => sameUser(u.username, wanted));
        if (!match) return res.status(400).json({ error: "No login with that username" });
        assignee = match.username;
      } else {
        assignee = "";
      }
    }

    const snap = (v, n) => String(v || "").trim().slice(0, n);
    let saved = null;
    let previousAssignee = null;
    await withRfqMarks((marks) => {
      const mark = marks[key] || { done: false, notes: "" };
      previousAssignee = mark.assignee || "";
      // ✓ / ✗ on the table and the card's board column are the same thing:
      // Done ⇔ ✓. Moving a card sets both; ticking a row sets both.
      if ("status" in body) {
        mark.status = body.status;
        mark.done = body.status === "done";
      } else if ("done" in body) {
        mark.done = !!body.done;
        mark.status = mark.done ? "done" : mark.status && mark.status !== "done" ? mark.status : "todo";
      }
      if ("priority" in body) mark.priority = body.priority;
      if ("notes" in body) mark.notes = String(body.notes || "").trim().slice(0, 500);
      if (assignee !== undefined) {
        mark.assignee = assignee;
        mark.assignedBy = req.user.username;
      }
      mark.view = view;
      if (body.snapshot && typeof body.snapshot === "object") {
        mark.label = snap(body.snapshot.label, 20);
        mark.docNo = snap(body.snapshot.docNo, 40);
        mark.party = snap(body.snapshot.party, 120);
        mark.dueDate = snap(body.snapshot.dueDate, 10);
        mark.pentagonUser = snap(body.snapshot.pentagonUser, 40);
      }
      mark.updatedBy = req.user.username;
      mark.updatedAt = Date.now();
      marks[key] = mark;
      saved = mark;
    });
    res.json(saved);
    notifyRowAssignee(saved, previousAssignee);
  })
);

// ---------- Pentagon rows as board cards ----------
// Every row of a view marked `tasks: true` shows up on that department's
// board. Nothing is copied into tasks.json: each card is built on the fly
// from the Pentagon row plus its mark (status, assignee, priority, notes),
// so the RFQ/SO/PO tables and the board always agree. Rows are cached
// briefly so the board's 15-second refresh doesn't hammer Pentagon.

const PENTAGON_CACHE_MS = 60_000;
const pentagonRowCache = new Map(); // queryName -> { at, rows, error }

async function cachedRows(view) {
  const hit = pentagonRowCache.get(view.queryName);
  if (hit && Date.now() - hit.at < PENTAGON_CACHE_MS) return hit;
  let entry;
  try {
    const data = await pentagonQuery(view.queryName, { params: { date_from: "", date_to: "", status: "", account_no: "" }, limit: 200 });
    entry = { at: Date.now(), rows: resultRows(data), error: null };
  } catch (err) {
    console.error(`Pentagon rows for ${view.id} failed: ${err.message}`);
    entry = { at: Date.now(), rows: [], error: err.message };
  }
  pentagonRowCache.set(view.queryName, entry);
  return entry;
}

function cell(v) {
  return v === null || v === undefined ? "" : String(v);
}

/** Turn one Pentagon row into a task-shaped card. */
function rowToCard(view, row, mark, codeToUser) {
  const f = (name) => resolveField(view, row, name);
  const docNo = cell(row[f("key")]);
  const party = f("party") ? cell(row[f("party")]) : "";
  const pentagonUser = f("person") ? cell(row[f("person")]).trim() : "";
  const byCode = pentagonUser ? codeToUser.get(pentagonUser.toLowerCase()) : null;
  const key = markKey(view.id, docNo);
  const m = mark || {};
  return {
    id: `pg:${key}`,
    source: "pentagon",
    view: view.id,
    markKey: key,
    docLabel: view.docLabel,
    docNo,
    title: `${view.docLabel} ${docNo}${party ? ` — ${party}` : ""}`,
    company: "SOI Aviation",
    department: view.department,
    status: m.status || (m.done ? "done" : "todo"),
    priority: m.priority || "medium",
    // Who it's on: whoever a manager assigned, else whoever did it in Pentagon.
    owner: m.assignee || (byCode ? byCode.username : pentagonUser),
    assignee: m.assignee || "",
    pentagonUser,
    // "Created by" for a Pentagon row is the person who entered it there.
    createdBy: byCode ? byCode.username : pentagonUser,
    dueDate: f("due") ? cell(row[f("due")]).slice(0, 10) : "",
    notes: m.notes || "",
    party,
    part: f("part") ? cell(row[f("part")]) : "",
    createdAt: f("entered") ? Date.parse(cell(row[f("entered")])) || 0 : 0,
  };
}

async function pentagonCards(views) {
  const [users, marks] = await Promise.all([getUsers(), getRfqMarks()]);
  const codeToUser = new Map();
  users.map(normalizeUser).forEach((u) => {
    if (u.pentagonCode) codeToUser.set(u.pentagonCode.trim().toLowerCase(), u);
  });
  const cards = [];
  const errors = [];
  for (const view of views) {
    const { rows, error } = await cachedRows(view);
    if (error) errors.push(`${view.label}: ${error}`);
    for (const row of rows) {
      if (!resolveField(view, row, "key")) continue;
      const key = markKey(view.id, cell(row[resolveField(view, row, "key")]));
      cards.push(rowToCard(view, row, marks[key], codeToUser));
    }
  }
  return { cards, errors, codeToUser };
}

function taskViewsFor(user) {
  if (!user.companies.includes("SOI Aviation")) return [];
  return allViews().filter((v) => v.tasks && inDepartment(user, v.department));
}

// Regular users only see cards that are on them: assigned to them, or done
// by them in Pentagon (matched through their Pentagon code).
function canSeeCard(user, card) {
  if (isManager(user)) return true;
  if (sameUser(card.owner, user.username) || sameUser(card.assignee, user.username)) return true;
  return !!user.pentagonCode && sameUser(card.pentagonUser, user.pentagonCode);
}

app.get(
  "/api/pentagon-views",
  authMiddleware,
  (req, res) => {
    res.json({ views: PENTAGON_VIEWS, guesses: FIELD_GUESSES });
  }
);

app.get(
  "/api/pentagon-tasks",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const views = taskViewsFor(req.user);
    if (!views.length) return res.json({ cards: [], errors: [] });
    const { cards, errors } = await pentagonCards(views);
    res.json({ cards: cards.filter((c) => canSeeCard(req.user, c)), errors });
  })
);

// Per-person counts for the Overview page, managers only. People appear here
// when "Show in team breakdown" is ticked on their login in /admin.html.
app.get(
  "/api/team-breakdown",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isManager(req.user)) {
      return res.status(403).json({ error: "Managers only" });
    }
    const users = (await getUsers()).map(normalizeUser).filter((u) => u.breakdown);
    const views = taskViewsFor(req.user);
    const [{ cards, errors }, tasks] = await Promise.all([
      views.length ? pentagonCards(views) : { cards: [], errors: [] },
      getTasks(),
    ]);
    const soiTasks = tasks.filter((t) => taskCompany(t) === "SOI Aviation");
    const departments = {};
    for (const [department, deptViews] of Object.entries(PENTAGON_VIEWS)) {
      const taskViews = deptViews.filter((v) => v.tasks && views.some((x) => x.id === v.id));
      if (!taskViews.length) continue;
      departments[department] = {
        columns: taskViews.map((v) => ({ id: v.id, label: v.label })).concat([{ id: "tasks", label: "Tasks created" }]),
        people: users.map((u) => {
          const counts = {};
          for (const v of taskViews) {
            // Counted by who did it in Pentagon (their Pentagon code).
            counts[v.id] = cards.filter((c) => c.view === v.id && sameUser(c.createdBy, u.username)).length;
          }
          counts.tasks = soiTasks.filter((t) => t.department === department && sameUser(t.createdBy, u.username)).length;
          return { username: u.username, pentagonCode: u.pentagonCode, counts };
        }),
      };
    }
    res.json({ departments, errors, windowNote: "Pentagon counts cover what each query returns (by default the last 14 days)." });
  })
);

// ---------- Calendars ----------
// "Your calendar": the signed-in person's own Outlook events, read-only,
// looked up by the email on their login (never one from the browser).
// "Shared calendar": one Outlook "Publish to web" link set in /admin.html.

app.get(
  "/api/calendar/me",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 45);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || "") ? req.query.start : null;
    const users = await getUsers();
    const u = users.find((x) => sameUser(x.username, req.user.username));
    try {
      res.json(await eventsBetween(u && u.email, start, days));
    } catch (err) {
      if (err instanceof CalendarError) return res.status(409).json({ error: err.message, code: err.code });
      throw err;
    }
  })
);

// Work inbox: unread Outlook mail (last 1–14 days), one card per
// conversation, Outlook's preview text, no AI. Always the email on the
// person's login, plus any shared mailboxes an admin added to it ("Extra
// inboxes" in /admin.html) — never a mailbox named by the browser. Each item
// says which mailbox it's from; items from extra mailboxes get ids prefixed
// with the mailbox so "Done" ticks don't collide.
app.get(
  "/api/inbox",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 3, 1), 14);
    const u = (await getUsers()).map(normalizeUser).find((x) => sameUser(x.username, req.user.username));
    const own = u && u.email ? u.email.toLowerCase() : "";
    try {
      const mine = await unreadThreads(own, days); // problems with your own mailbox stop here
      const items = mine.items.map((t) => Object.assign({}, t, { mailbox: own }));
      const errors = [];
      const extras = (u.extraMailboxes || []).filter((m) => m.split("@")[1] === own.split("@")[1]);
      const results = await Promise.allSettled(extras.map((m) => unreadThreads(m, days)));
      results.forEach((r, i) => {
        const box = extras[i];
        if (r.status === "fulfilled") r.value.items.forEach((t) => items.push(Object.assign({}, t, { id: `${box}|${t.id}`, mailbox: box })));
        else {
          const code = r.reason instanceof MailError ? r.reason.code : "";
          const why = code === "not_found" ? `There's no Microsoft 365 mailbox called ${box}.`
            : code === "no_permission" ? `The tracker isn't allowed to read ${box}. If Mail.Read is limited to certain mailboxes, add this one to that access policy.`
            : "Couldn't read this mailbox right now.";
          errors.push({ mailbox: box, error: why });
        }
      });
      items.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
      res.json({ mailbox: own, mailboxes: [own, ...extras], days, since: mine.since, items, errors });
    } catch (err) {
      if (err instanceof MailError) return res.status(409).json({ error: err.message, code: err.code });
      throw err;
    }
  })
);

// Who's in office this week, for Leadership. Status only (in / out / remote,
// with times for part of a day) — never event titles or details. Covers
// every login with an email in the companies the viewer can see.
app.get(
  "/api/calendar/whos-in",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const users = (await getUsers()).map(normalizeUser);
    const viewer = users.find((x) => sameUser(x.username, req.user.username));
    if (!viewer || !viewer.leadership) {
      return res.status(403).json({ error: "Who's in office is for leadership logins only" });
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || "") ? req.query.week : new Date().toISOString().slice(0, 10);
    const people = users
      .filter((u) => u.companies.some((c) => req.user.companies.includes(c)))
      .sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()))
      .map((u) => ({ username: u.username, email: u.email || "", calendarNames: u.calendarNames || [] }));
    const settings = await getSettings();
    const shared = settings.sharedCalendar || {};
    try {
      const data = await whosIn(people, shared.ics || "", date);
      // Each person's company, for the coloured initials.
      const lists = calPeopleLists(settings);
      for (const p of data.people) {
        const login = p.hrOnly ? null : users.find((u) => u.username === p.username);
        const names = login ? [p.username, ...(login.calendarNames || [])] : [p.username];
        // A name or nickname on a list wins; then the login's company; else SOI.
        const listed = names.map((n) => companyForName(n, lists, null)).filter((t) => t.listed);
        const clear = listed.find((t) => t.company);
        Object.assign(p, clear || (listed.length ? { company: "", ambiguous: true } : companyForName("", {}, login)));
      }
      data.colors = calColors(settings);
      res.json(data);
    } catch (err) {
      if (err instanceof CalendarError) return res.status(409).json({ error: err.message, code: err.code });
      throw err;
    }
  })
);

// The HR calendar's entries from its ICS feed, for the HR tab's List / Month
// views. Leadership only; the feed link itself never reaches the browser.
app.get(
  "/api/calendar/hr",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const users = await getUsers();
    const u = users.find((x) => sameUser(x.username, req.user.username));
    if (!u || !u.leadership) {
      return res.status(403).json({ error: "The HR calendar is for leadership logins only" });
    }
    const settings = await getSettings();
    const shared = settings.sharedCalendar || {};
    if (!shared.ics) return res.status(409).json({ error: "No HR calendar feed is set yet.", code: "no_feed" });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 45);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || "") ? req.query.start : new Date().toISOString().slice(0, 10);
    // A day of slack either side so local-time days at the edges are complete.
    const from = new Date(Date.parse(`${start}T00:00:00Z`) - 24 * 3600 * 1000);
    const to = new Date(from.getTime() + (days + 2) * 24 * 3600 * 1000);
    try {
      const lists = calPeopleLists(settings), logins = users.map(normalizeUser);
      const events = (await hrEvents(shared.ics, from, to)).map((e) => Object.assign({}, e, tagHrEvent(e, lists, logins)));
      res.json({ events, colors: calColors(settings) });
    } catch (err) {
      if (err instanceof FeedError) return res.status(409).json({ error: err.message, code: err.code });
      throw err;
    }
  })
);

// ---------- HR calendar: company colours and holidays ----------
// Each HR calendar entry is tagged with the company of the person in it
// (from the name lists set in /admin.html, then logins' own company; anyone
// else is SOI) and whether it's a holiday / closure. A first name that's on
// two companies' lists stays untagged — full names tell them apart.
// "Global" is for people who work across all four companies.
const CAL_COMPANIES = ["SOI", "CAS", "RedSun", "NanoTech", "Global"];
const CAL_DEFAULT_COLORS = { SOI: "#354936", CAS: "#2f6fb0", RedSun: "#c0392b", NanoTech: "#7b4fa3", Global: "#1f8a8a", holiday: "#c9a35c" };
const HOLIDAY_RE = /\b(holiday|holidays|public holiday|bank holiday|closed|closure|office closed|labou?r day|christmas|xmas|boxing day|new year'?s?|thanksgiving|easter|good friday|anzac|waitangi|matariki|king'?s birthday|queen'?s birthday|diwali|deepavali|hari raya|chinese new year|lunar new year|national day|vesak|independence day|memorial day|veterans day|juneteenth|presidents'? day|mlk|martin luther king|columbus day|indigenous peoples|early may|spring bank|summer bank)\b/i;

const AWAY_RE = /\b(ooo|out|off|pto|leave|sick|vacation|annual leave|travel(?:ing|ling)?|trip|away|absent|bereavement|jury|remote|wfh|work(?:ing)? from home|working elsewhere|half day|appointment|appt)\b/i;
function calColors(settings) {
  const c = Object.assign({}, CAL_DEFAULT_COLORS, settings.companyColors || {});
  for (const k of Object.keys(c)) if (!/^#[0-9a-f]{6}$/i.test(c[k])) c[k] = CAL_DEFAULT_COLORS[k];
  return c;
}
function calPeopleLists(settings) {
  const p = settings.calendarPeople || {};
  return Object.fromEntries(CAL_COMPANIES.map((k) => [k, Array.isArray(p[k]) ? p[k] : []]));
}
function companyInTitle(subject) {
  const s = String(subject || "");
  if (/\bCAS\b/.test(s)) return "CAS";
  if (/red\s?sun/i.test(s)) return "RedSun";
  if (/nano\s?tech/i.test(s)) return "NanoTech";
  if (/\bSOI\b/.test(s)) return "SOI";
  return "";
}
/** { company, holiday, ambiguous } for one HR calendar entry. */
function tagHrEvent(e, lists, logins) {
  const subject = String(e.subject || "");
  const holiday = HOLIDAY_RE.test(subject);
  const named = companyInTitle(subject);
  if (holiday || named) return { company: named, holiday, ambiguous: false };
  // Only entries about someone being away (OOO, PTO, WFH…) belong to a
  // person; meetings and the like stay uncoloured.
  if (!AWAY_RE.test(subject)) return { company: "", holiday: false, ambiguous: false };
  const name = nameFromTitle(subject).toLowerCase();
  if (!name) return { company: "", holiday: false, ambiguous: false };
  const login = logins.find((u) => [u.username, ...(u.calendarNames || [])].some((n) => { const l = String(n || "").toLowerCase(); return l === name || l === name.split(" ")[0]; }));
  return Object.assign({ holiday: false }, companyForName(name, lists, login));
}
/**
 * A person's company: 1. their full name on a list (SOI, CAS, Red Sun,
 * Nanotech or Global), 2. their first name on exactly one list (two lists =
 * ambiguous), 3. their login's company, 4. otherwise SOI.
 */
function companyForName(name, lists, login) {
  const n = String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
  const first = n.split(" ")[0];
  const full = Object.keys(lists).filter((k) => lists[k].includes(n));
  if (full.length === 1) return { company: full[0], ambiguous: false, listed: true };
  const byFirst = Object.keys(lists).filter((k) => lists[k].some((x) => x === first || x.split(" ")[0] === first));
  if (byFirst.length > 1) return { company: "", ambiguous: true, listed: true };
  if (byFirst.length === 1) return { company: byFirst[0], ambiguous: false, listed: true };
  if (login) return { company: COMPANY_ENTITY[(login.companies || [])[0]] || "SOI", ambiguous: false };
  return { company: "SOI", ambiguous: false };
}

app.get(
  "/api/admin/calendar-colors",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const s = await getSettings();
    res.json({ colors: calColors(s), people: calPeopleLists(s) });
  })
);
app.put(
  "/api/admin/calendar-colors",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const colors = {};
    for (const k of [...CAL_COMPANIES, "holiday"]) {
      const v = String((b.colors || {})[k] || CAL_DEFAULT_COLORS[k]);
      if (!/^#[0-9a-f]{6}$/i.test(v)) return res.status(400).json({ error: `${k}: pick a colour` });
      colors[k] = v.toLowerCase();
    }
    const people = {};
    for (const k of CAL_COMPANIES) {
      const raw = (b.people || {})[k];
      people[k] = [...new Set((Array.isArray(raw) ? raw : String(raw || "").split(/[,\n;]+/))
        .map((n) => String(n).trim().toLowerCase().replace(/\s+/g, " ")).filter((n) => n.length >= 2))].slice(0, 300);
    }
    await withSettings((s) => { s.companyColors = colors; s.calendarPeople = people; });
    // First names on more than one list, so the page can say so.
    const firsts = {};
    for (const [k, names] of Object.entries(people)) for (const n of names) if (!n.includes(" ")) (firsts[n] = firsts[n] || new Set()).add(k);
    const clashes = Object.entries(firsts).filter(([, v]) => v.size > 1).map(([n, v]) => ({ name: n, companies: [...v] }));
    res.json({ colors, people, clashes });
  })
);

// Outlook "Publish to web" HTML links only, so the embed can't point anywhere else.
function cleanSharedCalendarUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch (e) {
    throw new Error("That isn't a valid link");
  }
  const okHost = ["outlook.office365.com", "outlook.office.com", "outlook.live.com"].includes(url.hostname);
  if (url.protocol !== "https:" || !okHost) {
    throw new Error("Use the Outlook \"Publish to web\" HTML link (it starts with https://outlook.office365.com/)");
  }
  if (/\.ics(\?|$)/i.test(url.pathname)) {
    throw new Error("That's the ICS link — use the HTML link from \"Publish to web\" instead");
  }
  return url.toString();
}

app.get(
  "/api/calendar/shared",
  authMiddleware,
  asyncHandler(async (req, res) => {
    // Leadership only. Checked against the saved login, not the session, so
    // unticking "Leadership" in /admin.html takes effect straight away.
    const users = await getUsers();
    const u = users.find((x) => sameUser(x.username, req.user.username));
    if (!u || !u.leadership) {
      return res.status(403).json({ error: "The HR calendar is for leadership logins only" });
    }
    const settings = await getSettings();
    const shared = settings.sharedCalendar || {};
    // Never the ICS link — only whether there is one.
    res.json({ name: shared.name || "", url: shared.url || "", hasFeed: !!shared.ics });
  })
);

app.get(
  "/api/admin/calendar",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    res.json(settings.sharedCalendar || { name: "", url: "" });
  })
);

app.put(
  "/api/admin/calendar",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    let url;
    try {
      url = cleanSharedCalendarUrl((req.body || {}).url);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const body = req.body || {};
    const name = String(body.name || "").trim().slice(0, 60) || "HR global calendar";
    let ics;
    try {
      ics = cleanFeedUrl(body.ics);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const shared = { name, url, ics };
    await withSettings((settings) => {
      settings.sharedCalendar = shared;
    });
    res.json(shared);
  })
);

// ---------- Quarterly business review (Overview, Leadership) ----------
// The QBR slides as live numbers: Procurement (quoted vs. ordered by
// customer), Purchasing, Warehouse (with rejections) and target attainment.
// Each panel reads a dashboards.qbr_* Transmute query for the quarter's
// dates; any number without a query (or that needs correcting) can be typed
// in for that quarter. Targets are set in /admin.html. Leadership only — it
// includes customer and profit figures.
const QBR_QUERIES = {
  customers: "dashboards.qbr_customers",
  purchasing: "dashboards.qbr_purchasing",
  warehouse: "dashboards.qbr_warehouse",
  rejections: "dashboards.qbr_rejections",
  grossProfit: "dashboards.qbr_gross_profit",
};
const QBR_KEYS = ["quoted", "orders", "conversion", "openPos", "newPos", "avgCycleDays", "receivedNoExt", "receivedWithExt",
  "linesReceived", "supplierOnTime", "linesShipped", "customerOnTime", "rejections", "grossProfit"];
const QBR_NOTES = ["procurement", "purchasing", "warehouse", "targets"];
const qbrCache = new Map(); // quarter -> { at, value }

function quarterRange(q) {
  const m = /^(\d{4})-Q([1-4])$/.exec(q || "");
  if (!m) return null;
  const y = +m[1], n = +m[2];
  const from = `${y}-${String((n - 1) * 3 + 1).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(y, n * 3, 0)); // last day of the quarter
  return { quarter: q, year: y, n, from, to: end.toISOString().slice(0, 10) };
}
function currentQuarter() {
  const d = new Date();
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
const qbrNum = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(String(v).replace(/[$,%\s]/g, "")); return Number.isFinite(n) ? n : null; };
function qbrCol(row, names) {
  if (!row) return null;
  const keys = Object.keys(row);
  for (const n of names) { const k = keys.find((x) => x.toUpperCase() === n); if (k) return row[k]; }
  return null;
}
async function qbrRun(name, range) {
  try {
    const data = await pentagonQuery(name, { params: { date_from: range.from, date_to: range.to }, limit: 500 });
    return { rows: resultRows(data), error: "" };
  } catch (err) {
    // Keep Transmute's own message so the dashboard can show what's wrong.
    return { rows: [], error: err.message.replace(/^Pentagon query "[^"]+" failed /, "").slice(0, 300) };
  }
}
async function qbrCompute(range) {
  const hit = qbrCache.get(range.quarter);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  const entries = await Promise.all(Object.entries(QBR_QUERIES).map(async ([k, name]) => [k, await qbrRun(name, range)]));
  const r = Object.fromEntries(entries);
  const status = Object.fromEntries(entries.map(([k, v]) => [k, { query: QBR_QUERIES[k], ok: !v.error, error: v.error }]));
  const m = {};
  // Procurement: quoted vs. ordered per customer.
  if (!r.customers.error) {
    const cust = r.customers.rows.map((row) => ({
      customer: String(qbrCol(row, ["CUSTOMER", "ACCOUNT_NAME", "NAME"]) || "—"),
      quoted: qbrNum(qbrCol(row, ["QUOTED_VALUE", "QUOTED"])) || 0,
      ordered: qbrNum(qbrCol(row, ["ORDER_VALUE", "ORDERED"])) || 0,
    }));
    m.quoted = cust.reduce((s, c) => s + c.quoted, 0);
    m.orders = cust.reduce((s, c) => s + c.ordered, 0);
    m.conversion = m.quoted ? (m.orders / m.quoted) * 100 : null;
    m.topCustomers = cust.filter((c) => c.ordered > 0).sort((a, b) => b.ordered - a.ordered).slice(0, 10)
      .map((c) => Object.assign(c, { conversion: c.quoted ? (c.ordered / c.quoted) * 100 : null }));
  }
  const one = (k) => (!r[k].error && r[k].rows[0]) || null;
  const p = one("purchasing");
  if (p) Object.assign(m, {
    openPos: qbrNum(qbrCol(p, ["OPEN_POS"])), newPos: qbrNum(qbrCol(p, ["NEW_POS"])), avgCycleDays: qbrNum(qbrCol(p, ["AVG_CYCLE_DAYS"])),
    receivedNoExt: qbrNum(qbrCol(p, ["RECEIVED_NO_EXT"])), receivedWithExt: qbrNum(qbrCol(p, ["RECEIVED_WITH_EXT"])),
  });
  const w = one("warehouse");
  if (w) Object.assign(m, {
    linesReceived: qbrNum(qbrCol(w, ["LINES_RECEIVED"])), supplierOnTime: qbrNum(qbrCol(w, ["SUPPLIER_ON_TIME_PCT"])),
    linesShipped: qbrNum(qbrCol(w, ["LINES_SHIPPED"])), customerOnTime: qbrNum(qbrCol(w, ["CUSTOMER_ON_TIME_PCT"])),
    rejections: qbrNum(qbrCol(w, ["REJECTIONS"])),
  });
  if (!r.rejections.error) {
    m.rejectionList = r.rejections.rows.slice(0, 100).map((row) => ({
      part: String(qbrCol(row, ["PART", "PARTNUMBER", "PN"]) || ""), party: String(qbrCol(row, ["PARTY", "CUSTOMER_SUPPLIER", "ACCOUNT_NAME"]) || ""),
      reason: String(qbrCol(row, ["REASON"]) || ""), date: String(qbrCol(row, ["REJECT_DATE", "DATE"]) || "").slice(0, 10),
    }));
    if (m.rejections == null) m.rejections = m.rejectionList.length;
  }
  const g = one("grossProfit");
  if (g) m.grossProfit = qbrNum(qbrCol(g, ["GROSS_PROFIT"]));
  const value = { metrics: m, status };
  qbrCache.set(range.quarter, { at: Date.now(), value });
  return value;
}
async function qbrTargets() {
  const t = (await getSettings()).qbrTargets || {};
  const n = (v) => (qbrNum(v) && qbrNum(v) > 0 ? qbrNum(v) : null);
  return { procurementQuarter: n(t.procurementQuarter), procurementYear: n(t.procurementYear), purchasingQuarter: n(t.purchasingQuarter), purchasingYear: n(t.purchasingYear) };
}
function leadershipOnly(req, res) {
  if (!req.user.leadership) { res.status(403).json({ error: "The quarterly review is for leadership logins" }); return false; }
  return true;
}

app.get(
  "/api/qbr",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!leadershipOnly(req, res)) return;
    const range = quarterRange(req.query.quarter || currentQuarter());
    if (!range) return res.status(400).json({ error: "Quarter looks like 2026-Q3" });
    if (req.query.fresh === "1") qbrCache.delete(range.quarter); // "Check again"
    const [computed, doc, targets] = await Promise.all([qbrCompute(range), getQbr(), qbrTargets()]);
    const saved = ((doc.quarters || {})[range.quarter]) || {};
    res.json(Object.assign({ range, targets, overrides: saved.overrides || {}, notes: saved.notes || {}, manualRejections: saved.rejections || [] }, computed));
  })
);
// Type in / correct a number, write a note, or keep a manual rejections list.
app.put(
  "/api/qbr/:quarter",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!leadershipOnly(req, res)) return;
    const range = quarterRange(req.params.quarter);
    if (!range) return res.status(400).json({ error: "Quarter looks like 2026-Q3" });
    const out = await qbrUpdate(range, req.body || {}, QBR_KEYS, QBR_NOTES, req.user);
    if (out.error) return res.status(400).json(out);
    res.json(out);
  })
);

// Save typed-in numbers / notes / manual rejections — only the given keys.
function qbrUpdate(range, b, keys, notes, user) {
  return withQbr((doc) => {
    doc.quarters = doc.quarters || {};
    const q = (doc.quarters[range.quarter] = doc.quarters[range.quarter] || {});
    q.overrides = q.overrides || {}; q.notes = q.notes || {};
    for (const [k, v] of Object.entries(b.overrides || {})) {
      if (!keys.includes(k)) continue;
      if (v === null || v === "") delete q.overrides[k];
      else { const n = qbrNum(v); if (n === null) return { error: `${k}: enter a number` }; q.overrides[k] = n; }
    }
    for (const [k, v] of Object.entries(b.notes || {})) if (notes.includes(k)) q.notes[k] = String(v || "").slice(0, 3000);
    if (Array.isArray(b.rejections)) q.rejections = b.rejections.slice(0, 100).map((x) => ({
      part: String(x.part || "").slice(0, 120), party: String(x.party || "").slice(0, 120), reason: String(x.reason || "").slice(0, 400), date: /^\d{4}-\d{2}-\d{2}$/.test(x.date || "") ? x.date : "",
    })).filter((x) => x.part || x.reason);
    q.updatedAt = Date.now(); q.updatedBy = user.username;
    return { ok: true };
  });
}

// Warehouse → Insights: just the warehouse panel, for the Warehouse
// department (and leadership). Managers can type numbers in and keep the
// rejections list; it's the same data the Overview's review shows.
const QBR_WAREHOUSE_KEYS = ["linesReceived", "supplierOnTime", "linesShipped", "customerOnTime", "rejections"];
function canSeeWarehouseInsights(user) { return !!user.leadership || inDepartment(user, "Warehouse"); }
app.get(
  "/api/qbr-warehouse",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!canSeeWarehouseInsights(req.user)) return res.status(403).json({ error: "Warehouse insights are for the Warehouse department" });
    const range = quarterRange(req.query.quarter || currentQuarter());
    if (!range) return res.status(400).json({ error: "Quarter looks like 2026-Q3" });
    if (req.query.fresh === "1") qbrCache.delete(range.quarter);
    const [computed, doc] = await Promise.all([qbrCompute(range), getQbr()]);
    const saved = ((doc.quarters || {})[range.quarter]) || {};
    const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o && o[k] != null).map((k) => [k, o[k]]));
    res.json({
      range, scope: "warehouse",
      canEdit: isManager(req.user) || !!req.user.leadership,
      metrics: Object.assign(pick(computed.metrics, QBR_WAREHOUSE_KEYS), computed.metrics.rejectionList ? { rejectionList: computed.metrics.rejectionList } : {}),
      status: pick(computed.status, ["warehouse", "rejections"]),
      overrides: pick(saved.overrides || {}, QBR_WAREHOUSE_KEYS),
      notes: pick(saved.notes || {}, ["warehouse"]),
      manualRejections: saved.rejections || [],
    });
  })
);
app.put(
  "/api/qbr-warehouse/:quarter",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!canSeeWarehouseInsights(req.user) || !(isManager(req.user) || req.user.leadership)) return res.status(403).json({ error: "Only managers can change warehouse insights" });
    const range = quarterRange(req.params.quarter);
    if (!range) return res.status(400).json({ error: "Quarter looks like 2026-Q3" });
    const out = await qbrUpdate(range, req.body || {}, QBR_WAREHOUSE_KEYS, ["warehouse"], req.user);
    if (out.error) return res.status(400).json(out);
    res.json(out);
  })
);
app.get("/api/admin/qbr-targets", adminMiddleware, asyncHandler(async (req, res) => res.json(await qbrTargets())));
app.put(
  "/api/admin/qbr-targets",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {}, t = {};
    for (const k of ["procurementQuarter", "procurementYear", "purchasingQuarter", "purchasingYear"]) {
      if (b[k] === "" || b[k] == null) { t[k] = null; continue; }
      const n = qbrNum(b[k]);
      if (n === null || n < 0) return res.status(400).json({ error: `${k}: enter an amount` });
      t[k] = n;
    }
    await withSettings((s) => { s.qbrTargets = t; });
    qbrCache.clear();
    res.json(t);
  })
);

// ---------- Performance ----------
// HR's Global Performance Management Escalation Process, as a quick-view
// tracker for the CEO and Leadership (PerformYard stays the system of
// record). Only logins with "Performance access" ticked in /admin.html can
// see any of it — checked against the saved login on every request.
//
// People: anyone with "Show in team breakdown", anyone added by hand — with
// or without a tracker login (other domains), by name or initials.
// Notes: factual, dated (incident + received), with whether the employee
// was told, whether it's in PerformYard, and a serious-misconduct option.
// A note counts only if the employee was told, it isn't misconduct (that
// has its own process), and the incident is inside the rolling window.
// Stages: verbal warning → written warning → PIP → PIP outcome review.
// Enough countable notes since the last step makes a *review due*; a step
// is only ever recorded by a person, never automatically. Termination is
// not a stage: it always needs HR and legal review. Counts and the window
// are admin settings (HR's numbers are placeholders).
const PERF_TEXT = 5000;
const PERF_STAGES = ["verbal", "written", "pip", "pip_review"];
const PERF_STAGE_LABEL = { none: "No formal step", verbal: "Verbal warning", written: "Written warning", pip: "Performance Improvement Plan", pip_review: "PIP outcome review" };
const PERF_ENTITIES = ["SOI", "CAS", "RedSun", "NanoTech"];
const COMPANY_ENTITY = { "SOI Aviation": "SOI", CAS: "CAS", "RedSun Aviation": "RedSun", "NanoTech Aviation": "NanoTech" };
const PERF_RISKS = ["leave", "medical", "complaint", "grievance", "parental", "service", "claims"];
const PERF_FILE_TYPES = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword", xls: "application/vnd.ms-excel", txt: "text/plain", csv: "text/csv", msg: "application/vnd.ms-outlook", eml: "message/rfc822",
};
const PERF_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function hasPerformance(user) {
  const u = (await getUsers()).find((x) => sameUser(x.username, user.username));
  return !!(u && u.performance);
}
const performanceOnly = asyncHandler(async (req, res, next) => {
  if (!(await hasPerformance(req.user))) return res.status(403).json({ error: "Performance is private" });
  next();
});
async function perfSettings() {
  const s = (await getSettings()).performance || {};
  const n = (v, d, lo, hi) => { const x = parseInt(v, 10); return x >= lo && x <= hi ? x : d; };
  return { windowMonths: n(s.windowMonths, 12, 1, 36), verbal: n(s.verbal, 3, 1, 20), written: n(s.written, 2, 1, 20), pip: n(s.pip, 2, 1, 20) };
}
function perfShape(doc) { doc.people = doc.people && typeof doc.people === "object" ? doc.people : {}; return doc; }
// Older entries (from the first version) were "warnings" with just text:
// they become notes that don't count until someone reviews them.
function perfEntry(e) {
  if (e.kind === "warning") {
    return Object.assign({}, e, { kind: "note", legacyWarning: true, told: !!e.told, incidentDate: e.incidentDate || new Date(e.at).toISOString().slice(0, 10), receivedDate: e.receivedDate || new Date(e.at).toISOString().slice(0, 10) });
  }
  return Object.assign({ incidentDate: new Date(e.at || Date.now()).toISOString().slice(0, 10), receivedDate: new Date(e.at || Date.now()).toISOString().slice(0, 10) }, e);
}
function perfRecord(doc, key) {
  const p = (doc.people[key] = doc.people[key] || {});
  p.entries = Array.isArray(p.entries) ? p.entries : [];
  p.files = Array.isArray(p.files) ? p.files : [];
  p.steps = Array.isArray(p.steps) ? p.steps : [];
  p.risk = p.risk && typeof p.risk === "object" ? p.risk : {};
  return p;
}
function addMonths(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }

/** Where someone is on the ladder, and whether a review is due. */
function perfStatus(p, settings, today) {
  const entries = (p.entries || []).map(perfEntry);
  const steps = (p.steps || []).filter((s) => !s.undone).sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.at || 0) - (b.at || 0));
  const last = steps[steps.length - 1];
  const stage = last ? last.stage : "none";
  const next = PERF_STAGES[stage === "none" ? 0 : PERF_STAGES.indexOf(stage) + 1] || null;
  const windowStart = addMonths(today, -settings.windowMonths);
  const live = entries.filter((e) => e.kind === "note" && !e.misconduct && e.incidentDate >= windowStart);
  const countable = live.filter((e) => e.told && (!last || e.incidentDate > last.date));
  const notTold = live.filter((e) => !e.told);
  const threshold = next && next !== "pip_review" ? settings[next] : null;
  const risks = PERF_RISKS.filter((r) => p.risk && p.risk[r]);
  return {
    stage, stageLabel: PERF_STAGE_LABEL[stage], stageDate: last ? last.date : "",
    next, nextLabel: next ? PERF_STAGE_LABEL[next] : "",
    countable: countable.length, threshold,
    reviewDue: threshold != null ? countable.length >= threshold : stage === "pip",
    afterLadder: stage === "pip_review",
    notTold: notTold.length,
    misconduct: entries.filter((e) => e.misconduct && !e.misconductClosed).length,
    notInPerformYard: entries.filter((e) => e.kind === "note" && !e.inPerformYard).length,
    legacy: entries.filter((e) => e.legacyWarning && !e.reviewed).length,
    risks, needsHrReview: risks.length > 0,
    windowStart,
  };
}

// People on the list. Keys are login usernames, or "x-…" for people
// without a login.
function perfPeople(users, doc) {
  const out = [];
  const byName = new Map(users.map((u) => [u.username, u]));
  for (const u of users) {
    const p = doc.people[u.username] || {};
    if (p.hidden) continue;
    if (u.breakdown || p.manual || (p.entries || []).length || (p.steps || []).length) out.push({ key: u.username, name: u.username, login: true, user: u, rec: p });
  }
  for (const [key, p] of Object.entries(doc.people)) {
    if (!key.startsWith("x-") || p.hidden || byName.has(key)) continue;
    out.push({ key, name: p.name || key, login: false, user: null, rec: p });
  }
  return out;
}
function entityOf(person) {
  if (person.rec && PERF_ENTITIES.includes(person.rec.entity)) return person.rec.entity;
  const co = person.user && (person.user.companies || [])[0];
  return COMPANY_ENTITY[co] || "SOI";
}
async function perfFind(key) {
  const users = (await getUsers()).map(normalizeUser);
  const doc = perfShape(await getPerformance());
  return perfPeople(users, doc).find((x) => x.key === key) ||
    (users.find((u) => u.username === key) ? { key, name: key, login: true, user: users.find((u) => u.username === key), rec: doc.people[key] || {} } : null);
}
function perfOfficeToday() { return officeStamp(new Date().toISOString()).slice(0, 10) || new Date().toISOString().slice(0, 10); }

app.get(
  "/api/performance",
  authMiddleware,
  performanceOnly,
  asyncHandler(async (req, res) => {
    const [users, doc, tasks, settings] = await Promise.all([getUsers(), getPerformance(), getTasks(), perfSettings()]);
    perfShape(doc);
    const all = users.map(normalizeUser);
    const today = perfOfficeToday();
    const list = perfPeople(all, doc);
    const people = list.map((x) => {
      const mine = x.login ? tasks.filter((t) => sameUser(t.owner, x.key)) : [];
      return Object.assign({
        key: x.key, name: x.name, login: x.login, employeeId: x.rec.employeeId || "", entity: entityOf(x),
        departments: x.user ? (x.user.fullAccess ? ["Full access"] : x.user.departments) : [],
        auto: !!(x.user && x.user.breakdown),
        notes: (x.rec.entries || []).length,
        lastAt: (x.rec.entries || []).reduce((m, e) => Math.max(m, e.at || 0), 0),
        openTasks: mine.filter((t) => t.status !== "done").length,
      }, perfStatus(x.rec, settings, today));
    }).sort((a, b) => Number(b.reviewDue) - Number(a.reviewDue) || PERF_STAGES.indexOf(b.stage) - PERF_STAGES.indexOf(a.stage) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const inList = new Set(list.map((x) => x.key));
    res.json({ settings, today, people, others: all.filter((u) => !inList.has(u.username)).map((u) => u.username).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) });
  })
);

app.get(
  "/api/performance/:key",
  authMiddleware,
  performanceOnly,
  asyncHandler(async (req, res) => {
    const x = await perfFind(req.params.key);
    if (!x) return res.status(404).json({ error: "Not on the list" });
    const settings = await perfSettings();
    const p = x.rec || {};
    res.json(Object.assign({
      key: x.key, name: x.name, login: x.login, entity: entityOf(x), employeeId: p.employeeId || "", startDate: p.startDate || "",
      risk: p.risk || {}, riskNotes: p.riskNotes || "", summary: p.summary || "",
      departments: x.user ? (x.user.fullAccess ? ["Full access"] : x.user.departments) : [], auto: !!(x.user && x.user.breakdown),
      entries: (p.entries || []).map(perfEntry).sort((a, b) => String(b.incidentDate).localeCompare(String(a.incidentDate)) || (b.at || 0) - (a.at || 0)),
      steps: (p.steps || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.at || 0) - (a.at || 0)),
      files: p.files || [], settings,
    }, perfStatus(p, settings, perfOfficeToday())));
  })
);

// Add someone: a login ({ username }) or a person without one ({ name, entity }).
app.post(
  "/api/performance/people",
  authMiddleware,
  performanceOnly,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (b.username) {
      const u = (await getUsers()).find((x) => sameUser(x.username, b.username));
      if (!u) return res.status(404).json({ error: "No login by that name" });
      await withPerformance((doc) => { const p = perfRecord(perfShape(doc), u.username); p.manual = true; p.hidden = false; });
      return res.status(201).json({ key: u.username });
    }
    const name = String(b.name || "").trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: "Give a name, initials or employee ID" });
    if (b.entity && !PERF_ENTITIES.includes(b.entity)) return res.status(400).json({ error: "Pick SOI, CAS, Red Sun or Nanotech" });
    const key = "x-" + newId();
    await withPerformance((doc) => { const p = perfRecord(perfShape(doc), key); Object.assign(p, { name, entity: b.entity || "SOI", manual: true, hidden: false, addedAt: Date.now(), addedBy: req.user.username }); });
    res.status(201).json({ key });
  })
);
app.delete(
  "/api/performance/people/:key",
  authMiddleware,
  performanceOnly,
  asyncHandler(async (req, res) => {
    const x = await perfFind(req.params.key);
    if (!x) return res.status(404).json({ error: "Not on the list" });
    await withPerformance((doc) => { const p = perfRecord(perfShape(doc), x.key); p.manual = false; p.hidden = true; });
    res.status(204).end();
  })
);

// Profile: entity, employee ID / initials, start date, risk factors.
app.put(
  "/api/performance/:key/profile",
  authMiddleware,
  performanceOnly,
  asyncHandler(async (req, res) => {
    const x = await perfFind(req.params.key);
    if (!x) return res.status(404).json({ error: "Not on the list" });
    const b = req.body || {};
    if ("entity" in b && !PERF_ENTITIES.includes(b.entity)) return res.status(400).json({ error: "Pick SOI, CAS, Red Sun or Nanotech" });
    if ("startDate" in b && b.startDate && !PERF_DATE.test(b.startDate)) return res.status(400).json({ error: "Bad start date" });
    const out = await withPerformance((doc) => {
      const p = perfRecord(perfShape(doc), x.key);
      if ("entity" in b) p.entity = b.entity;
      if ("employeeId" in b) p.employeeId = String(b.employeeId || "").trim().slice(0, 40);
      if ("name" in b && !x.login) p.name = String(b.name || "").trim().slice(0, 80) || p.name;
      if ("startDate" in b) p.startDate = b.startDate || "";
      if (b.risk && typeof b.risk === "object") for (const r of PERF_RISKS) if (r in b.risk) p.risk[r] = !!b.risk[r];
      if ("riskNotes" in b) p.riskNotes = String(b.riskNotes || "").slice(0, 2000);
      if ("summary" in b) p.summary = String(b.summary || "").slice(0, PERF_TEXT);
      p.updatedAt = Date.now(); p.updatedBy = req.user.username;
      return { ok: true };
    });
    res.json(out);
  })
);

function cleanNote(b, base) {
  const e = Object.assign({}, base || {});
  if ("text" in b) e.text = String(b.text || "").trim().slice(0, PERF_TEXT);
  for (const k of ["incidentDate", "receivedDate", "toldDate"]) if (k in b) e[k] = PERF_DATE.test(b[k] || "") ? b[k] : "";
  for (const k of ["told", "inPerformYard", "misconduct", "misconductClosed", "reviewed"]) if (k in b) e[k] = !!b[k];
  if ("from" in b) e.from = String(b.from || "").trim().slice(0, 120);
  return e;
}
app.post(
  "/api/performance/:key/entries",
  authMiddleware,
  performanceOnly,
  asyncHandler(async (req, res) => {
    const x = await perfFind(req.params.key);
    if (!x) return res.status(404).json({ error: "Not on the list" });
    const today = perfOfficeToday();
    const e = cleanNote(req.body || {}, { id: newId(), kind: "note", at: Date.now(), by: req.user.username, incidentDate: today, receivedDate: today });
    if (!e.text) return res.status(400).json({ error: "Describe what happened" });
    if (!e.incidentDate) return res.status(400).json({ error: "Give the date of the incident" });
    if (e.incidentDate > today) return res.status(400).json({ error: "The incident date can't be in the future" });
    await withPerformance((doc) => { const p = perfRecord(perfShape(doc), x.key); p.entries.push(e); p.hidden = false; });
    res.status(201).json(e);
  })
);
app.patch(
  "/api/performance/:key/entries/:id",
  authMiddleware,
  performanceOnly,
  asyncHandler(async (req, res) => {
    const x = await perfFind(req.params.key);
    if (!x) return res.status(404).json({ error: "Not on the list" });
    const out = await withPerformance((doc) => {
      const p = perfRecord(perfShape(doc), x.key);
      const i = p.entries.findIndex((y) => y.id === req.params.id);
      if (i === -1) return null;
      const before = perfEntry(p.entries[i]);
      const e = cleanNote(req.body || {}, before);
      if (!e.text) return { error: "Text can't be empty" };
      if (!e.incidentDate) return { error: "Give the date of the incident" };
      delete e.kind; e.kind = "note";
      if (before.legacyWarning) { e.legacyWarning = true; if ("told" in (req.body || {}) || "reviewed" in (req.body || {})) e.reviewed = true; }
      e.editedAt = Date.now(); e.editedBy = req.user.username;
      p.entries[i] = e;
      return Object.assign({}, e);
    });
    if (!out) return res.status(404).json({ error: "That note isn't here any more" });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  })
);
app.delete(
  "/api/performance/:key/entries/:id",
  authMiddleware,
  performanceOnly,
  asyncHandler(async (req, res) => {
    const x = await perfFind(req.params.key);
    if (!x) return res.status(404).json({ error: "Not on the list" });
    const out = await withPerformance((doc) => {
      const p = perfRecord(perfShape(doc), x.key);
      const i = p.entries.findIndex((y) => y.id === req.params.id);
      if (i === -1) return null;
      const [gone] = p.entries.splice(i, 1);
      const files = p.files.filter((f) => f.entryId === gone.id);
      p.files = p.files.filter((f) => f.entryId !== gone.id);
      return { files };
    });
    if (!out) return res.status(404).json({ error: "That note isn't here any more" });
    await Promise.all(out.files.map((f) => deleteFile(`performance_files/${f.id}`).catch(() => {})));
    res.status(204).end();
  })
);

// Record a step (always a person's decision). Only the next stage in order.
// With any risk factor ticked, HR / legal review must be confirmed.
app.post(
  "/api/performance/:key/steps",
  authMiddleware,
  performanceOnly,
  asyncHandler(async (req, res) => {
    const x = await perfFind(req.params.key);
    if (!x) return res.status(404).json({ error: "Not on the list" });
    const b = req.body || {};
    const settings = await perfSettings();
    const st = perfStatus(x.rec || {}, settings, perfOfficeToday());
    if (!st.next || b.stage !== st.next) return res.status(400).json({ error: st.next ? `The next step is ${st.nextLabel}` : "The ladder is complete — anything further needs HR and legal review" });
    if (!PERF_DATE.test(b.date || "")) return res.status(400).json({ error: "Give the date of the step" });
    const reason = String(b.reason || "").trim().slice(0, 2000);
    if (!reason) return res.status(400).json({ error: "Say briefly why (the notes it's based on)" });
    if (st.needsHrReview && !b.hrReviewed) return res.status(400).json({ error: "Risk factors are ticked — confirm HR / legal have reviewed this first" });
    const step = { id: newId(), stage: b.stage, date: b.date, reason, hrReviewed: !!b.hrReviewed, inPerformYard: !!b.inPerformYard, at: Date.now(), by: req.user.username };
    await withPerformance((doc) => { const p = perfRecord(perfShape(doc), x.key); p.steps.push(step); p.hidden = false; });
    res.status(201).json(step);
  })
);
// Edit a recorded step's description, or tick it as in PerformYard.
app.patch(
  "/api/performance/:key/steps/:id",
  authMiddleware,
  performanceOnly,
  asyncHandler(async (req, res) => {
    const x = await perfFind(req.params.key);
    if (!x) return res.status(404).json({ error: "Not on the list" });
    const b = req.body || {};
    const out = await withPerformance((doc) => {
      const st = perfRecord(perfShape(doc), x.key).steps.find((y) => y.id === req.params.id);
      if (!st) return null;
      if ("reason" in b) { const r = String(b.reason || "").trim().slice(0, 2000); if (!r) return { error: "The description can't be empty" }; st.reason = r; }
      if ("inPerformYard" in b) st.inPerformYard = !!b.inPerformYard;
      st.editedAt = Date.now(); st.editedBy = req.user.username;
      return Object.assign({}, st);
    });
    if (!out) return res.status(404).json({ error: "That step isn't here any more" });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  })
);

// Undo the latest step (kept in the history, marked undone, with a reason).
app.post(
  "/api/performance/:key/steps/:id/undo",
  authMiddleware,
  performanceOnly,
  asyncHandler(async (req, res) => {
    const x = await perfFind(req.params.key);
    if (!x) return res.status(404).json({ error: "Not on the list" });
    const out = await withPerformance((doc) => {
      const p = perfRecord(perfShape(doc), x.key);
      const live = p.steps.filter((s) => !s.undone).sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.at || 0) - (b.at || 0));
      const last = live[live.length - 1];
      if (!last || last.id !== req.params.id) return { error: "Only the latest step can be undone" };
      last.undone = { at: Date.now(), by: req.user.username, reason: String((req.body || {}).reason || "").trim().slice(0, 500) };
      return { ok: true };
    });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  })
);

// Attachments (up to 15 MB): documents, images, emails. Always downloaded,
// never shown in the page.
app.post(
  "/api/performance/:key/files",
  authMiddleware,
  performanceOnly,
  express.raw({ type: () => true, limit: "15mb" }),
  asyncHandler(async (req, res) => {
    const x = await perfFind(req.params.key);
    if (!x) return res.status(404).json({ error: "Not on the list" });
    const name = String(req.query.name || "file").replace(/[\\/\r\n"]+/g, "_").slice(0, 160);
    const ext = (name.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    const type = ext && PERF_FILE_TYPES[ext.toLowerCase()];
    if (!type) return res.status(400).json({ error: "Attach a PDF, image, Word, Excel, PowerPoint, text or email file" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file came through" });
    const file = { id: newId(), name, type, size: req.body.length, at: Date.now(), by: req.user.username, entryId: String(req.query.entryId || "").slice(0, 40) };
    await putFile(`performance_files/${file.id}`, req.body, type);
    await withPerformance((doc) => { const p = perfRecord(perfShape(doc), x.key); p.files.push(file); p.hidden = false; });
    res.status(201).json(file);
  })
);
app.get(
  "/api/performance/:key/files/:id",
  authMiddleware,
  performanceOnly,
  asyncHandler(async (req, res) => {
    const x = await perfFind(req.params.key);
    const meta = x && (x.rec.files || []).find((f) => f.id === req.params.id);
    if (!meta) return res.status(404).json({ error: "That file isn't here" });
    const file = await getFile(`performance_files/${meta.id}`);
    if (!file) return res.status(404).json({ error: "The file is missing" });
    res.set({ "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${meta.name.replace(/[^\w .()-]+/g, "_")}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    res.send(file.body);
  })
);
app.delete(
  "/api/performance/:key/files/:id",
  authMiddleware,
  performanceOnly,
  asyncHandler(async (req, res) => {
    const x = await perfFind(req.params.key);
    if (!x) return res.status(404).json({ error: "Not on the list" });
    const gone = await withPerformance((doc) => {
      const p = perfRecord(perfShape(doc), x.key);
      const i = p.files.findIndex((f) => f.id === req.params.id);
      return i === -1 ? null : p.files.splice(i, 1)[0];
    });
    if (!gone) return res.status(404).json({ error: "That file isn't here" });
    await deleteFile(`performance_files/${gone.id}`).catch(() => {});
    res.status(204).end();
  })
);

// Escalation settings (admin page).
app.get("/api/admin/performance", adminMiddleware, asyncHandler(async (req, res) => res.json(await perfSettings())));
app.put(
  "/api/admin/performance",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const ok = (v, lo, hi) => Number.isInteger(+v) && +v >= lo && +v <= hi;
    if (!ok(b.windowMonths, 1, 36) || !ok(b.verbal, 1, 20) || !ok(b.written, 1, 20) || !ok(b.pip, 1, 20)) return res.status(400).json({ error: "Window is 1–36 months; counts are 1–20" });
    const v = { windowMonths: +b.windowMonths, verbal: +b.verbal, written: +b.written, pip: +b.pip };
    await withSettings((s) => { s.performance = v; });
    res.json(v);
  })
);

// ---------- Department SOPs ----------
// Each department's SOP tab: SOP documents (PDFs, stored privately in S3)
// and "quick answers" — the how-do-we questions people ask when the manager
// is out. Anyone in the department can read; managers add and change.
// dept "*" means every department (e.g. CUST-001 Customer Communication).
const SOP_ALL = "*";
const sopText = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
function sopShape(doc) {
  doc.sops = Array.isArray(doc.sops) ? doc.sops : [];
  doc.qa = Array.isArray(doc.qa) ? doc.qa : [];
  return doc;
}
function sopDeptOk(dept) { return dept === SOP_ALL || DEPARTMENTS.includes(dept); }
function canReadSops(user, dept) { return dept === SOP_ALL || inDepartment(user, dept); }
function newId() { return Date.now().toString(36) + require("crypto").randomBytes(5).toString("hex"); }

app.get(
  "/api/sops",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const dept = String(req.query.dept || "");
    if (!DEPARTMENTS.includes(dept)) return res.status(400).json({ error: "Pick a department" });
    if (!inDepartment(req.user, dept)) return res.status(403).json({ error: "That's not one of your departments" });
    const doc = sopShape(await getSops());
    const mine = (x) => x.dept === dept || x.dept === SOP_ALL;
    res.json({
      dept,
      canEdit: isManager(req.user),
      sops: doc.sops.filter(mine).sort((a, b) => String(a.code || a.title).localeCompare(String(b.code || b.title), undefined, { numeric: true })),
      qa: doc.qa.filter(mine).sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0)),
    });
  })
);

// Upload an SOP PDF (raw bytes; up to 20 MB). Details come in the query
// string: dept, code, title, version, fileName.
app.post(
  "/api/sops",
  authMiddleware,
  express.raw({ type: () => true, limit: "20mb" }),
  asyncHandler(async (req, res) => {
    if (!isManager(req.user)) return res.status(403).json({ error: "Only managers can add SOPs" });
    const dept = String(req.query.dept || "");
    if (!sopDeptOk(dept) || (dept !== SOP_ALL && !inDepartment(req.user, dept))) return res.status(400).json({ error: "Pick one of your departments" });
    if (!Buffer.isBuffer(req.body) || req.body.slice(0, 5).toString() !== "%PDF-") return res.status(400).json({ error: "SOPs need to be PDF files" });
    const id = newId();
    await putFile(`sop_files/${id}`, req.body, "application/pdf");
    const sop = {
      id, dept,
      code: sopText(req.query.code, 30), title: sopText(req.query.title, 160) || "SOP", version: sopText(req.query.version, 30),
      fileName: sopText(req.query.fileName, 200), size: req.body.length,
      uploadedAt: Date.now(), uploadedBy: req.user.username,
    };
    await withSops((doc) => { sopShape(doc).sops.push(sop); });
    res.status(201).json(sop);
  })
);

app.patch(
  "/api/sops/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isManager(req.user)) return res.status(403).json({ error: "Only managers can change SOPs" });
    const b = req.body || {};
    if ("dept" in b && !sopDeptOk(b.dept)) return res.status(400).json({ error: "Bad department" });
    const sop = await withSops((doc) => {
      const x = sopShape(doc).sops.find((y) => y.id === req.params.id);
      if (!x) return null;
      if ("code" in b) x.code = sopText(b.code, 30);
      if ("title" in b) x.title = sopText(b.title, 160) || x.title;
      if ("version" in b) x.version = sopText(b.version, 30);
      if ("dept" in b) x.dept = b.dept;
      x.updatedAt = Date.now();
      return Object.assign({}, x);
    });
    if (!sop) return res.status(404).json({ error: "That SOP isn't here any more" });
    res.json(sop);
  })
);

app.delete(
  "/api/sops/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isManager(req.user)) return res.status(403).json({ error: "Only managers can remove SOPs" });
    const gone = await withSops((doc) => {
      const list = sopShape(doc).sops;
      const i = list.findIndex((y) => y.id === req.params.id);
      if (i === -1) return null;
      for (const q of doc.qa) if (q.sopId === req.params.id) q.sopId = "";
      return list.splice(i, 1)[0];
    });
    if (!gone) return res.status(404).json({ error: "That SOP isn't here any more" });
    await deleteFile(`sop_files/${gone.id}`).catch(() => {});
    res.status(204).end();
  })
);

app.get(
  "/api/sops/:id/file",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const sop = sopShape(await getSops()).sops.find((y) => y.id === req.params.id);
    if (!sop || !canReadSops(req.user, sop.dept)) return res.status(404).json({ error: "That SOP isn't here" });
    const file = await getFile(`sop_files/${sop.id}`);
    if (!file) return res.status(404).json({ error: "The PDF is missing" });
    const name = (sop.fileName || `${sop.code || "SOP"} ${sop.title}.pdf`).replace(/[^\w .()-]+/g, "_");
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${name}"`, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
    res.send(file.body);
  })
);

// Quick answers: add one (or many at once with "items"), change, remove.
function cleanQa(b) {
  return { q: sopText(b.q, 300), a: String(b.a == null ? "" : b.a).trim().slice(0, 5000), sopId: sopText(b.sopId, 40) };
}
app.post(
  "/api/sops/qa",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isManager(req.user)) return res.status(403).json({ error: "Only managers can add answers" });
    const b = req.body || {};
    const dept = String(b.dept || "");
    if (!sopDeptOk(dept) || (dept !== SOP_ALL && !inDepartment(req.user, dept))) return res.status(400).json({ error: "Pick one of your departments" });
    const items = (Array.isArray(b.items) ? b.items : [b]).map(cleanQa).filter((x) => x.q).slice(0, 200);
    if (!items.length) return res.status(400).json({ error: "Write a question" });
    const added = await withSops((doc) => {
      sopShape(doc);
      let order = Math.max(0, ...doc.qa.filter((x) => x.dept === dept).map((x) => x.order || 0));
      const out = items.map((x) => Object.assign({ id: newId(), dept, order: ++order, createdAt: Date.now(), updatedAt: Date.now(), by: req.user.username }, x));
      doc.qa.push(...out);
      return out;
    });
    res.status(201).json({ added });
  })
);
app.patch(
  "/api/sops/qa/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isManager(req.user)) return res.status(403).json({ error: "Only managers can change answers" });
    const b = req.body || {};
    const item = await withSops((doc) => {
      const x = sopShape(doc).qa.find((y) => y.id === req.params.id);
      if (!x) return null;
      const c = cleanQa(Object.assign({}, x, b));
      if (!c.q) return { error: "A question can't be empty" };
      Object.assign(x, c, { updatedAt: Date.now(), by: req.user.username });
      return Object.assign({}, x);
    });
    if (!item) return res.status(404).json({ error: "That answer isn't here any more" });
    if (item.error) return res.status(400).json(item);
    res.json(item);
  })
);
app.delete(
  "/api/sops/qa/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isManager(req.user)) return res.status(403).json({ error: "Only managers can remove answers" });
    const ok = await withSops((doc) => {
      const list = sopShape(doc).qa;
      const i = list.findIndex((y) => y.id === req.params.id);
      if (i === -1) return false;
      list.splice(i, 1);
      return true;
    });
    if (!ok) return res.status(404).json({ error: "That answer isn't here any more" });
    res.status(204).end();
  })
);

// ---------- Default person per department ----------
// A new task with nobody picked goes to its department's default person.

app.get(
  "/api/department-defaults",
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json((await getSettings()).departmentDefaults || {});
  })
);

app.get(
  "/api/admin/department-defaults",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    res.json((await getSettings()).departmentDefaults || {});
  })
);

app.put(
  "/api/admin/department-defaults",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const users = await getUsers();
    const out = {};
    for (const dept of DEPARTMENTS) {
      const wanted = String(body[dept] || "").trim();
      if (!wanted) continue;
      const u = users.find((x) => sameUser(x.username, wanted));
      if (!u) return res.status(400).json({ error: `${dept}: no login called "${wanted}"` });
      out[dept] = u.username;
    }
    await withSettings((settings) => {
      settings.departmentDefaults = out;
    });
    res.json(out);
  })
);

// ---------- Business Development analytics (Pentagon) ----------
// Volume and value of RFQs, Quotes, Sales Orders and Purchase Orders over
// the last 30 or 90 days, by week, by customer and by Pentagon contact —
// built from the same dashboard queries as the department tabs (asked for
// a longer date range). SOI only; Business Development and full access.
const ANALYTICS_VIEWS = ["rfqs", "quotes", "sales_orders", "purchase_orders"];
const ANALYTICS_CACHE_MS = 5 * 60_000;
const analyticsCache = new Map(); // queryName|from -> { at, rows, error }

async function analyticsRows(view, from) {
  const key = `${view.queryName}|${from}`;
  const hit = analyticsCache.get(key);
  if (hit && Date.now() - hit.at < ANALYTICS_CACHE_MS) return hit;
  let entry;
  try {
    const data = await pentagonQuery(view.queryName, { params: { date_from: from, date_to: "", status: "", account_no: "" }, limit: 500 });
    entry = { at: Date.now(), rows: resultRows(data), error: null };
  } catch (err) {
    console.error(`Analytics ${view.queryName} failed: ${err.message}`);
    entry = { at: Date.now(), rows: [], error: /not configured/i.test(err.message) ? "Pentagon isn't connected" : `${view.queryName} didn't run` };
  }
  analyticsCache.set(key, entry);
  return entry;
}

function mondayOfYmd(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

app.get(
  "/api/analytics/business-development",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!req.user.companies.includes("SOI Aviation") || !inDepartment(req.user, "Business Development")) {
      return res.status(403).json({ error: "Business Development analytics aren't available for your account" });
    }
    const days = [30, 90].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const users = (await getUsers()).map(normalizeUser);
    const codeToUser = new Map();
    users.forEach((u) => { if (u.pentagonCode) codeToUser.set(u.pentagonCode.trim().toLowerCase(), u.username); });
    const cell = (v) => (v === null || v === undefined ? "" : String(v));
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

    const views = ANALYTICS_VIEWS.map(viewById).filter(Boolean);
    const results = await Promise.all(views.map((v) => analyticsRows(v, from)));
    const summary = [];
    const weeks = {};      // monday -> { view: { count, value } }
    const customers = {};  // name -> { view: { count, value } }
    const people = {};     // username or code -> { view: count }
    views.forEach((view, i) => {
      const { rows, error } = results[i];
      const sample = rows[0];
      const f = {
        party: resolveField(view, sample, "party"), person: resolveField(view, sample, "person"),
        entered: resolveField(view, sample, "entered"), amount: resolveField(view, sample, "amount"),
      };
      let value = 0;
      for (const row of rows) {
        const amount = f.amount ? num(row[f.amount]) : 0;
        value += amount;
        const day = f.entered ? cell(row[f.entered]).slice(0, 10) : "";
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day >= from) {
          const w = (weeks[mondayOfYmd(day)] = weeks[mondayOfYmd(day)] || {});
          const slot = (w[view.id] = w[view.id] || { count: 0, value: 0 });
          slot.count += 1;
          slot.value += amount;
        }
        const party = f.party ? cell(row[f.party]).trim() : "";
        if (party) {
          const c = (customers[party] = customers[party] || {});
          const slot = (c[view.id] = c[view.id] || { count: 0, value: 0 });
          slot.count += 1;
          slot.value += amount;
        }
        const code = f.person ? cell(row[f.person]).trim() : "";
        if (code) {
          const who = codeToUser.get(code.toLowerCase()) || code;
          const p = (people[who] = people[who] || {});
          p[view.id] = (p[view.id] || 0) + 1;
        }
      }
      summary.push({
        id: view.id, label: view.label, count: rows.length, value: Math.round(value * 100) / 100,
        hasValue: !!f.amount, error, capped: rows.length >= 200,
      });
    });

    // Every week in the range, oldest first, so the chart has no gaps.
    const weekList = [];
    for (let w = mondayOfYmd(from); w <= new Date().toISOString().slice(0, 10); ) {
      weekList.push({ week: w, data: weeks[w] || {} });
      const d = new Date(`${w}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 7);
      w = d.toISOString().slice(0, 10);
    }
    const topCustomers = Object.entries(customers)
      .map(([name, d]) => ({ name, data: d, soValue: (d.sales_orders || {}).value || 0, activity: Object.values(d).reduce((s, x) => s + x.count, 0) }))
      .sort((a, b) => b.soValue - a.soValue || b.activity - a.activity)
      .slice(0, 10);
    const byPerson = Object.entries(people)
      .map(([name, d]) => ({ name, data: d, total: Object.values(d).reduce((s, x) => s + x, 0) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);
    res.json({ days, from, summary, weeks: weekList, topCustomers, byPerson });
  })
);

// ---------- Claude project links per department ----------
// claude.ai can't be embedded in another site, so each department tab links
// out to its Claude project. Links are set on the admin page.

function cleanClaudeProjects(raw) {
  const out = {};
  for (const dept of DEPARTMENTS) {
    const value = String((raw && raw[dept]) || "").trim();
    if (!value) continue;
    let url;
    try {
      url = new URL(value);
    } catch (e) {
      throw new Error(`${dept}: not a valid link`);
    }
    if (url.protocol !== "https:" || url.hostname !== "claude.ai") {
      throw new Error(`${dept}: must be a https://claude.ai link`);
    }
    out[dept] = url.toString();
  }
  return out;
}

app.get(
  "/api/claude-projects",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    res.json(settings.claudeProjects || {});
  })
);

// ---------- Admin: create/manage logins ----------
// A separate password (ADMIN_PASSWORD, set once in your Portainer stack's
// env vars) gates the admin page — it's not tied to any one person's login.

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect admin password" });
  }
  res.json({ token: signAdminToken() });
});

app.get(
  "/api/admin/users",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const rawUsers = await getUsers();
    const users = rawUsers.map(normalizeUser);
    res.json(
      users.map((u) => ({
        username: u.username,
        email: u.email || "",
        companies: u.companies,
        departments: u.departments,
        fullAccess: u.fullAccess,
        manager: u.manager,
        breakdown: u.breakdown,
        leadership: u.leadership,
        itNotebook: u.itNotebook,
        performance: u.performance,
        extraMailboxes: u.extraMailboxes,
        calendarNames: u.calendarNames,
        pentagonCode: u.pentagonCode || "",
      }))
    );
  })
);

app.get(
  "/api/admin/claude-projects",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    res.json(settings.claudeProjects || {});
  })
);

app.put(
  "/api/admin/claude-projects",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    let projects;
    try {
      projects = cleanClaudeProjects(req.body || {});
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    await withSettings((settings) => {
      settings.claudeProjects = projects;
    });
    res.json(projects);
  })
);

app.post(
  "/api/admin/users",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const { username, password, email, companies, departments, fullAccess, manager, breakdown, leadership, itNotebook, performance, extraMailboxes, calendarNames, pentagonCode } = req.body || {};
    if (!username || !email) {
      return res.status(400).json({ error: "Username and email are required" });
    }
    if (!Array.isArray(companies) || companies.length === 0) {
      return res.status(400).json({ error: "Select at least one company" });
    }
    if (companies.some((c) => !COMPANIES.includes(c))) {
      return res.status(400).json({ error: "Invalid company selected" });
    }
    if (password && String(password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }
    // Shared mailboxes this person can read on Work inbox, same domain as
    // their own email (e.g. it@ for IT). Only an admin can set these.
    const ownDomain = String(email).split("@")[1].toLowerCase();
    const extras = [...new Set((Array.isArray(extraMailboxes) ? extraMailboxes : String(extraMailboxes || "").split(/[\s,;]+/))
      .map((m) => String(m).trim().toLowerCase()).filter(Boolean))].filter((m) => m !== String(email).toLowerCase());
    for (const m of extras) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m)) return res.status(400).json({ error: `"${m}" isn't an email address` });
      if (m.split("@")[1] !== ownDomain) return res.status(400).json({ error: `Extra inboxes must be @${ownDomain} addresses, like their own email ("${m}" isn't)` });
    }
    if (extras.length > 10) return res.status(400).json({ error: "Up to 10 extra inboxes" });
    const deptList = Array.isArray(departments) ? departments : [];
    if (!fullAccess) {
      if (deptList.length === 0) {
        return res.status(400).json({ error: "Select at least one department, or turn on full access" });
      }
      if (deptList.some((d) => !DEPARTMENTS.includes(d))) {
        return res.status(400).json({ error: "Invalid department selected" });
      }
    }

    const existingUsers = await getUsers();
    const existing = existingUsers.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!existing && !password) {
      return res.status(400).json({ error: "Password is required for a new login" });
    }

    const passwordHash = password ? await hashPassword(password) : existing.passwordHash;
    const record = {
      username,
      passwordHash,
      email,
      companies,
      fullAccess: !!fullAccess,
      manager: !!manager,
      breakdown: !!breakdown,
      leadership: !!leadership,
      itNotebook: !!itNotebook,
      performance: !!performance,
      extraMailboxes: extras,
      calendarNames: (Array.isArray(calendarNames) ? calendarNames : String(calendarNames || "").split(","))
        .map((n) => String(n).trim().slice(0, 40)).filter(Boolean).slice(0, 5),
      departments: deptList,
      pentagonCode: String(pentagonCode || "").trim(),
    };

    await withUsers((users) => {
      const idx = users.findIndex((u) => u.username.toLowerCase() === username.toLowerCase());
      if (idx !== -1) {
        const next = { ...users[idx], ...record };
        delete next.department; // drop the old single-department field once migrated
        users[idx] = next;
      } else {
        users.push(record);
      }
    });

    res.status(201).json({ username, email, companies, departments: record.departments, fullAccess: record.fullAccess, manager: record.manager });
  })
);

app.delete(
  "/api/admin/users/:username",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const { username } = req.params;
    let removed = false;

    await withUsers((users) => {
      const idx = users.findIndex((u) => u.username.toLowerCase() === username.toLowerCase());
      if (idx !== -1) {
        users.splice(idx, 1);
        removed = true;
      }
    });

    if (!removed) return res.status(404).json({ error: "User not found" });
    res.status(204).end();
  })
);

// ---------- Frontend (flat layout: html files sit next to this file) ----------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/chart.umd.min.js", (req, res) => {
  res.sendFile(path.join(__dirname, "chart.umd.min.js"));
});

// ---------- Self-signed HTTPS ----------
// This is an internal-only server (VPN / office network), so instead of a
// public certificate authority, we generate one self-signed certificate
// the first time the container starts and reuse it after that. Browsers
// will show a one-time "not private" warning to click past on first visit
// — expected for a self-signed cert.

const CERT_DIR = "/app/certs";
const CERT_PATH = path.join(CERT_DIR, "server.crt");
const KEY_PATH = path.join(CERT_DIR, "server.key");

function ensureCert() {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) return;
  if (!SERVER_IP) {
    console.error(
      "Missing required env var: SERVER_IP (the server's private IP — used as the certificate's subject)"
    );
    process.exit(1);
  }
  fs.mkdirSync(CERT_DIR, { recursive: true });
  execSync(
    `openssl req -x509 -nodes -newkey rsa:2048 -days 3650 ` +
      `-keyout ${KEY_PATH} -out ${CERT_PATH} ` +
      `-subj "/CN=${SERVER_IP}" -addext "subjectAltName=IP:${SERVER_IP}"`,
    { stdio: "inherit" }
  );
  console.log(`Generated a new self-signed certificate for ${SERVER_IP}`);
}

// One-time rename: the "Operations" department is now "Business
// Development". Moves logins, tasks and per-department settings over;
// does nothing once there's nothing left to rename.
async function renameDepartment(from, to) {
  let users = 0, tasks = 0;
  const [u0, t0, s0] = await Promise.all([getUsers(), getTasks(), getSettings()]);
  const needed =
    u0.some((u) => (Array.isArray(u.departments) && u.departments.includes(from)) || u.department === from) ||
    t0.some((t) => t.department === from) ||
    ["claudeProjects", "departmentDefaults"].some((k) => s0[k] && s0[k][from]);
  if (!needed) return;
  await withUsers((list) => {
    for (const u of list) {
      if (Array.isArray(u.departments) && u.departments.includes(from)) {
        u.departments = [...new Set(u.departments.map((d) => (d === from ? to : d)))];
        users++;
      }
      if (u.department === from) { u.department = to; users++; }
    }
  });
  await withTasks((list) => {
    for (const t of list) if (t.department === from) { t.department = to; tasks++; }
  });
  await withSettings((s) => {
    for (const k of ["claudeProjects", "departmentDefaults"]) {
      if (s[k] && s[k][from] && !s[k][to]) { s[k][to] = s[k][from]; delete s[k][from]; }
    }
  });
  if (users || tasks) console.log(`Renamed department "${from}" to "${to}": ${users} login(s), ${tasks} task(s).`);
}
renameDepartment("Operations", "Business Development").catch((err) =>
  console.error("Department rename failed (will retry next start):", err.message)
);

// One-time: requests used to be open / done, with imports starting as done.
// Move to New / In progress / Resolved, treating imports nobody has touched
// as In progress. Runs once (remembered in settings).
async function migrateRequestStatuses() {
  const settings = await getSettings();
  if (settings.itRequestStatusesV2) return;
  let moved = 0;
  await withItRequests((list) => {
    for (const r of list) {
      const before = r.status;
      if (r.status === "open") r.status = r.source === "email" ? "new" : "progress";
      else if (r.status === "done" && r.source === "import" && !r.updatedBy) r.status = "progress";
      if (r.status !== before) moved++;
    }
  });
  await withSettings((s) => { s.itRequestStatusesV2 = true; });
  if (moved) console.log(`IT requests: moved ${moved} to New / In progress.`);
}
migrateRequestStatuses().catch((err) => console.error("IT request status update failed (will retry next start):", err.message));

// ---- IT request history (IT page → Requests) ----
// Everyone with the IT department (or full access) can see it; managers set
// the internal priority and open / done. A request that became a task takes
// its open / done from that task, and changes here go to the task too.
const IT_PRIORITIES = ["P1", "P2", "P3", "P4"];
const PRIORITY_TO_TASK = { P1: "high", P2: "high", P3: "medium", P4: "low" };
// New (just came in from the flow), In progress, Resolved ("done").
const IT_STATUSES = ["new", "progress", "done"];

// A request's status, taking a linked IT task into account: ticking the
// task done resolves the request, and reopening it puts it back in progress.
function requestStatus(r, task) {
  let st = IT_STATUSES.includes(r.status) ? r.status : r.source === "email" ? "new" : "progress";
  if (task) st = task.status === "done" ? "done" : st === "done" ? "progress" : st;
  return st;
}

function canSeeItRequests(user) {
  return user.fullAccess || (user.departments || []).includes("IT");
}

app.get(
  "/api/it-requests",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!canSeeItRequests(req.user)) return res.status(403).json({ error: "Only IT can see form requests" });
    const [list, tasks] = await Promise.all([getItRequests(), getTasks()]);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const requests = list.map((r) => {
      const task = r.taskId ? byId.get(r.taskId) : null;
      return Object.assign({}, r, { status: requestStatus(r, task) }, task ? { taskOwner: task.owner || "" } : { taskId: "" });
    }).sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
    res.json({ requests, canRate: isManager(req.user), mailboxConnected: itRequestsConfigured, sync: itSyncStatus() });
  })
);

// Change one or several requests (status and / or priority). Linked IT
// tasks follow: Resolved ticks the task done, New / In progress reopen it.
const RESOLUTION_PARTS = ["issue", "cause", "fix", "action"];
const RESOLUTION_LABEL = { issue: "The issue", cause: "What caused it", fix: "How it was fixed", action: "What you need to do" };
// A short ticket number for the email subject, so replies find their way back.
function ticketRef(id) {
  return "IT-" + parseInt(require("crypto").createHash("sha1").update(String(id)).digest("hex").slice(0, 10), 16).toString(36).toUpperCase().slice(0, 5);
}
function resolvedEmailHtml(rec, me) {
  const p = rec.resolutionParts || {};
  const who = (me && (me.name || me.username)) || "IT";
  const whoName = who.charAt(0).toUpperCase() + who.slice(1);
  const para = (t) => escapeHtml(t).replace(/\n/g, "<br>");
  const section = (label, text) => text ? `<p style="margin:0 0 14px;"><b>${label}</b><br>${para(text)}</p>` : "";
  const issue = p.issue || rec.issue || "";
  const fix = p.fix || (Object.keys(p).length ? "" : rec.resolution) || "";
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:600px;">` +
    `<p>Hi ${escapeHtml((rec.name || "").split(" ")[0] || "there")},</p>` +
    `<p>Good news — your IT request${rec.submittedAt ? " from " + escapeHtml(String(rec.submittedAt).slice(0, 10)) : ""} has been <b>resolved</b>.</p>` +
    `<div style="border-left:3px solid #9fbf8f;padding:4px 0 2px 14px;margin:16px 0;">` +
    section("The issue", issue) + section("What caused it", p.cause) + section("How it was fixed", fix) + section("What you need to do", p.action) +
    `</div>` +
    `<p>If you're still having this issue, just reply to this email and it'll come straight to ${escapeHtml(whoName)}.</p>` +
    `<p>Thanks,<br>${escapeHtml(whoName)}<br>SOI Aviation IT</p>` +
    `<p style="color:#888;font-size:12px;">Ticket ${escapeHtml(rec.ref || ticketRef(rec.id))}</p></div>`;
}

async function changeRequests(req, res, ids) {
  if (!canSeeItRequests(req.user) || !isManager(req.user)) return res.status(403).json({ error: "Only managers can change requests" });
  const body = req.body || {};
  const change = {};
  if ("priority" in body) {
    if (body.priority !== "" && !IT_PRIORITIES.includes(body.priority)) return res.status(400).json({ error: "Priority must be P1–P4" });
    change.priority = body.priority;
  }
  if ("status" in body) {
    if (!IT_STATUSES.includes(body.status)) return res.status(400).json({ error: "Status must be new, progress or done" });
    change.status = body.status;
  }
  // Duplicates: "duplicateOf" links a request to the original (closing it as
  // resolved); "" unlinks it — to the status sent, or In progress — and
  // counts as "not a duplicate" so the repeat hint doesn't bring it back.
  // "notDuplicate" just hides the hint. "makeOriginal" (one request) turns a
  // duplicate into the main request: its old original and the other
  // duplicates become duplicates of it, and it takes over the open status.
  if ("duplicateOf" in body) {
    change.duplicateOf = String(body.duplicateOf || "").slice(0, 80);
    if (change.duplicateOf) { change.status = "done"; change.notDuplicate = false; }
    else { change.status = change.status || "progress"; change.notDuplicate = true; }
  }
  if ("notDuplicate" in body) change.notDuplicate = !!body.notDuplicate;
  // Resolving: what the issue was, what caused it, how it was fixed and
  // anything they need to do (all optional), and whether to email the
  // requester. The parts are also joined into one note for the ticket.
  const rp = body.parts && typeof body.parts === "object" ? body.parts : {};
  const parts = {};
  for (const k of RESOLUTION_PARTS) { const v = String(rp[k] || "").trim().slice(0, 1500); if (v) parts[k] = v; }
  const resolution = Object.keys(parts).length
    ? RESOLUTION_PARTS.filter((k) => parts[k] && k !== "issue").map((k) => `${RESOLUTION_LABEL[k]}: ${parts[k]}`).join("\n")
    : String(body.resolution || "").trim().slice(0, 2000);
  if (change.status === "done" && (resolution || parts.issue)) Object.assign(change, { resolution, resolutionParts: parts, resolvedAt: Date.now(), resolvedBy: req.user.username });
  const notify = change.status === "done" && body.notify === true;
  // A reply to a resolved email has been looked at (Reopen or Keep resolved).
  if (body.replySeen === true) change.replyPending = false;
  const makeOriginal = body.makeOriginal === true;
  if (!Object.keys(change).length && !makeOriginal) return res.status(400).json({ error: "Nothing to change" });
  if (makeOriginal && ids.length !== 1) return res.status(400).json({ error: "Pick one request to keep" });
  const wanted = new Set(ids.map((x) => String(x)).slice(0, 1000));
  const now = { updatedAt: Date.now(), updatedBy: req.user.username };

  const result = await withItRequests((list) => {
    const touched = new Map(); // id -> record, for syncing linked tasks
    const touch = (r) => touched.set(r.id, r);
    if (makeOriginal) {
      const keep = list.find((x) => wanted.has(x.id));
      if (!keep) return { out: [] };
      const rootId = keep.duplicateOf;
      if (!rootId) return { error: "That one is already the main request" };
      const root = list.find((x) => x.id === rootId);
      keep.duplicateOf = "";
      keep.notDuplicate = true;
      keep.status = root && root.status !== "done" ? root.status : "progress";
      if (!keep.priority && root && root.priority) keep.priority = root.priority;
      Object.assign(keep, now); touch(keep);
      for (const x of list) {
        if (x.id === keep.id) continue;
        if (x.id === rootId || x.duplicateOf === rootId) {
          Object.assign(x, { duplicateOf: keep.id, status: "done", notDuplicate: false }, now);
          touch(x);
        }
      }
      return { out: [Object.assign({}, keep)], touched: [...touched.values()].map((r) => Object.assign({}, r)) };
    }
    if (change.duplicateOf) {
      // Point at the original's original, never at itself.
      let target = list.find((x) => x.id === change.duplicateOf);
      for (let hops = 0; target && target.duplicateOf && hops < 10; hops++) target = list.find((x) => x.id === target.duplicateOf);
      if (!target) return { error: "The original request isn't here any more" };
      if (wanted.has(target.id)) return { error: "A request can't be a duplicate of itself" };
      change.duplicateOf = target.id;
    }
    const out = [];
    for (const r of list) {
      if (!wanted.has(r.id)) continue;
      Object.assign(r, change, now);
      touch(r);
      out.push(Object.assign({}, r));
    }
    // Anything that was a duplicate of these now points at the new original.
    if (change.duplicateOf) for (const r of list) if (wanted.has(r.duplicateOf)) { r.duplicateOf = change.duplicateOf; touch(r); }
    return { out, touched: [...touched.values()].map((r) => Object.assign({}, r)) };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  const changed = result.out;
  if (!changed.length) return res.status(404).json({ error: "Those requests aren't here any more" });
  // Linked IT tasks follow: Resolved / duplicate -> done, otherwise open.
  const linked = (result.touched || []).filter((r) => r.taskId);
  const statusMoved = "status" in change || "duplicateOf" in change || makeOriginal;
  if (linked.length && (change.priority || statusMoved)) {
    await withTasks((tasks) => {
      for (const rec of linked) {
        const t = tasks.find((x) => x.id === rec.taskId);
        if (!t) continue;
        if (change.priority) t.priority = PRIORITY_TO_TASK[change.priority];
        if (statusMoved) t.status = rec.status === "done" ? "done" : "todo";
      }
    });
  }
  // Email the requesters, and copy the note into the IT notebook's write-up.
  let emailed = 0;
  const emailProblems = [], sentIds = new Map();
  if (notify) {
    const users = await getUsers();
    const me = users.find((u) => sameUser(u.username, req.user.username));
    for (const rec of changed) {
      if (!rec.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.email)) { emailProblems.push(`${rec.name || rec.id}: no email on the ticket`); continue; }
      try {
        const ref = rec.ref || ticketRef(rec.id);
        rec.ref = ref;
        const ok = await sendMail({
          to: rec.email,
          // Replies go to the person who resolved it and to the IT mailbox,
          // where the tracker picks them up and shows them on the ticket.
          replyTo: [me && me.email, IT_REQUESTS_MAILBOX],
          saveCopy: true,
          subject: `Resolved: your IT request${rec.issue ? " — " + String(rec.issue).replace(/\s+/g, " ").slice(0, 60) : ""} [Ticket ${ref}]`,
          html: resolvedEmailHtml(rec, me),
        });
        if (!ok) { emailProblems.push("Email isn't set up on the server (MS_FROM_EMAIL / Mail.Send)"); break; }
        emailed++;
        sentIds.set(rec.id, rec.ref);
      } catch (err) {
        console.error("Resolution email failed:", err.message);
        emailProblems.push(`${rec.email}: couldn't send`);
      }
    }
    if (emailed) await withItRequests((list) => {
      for (const r of list) if (sentIds.has(r.id)) { r.notifiedAt = Date.now(); r.notifiedBy = req.user.username; r.ref = sentIds.get(r.id); }
    });
  }
  if ((parts.fix || resolution) && change.status === "done") {
    await withItNotebook((nb) => {
      nb.tickets = nb.tickets && typeof nb.tickets === "object" ? nb.tickets : {};
      for (const rec of changed) {
        const w = (nb.tickets[rec.id] = nb.tickets[rec.id] || { createdAt: Date.now() });
        if (!w.fix) { w.fix = parts.fix ? (parts.cause ? `Cause: ${parts.cause}\n\n${parts.fix}` : parts.fix) : resolution; w.updatedAt = Date.now(); }
      }
    });
  }
  res.json({ changed: changed.length, requests: changed, emailed, emailProblems });
}

app.patch(
  "/api/it-requests/:id",
  authMiddleware,
  asyncHandler((req, res) => changeRequests(req, res, [req.params.id]))
);

app.post(
  "/api/it-requests/bulk",
  authMiddleware,
  asyncHandler((req, res) => changeRequests(req, res, Array.isArray((req.body || {}).ids) ? req.body.ids : []))
);

// ---- Private IT notebook (IT → Resolved) ----
// Write-ups on resolved requests (the fix, private notes, a category) and
// knowledge base articles. Only logins with "Private IT notebook" ticked in
// /admin.html can read or write it — not other managers, not full access.
// Checked against the saved login each time, so unticking takes effect at once.
const NB_TEXT = 20000;

async function hasItNotebook(user) {
  const u = (await getUsers()).find((x) => sameUser(x.username, user.username));
  return !!(u && u.itNotebook);
}
const notebookOnly = asyncHandler(async (req, res, next) => {
  if (!(await hasItNotebook(req.user))) return res.status(403).json({ error: "The IT notebook is private" });
  next();
});
const nbText = (v, n) => String(v == null ? "" : v).slice(0, n);
function nbShape(nb) {
  nb.tickets = nb.tickets && typeof nb.tickets === "object" ? nb.tickets : {};
  nb.articles = Array.isArray(nb.articles) ? nb.articles : [];
  // KB numbers (KB-0001…): oldest first for articles from before numbering.
  const unnumbered = nb.articles.filter((a) => !a.kb).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  let seq = Math.max(nb.kbSeq || 0, ...nb.articles.map((a) => a.kb || 0));
  for (const a of unnumbered) a.kb = ++seq;
  nb.kbSeq = seq;
  return nb;
}
// Images in articles are written as ![caption](kb-img:ID) in the body.
const KB_IMG_RE = /kb-img:([a-z0-9]{8,40})/g;
const KB_IMG_TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
function imageKind(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 6 && buf.slice(0, 3).toString() === "GIF") return "gif";
  if (buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "webp";
  return null;
}

app.get(
  "/api/it-notebook",
  authMiddleware,
  notebookOnly,
  asyncHandler(async (req, res) => {
    let [nb, list, tasks] = await Promise.all([getItNotebook(), getItRequests(), getTasks()]);
    if ((nb.articles || []).some((a) => !a.kb)) nb = await withItNotebook((x) => JSON.parse(JSON.stringify(nbShape(x))));
    nbShape(nb);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const resolved = list
      .map((r) => {
        const task = r.taskId ? byId.get(r.taskId) : null;
        return Object.assign({}, r, { status: requestStatus(r, task) });
      })
      .filter((r) => !r.duplicateOf && (r.status === "done" || nb.tickets[r.id]))
      .map((r) => Object.assign(r, { writeup: nb.tickets[r.id] || null }))
      .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
    const articles = nb.articles.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json({ resolved, articles });
  })
);

app.put(
  "/api/it-notebook/tickets/:id",
  authMiddleware,
  notebookOnly,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const id = nbText(req.params.id, 80);
    const writeup = await withItNotebook((nb) => {
      nbShape(nb);
      const w = nb.tickets[id] || { createdAt: Date.now() };
      for (const k of ["fix", "notes"]) if (k in body) w[k] = nbText(body[k], NB_TEXT);
      if ("category" in body) w.category = nbText(body.category, 40).trim();
      if ("articleId" in body) w.articleId = nbText(body.articleId, 40);
      w.updatedAt = Date.now();
      nb.tickets[id] = w;
      return w;
    });
    res.json(writeup);
  })
);

app.post(
  "/api/it-notebook/articles",
  authMiddleware,
  notebookOnly,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const article = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      title: nbText(body.title, 160).trim() || "Untitled article",
      category: nbText(body.category, 40).trim(),
      body: nbText(body.body, NB_TEXT),
      fromRequest: nbText(body.fromRequest, 80),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await withItNotebook((nb) => {
      nbShape(nb);
      article.kb = ++nb.kbSeq;
      nb.articles.push(article);
    });
    res.status(201).json(article);
  })
);

app.patch(
  "/api/it-notebook/articles/:id",
  authMiddleware,
  notebookOnly,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const article = await withItNotebook((nb) => {
      const a = nbShape(nb).articles.find((x) => x.id === req.params.id);
      if (!a) return null;
      if ("title" in body) a.title = nbText(body.title, 160).trim() || "Untitled article";
      if ("category" in body) a.category = nbText(body.category, 40).trim();
      if ("body" in body) a.body = nbText(body.body, NB_TEXT);
      a.updatedAt = Date.now();
      return Object.assign({}, a);
    });
    if (!article) return res.status(404).json({ error: "That article isn't here any more" });
    res.json(article);
  })
);

app.delete(
  "/api/it-notebook/articles/:id",
  authMiddleware,
  notebookOnly,
  asyncHandler(async (req, res) => {
    const result = await withItNotebook((nb) => {
      const list = nbShape(nb).articles;
      const i = list.findIndex((x) => x.id === req.params.id);
      if (i === -1) return null;
      const [gone] = list.splice(i, 1);
      // Its images, unless another article uses them too.
      const others = list.map((a) => a.body).join("\n");
      const imgs = [...String(gone.body).matchAll(KB_IMG_RE)].map((m) => m[1]).filter((id) => !others.includes(`kb-img:${id}`));
      return { imgs };
    });
    if (!result) return res.status(404).json({ error: "That article isn't here any more" });
    await Promise.all(result.imgs.map((id) => deleteFile(`it_notebook_images/${id}`).catch(() => {})));
    res.status(204).end();
  })
);

// Photos and screenshots for articles: upload one (raw image bytes, up to
// 8 MB; PNG, JPEG, GIF or WebP, checked by content), and fetch one. Stored
// privately in S3; only notebook logins can read them.
app.post(
  "/api/it-notebook/images",
  authMiddleware,
  notebookOnly,
  express.raw({ type: () => true, limit: "8mb" }),
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No image came through" });
    const kind = imageKind(req.body);
    if (!kind) return res.status(400).json({ error: "Images need to be PNG, JPEG, GIF or WebP" });
    const id = Date.now().toString(36) + require("crypto").randomBytes(6).toString("hex");
    await putFile(`it_notebook_images/${id}`, req.body, KB_IMG_TYPES[kind]);
    res.status(201).json({ id });
  })
);
app.get(
  "/api/it-notebook/images/:id",
  authMiddleware,
  notebookOnly,
  asyncHandler(async (req, res) => {
    if (!/^[a-z0-9]{8,40}$/.test(req.params.id)) return res.status(400).end();
    const file = await getFile(`it_notebook_images/${req.params.id}`);
    if (!file) return res.status(404).json({ error: "That image isn't here any more" });
    res.set({ "Content-Type": file.contentType, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
    res.send(file.body);
  })
);

// One-time (or repeat) import of the Forms "Open results in Excel" file.
// Re-importing updates the answers but keeps priorities and open / done.
// Imported requests start as In progress; you move them along from there.
app.post(
  "/api/it-requests/import",
  authMiddleware,
  express.raw({ type: "application/octet-stream", limit: "10mb" }),
  asyncHandler(async (req, res) => {
    if (!canSeeItRequests(req.user) || !isManager(req.user)) return res.status(403).json({ error: "Only managers can import requests" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Choose the .xlsx file from Microsoft Forms" });
    let records;
    try {
      records = await parseFormWorkbook(req.body);
    } catch (err) {
      if (!(err instanceof FormFileError)) console.error("IT request import failed:", err.message);
      return res.status(400).json({ error: err instanceof FormFileError ? err.message : "That file couldn't be read as an Excel workbook." });
    }
    const tasks = await getTasks();
    const taskByForm = new Map(tasks.filter((t) => t.formResponseId).map((t) => [`form-${t.formResponseId}`, t]));
    const counts = await withItRequests((list) => {
      let added = 0, updated = 0;
      for (const rec of records) {
        const have = list.find((x) => x.id === rec.id);
        if (have) {
          const keep = { priority: have.priority, status: have.status, taskId: have.taskId, addedAt: have.addedAt, source: have.source };
          Object.assign(have, rec, keep);
          updated++;
        } else {
          const task = taskByForm.get(rec.id);
          list.push(Object.assign(rec, { priority: "", status: task && task.status === "done" ? "done" : "progress", taskId: task ? task.id : "", addedAt: Date.now() }));
          added++;
        }
      }
      return { added, updated };
    });
    res.json(Object.assign({ rows: records.length }, counts));
  })
);

// IT requests from the Microsoft Form (see itrequests.js): every few
// minutes, each new "[IT Request]" email becomes an IT task for the IT
// default person. Handled ones are remembered in settings, so a task that's
// deleted later doesn't come back.
const IT_REQUESTS_EVERY_MS = 3 * 60 * 1000;
let itRequestsRunning = false;
// What the last check found, for the status line on IT → Requests.
let itSync = { at: 0, ok: null, error: "", matched: 0, added: 0 };
async function syncItRequests() {
  if (!itRequestsConfigured) return itSync;
  if (itRequestsRunning) return itSync;
  itRequestsRunning = true;
  try {
    const settings = await getSettings();
    const seen = new Set(settings.itRequestsSeen || []);
    const seenMessages = new Set(settings.itRequestsSeenMessages || []);
    // Replies have their own seen list, separate from form emails.
    const seenReplies = new Set(settings.itRepliesSeen || []);
    const { matched, items, checked, replies, repliesChecked } = await fetchItRequests(seenMessages, seenReplies);
    // Replies to "Resolved" emails go on their ticket, flagged until someone
    // reopens it or keeps it resolved.
    let replied = 0;
    if (replies && replies.length) {
      await withItRequests((list) => {
        for (const rp of replies) {
          const rec = list.find((x) => x.ref === rp.ref) || list.find((x) => ticketRef(x.id) === rp.ref);
          if (!rec) continue;
          rec.ref = rp.ref;
          rec.replies = Array.isArray(rec.replies) ? rec.replies : [];
          if (rec.replies.some((x) => x.messageId === rp.messageId)) continue;
          rec.replies.push({ messageId: rp.messageId, at: Date.parse(rp.at) || Date.now(), from: rp.from, name: rp.fromName, text: rp.text });
          rec.replies = rec.replies.slice(-20);
          rec.replyPending = true;
          replied++;
        }
      });
      if (replied) console.log(`IT requests: ${replied} repl${replied === 1 ? "y" : "ies"} to resolved tickets.`);
    }
    const fresh = items.filter((r) => !seen.has(r.responseId || r.messageId));
    let added = [];
    if (fresh.length) {
      const owner = (settings.departmentDefaults || {}).IT || "";
      added = fresh.map((r, i) => ({
        id: Date.now().toString(36) + i + Math.random().toString(36).slice(2, 6),
        title: r.title.slice(0, 140),
        company: "SOI Aviation",
        department: "IT",
        status: "todo",
        priority: r.urgent ? "high" : "medium",
        owner,
        dueDate: "",
        notes: r.fields.map((f) => `${f.label}: ${f.value}`).join("\n").slice(0, 500),
        createdAt: Date.parse(r.receivedAt) || Date.now(),
        createdBy: "IT request form",
        source: "form",
        kind: "task",
        requester: r.requester.slice(0, 120),
        formResponseId: r.responseId || r.messageId,
      }));
      await withTasks((tasks) => { tasks.unshift(...added.slice().reverse()); });
      // Also into the Requests history, linked to the task.
      await withItRequests((list) => {
        fresh.forEach((r, i) => {
          const rec = recordFromEmail(r);
          const have = list.find((x) => x.id === rec.id);
          if (have) { if (!have.taskId) have.taskId = added[i].id; return; }
          list.push(Object.assign(rec, { priority: "", status: "new", taskId: added[i].id, addedAt: Date.now() }));
        });
      });
    }
    // Remember responses and messages already handled (messages so their
    // bodies aren't re-read every few minutes).
    if (fresh.length || checked.length || (repliesChecked || []).length) {
      await withSettings((s) => {
        if ((repliesChecked || []).length) s.itRepliesSeen = [...repliesChecked, ...(s.itRepliesSeen || [])].slice(0, 2000);
        s.itRequestsSeen = [...fresh.map((r) => r.responseId || r.messageId), ...(s.itRequestsSeen || [])].slice(0, 2000);
        s.itRequestsSeenMessages = [...checked, ...(s.itRequestsSeenMessages || [])].slice(0, 2000);
      });
    }
    itSync = { at: Date.now(), ok: true, error: "", matched, added: added.length, replies: (itSync.replies || 0) + replied, unmatched: (itSync.unmatched || 0) + ((replies || []).length - replied) };
    if (added.length) console.log(`IT requests: added ${added.length} task(s) from ${IT_REQUESTS_MAILBOX}.`);
  } catch (err) {
    itSync = { at: Date.now(), ok: false, error: err.message, matched: 0, added: 0, replies: itSync.replies || 0, unmatched: itSync.unmatched || 0 };
    console.error("IT request sync failed (will retry):", err.message);
  } finally {
    itRequestsRunning = false;
  }
  return itSync;
}

// A ticket added by hand on IT → Requests (a call, a walk-up, a Teams
// message): a request record like a form one, plus a task on IT → Tasks for
// the IT default person. Anyone who can see Requests can add one.
app.post(
  "/api/it-requests",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!canSeeItRequests(req.user)) return res.status(403).json({ error: "Only IT can add tickets" });
    const b = req.body || {};
    const text = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
    const issue = String(b.issue || "").trim().slice(0, 1000);
    if (!issue) return res.status(400).json({ error: "Describe the issue" });
    const name = text(b.name, 80), email = text(b.email, 120).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "That email doesn't look right" });
    const priority = IT_PRIORITIES.includes(b.priority) ? b.priority : "";
    const settings = await getSettings();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const task = {
      id: "t" + id,
      title: issue.split(/[.!?\n]/)[0].trim().slice(0, 140) || "IT ticket",
      company: "SOI Aviation",
      department: "IT",
      status: "todo",
      priority: priority ? PRIORITY_TO_TASK[priority] : "medium",
      owner: (settings.departmentDefaults || {}).IT || "",
      dueDate: "",
      notes: [name || email ? `Requested by: ${[name, email].filter(Boolean).join(" · ")}` : "", issue].filter(Boolean).join("\n").slice(0, 500),
      createdAt: Date.now(),
      createdBy: req.user.username,
      source: "form",
      kind: "task",
      requester: name || email,
      formResponseId: "manual-" + id,
    };
    const rec = {
      id: "manual-" + id, formId: null, source: "manual",
      submittedAt: officeStamp(new Date().toISOString()),
      name, email, phone: text(b.phone, 40), company: text(b.company, 40), remote: "", issue, startedOn: "",
      urgency: "", contact: text(b.contact, 60), notes: "",
      priority, status: "new", taskId: task.id, addedAt: Date.now(), addedBy: req.user.username,
    };
    await withTasks((tasks) => { tasks.unshift(task); });
    await withItRequests((list) => { list.push(rec); });
    res.status(201).json(rec);
  })
);

// Status for IT → Requests, and "Check now" for managers.
function itSyncStatus() {
  return Object.assign({ configured: itRequestsConfigured, mailbox: IT_REQUESTS_MAILBOX, everyMinutes: IT_REQUESTS_EVERY_MS / 60000 }, itSync);
}
app.post(
  "/api/it-requests/check-now",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!canSeeItRequests(req.user) || !isManager(req.user)) return res.status(403).json({ error: "Only managers can do this" });
    if (!itRequestsConfigured) return res.json(itSyncStatus());
    while (itRequestsRunning) await new Promise((r) => setTimeout(r, 300));
    await syncItRequests();
    res.json(itSyncStatus());
  })
);

if (itRequestsConfigured) {
  setTimeout(syncItRequests, 15 * 1000);
  setInterval(syncItRequests, IT_REQUESTS_EVERY_MS);
}

ensureCert();

https
  .createServer(
    { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) },
    app
  )
  .listen(PORT, () => {
    console.log(`SOI tracker listening on https://0.0.0.0:${PORT}`);
  });
