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
} = require("./s3store");
const { sendMail } = require("./mailer");
const { eventsBetween, whosIn, CalendarError } = require("./calendar");
const { hrEvents, cleanFeedUrl, FeedError } = require("./hrcal");
const { itRequestsConfigured, fetchItRequests, IT_REQUESTS_MAILBOX } = require("./itrequests");
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
    calendarNames: Array.isArray(u.calendarNames) ? u.calendarNames : [],
    pentagonCode: u.pentagonCode || "",
  };
}

function sameUser(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

const TASK_STATUSES = ["todo", "in_progress", "blocked", "done"];
const TASK_PRIORITIES = ["low", "medium", "high"];

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
      pentagonCode: user.pentagonCode,
      pentagonMentions: getsPentagonMentions(user),
    });
  })
);

app.get("/api/me", authMiddleware, (req, res) => {
  res.json({
    username: req.user.username,
    companies: req.user.companies,
    departments: req.user.departments,
    fullAccess: req.user.fullAccess,
    manager: isManager(req.user),
    leadership: req.user.leadership,
    pentagonCode: req.user.pentagonCode,
    pentagonMentions: getsPentagonMentions(req.user),
  });
});

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

// Work inbox: the signed-in person's own unread Outlook mail (last 1–14
// days), one card per conversation, Outlook's preview text, no AI. The
// mailbox is the email on their login — never one from the browser.
app.get(
  "/api/inbox",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 3, 1), 14);
    const users = await getUsers();
    const u = users.find((x) => sameUser(x.username, req.user.username));
    try {
      res.json(await unreadThreads(u && u.email, days));
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
      res.json(await whosIn(people, shared.ics || "", date));
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
    const shared = (await getSettings()).sharedCalendar || {};
    if (!shared.ics) return res.status(409).json({ error: "No HR calendar feed is set yet.", code: "no_feed" });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 45);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || "") ? req.query.start : new Date().toISOString().slice(0, 10);
    // A day of slack either side so local-time days at the edges are complete.
    const from = new Date(Date.parse(`${start}T00:00:00Z`) - 24 * 3600 * 1000);
    const to = new Date(from.getTime() + (days + 2) * 24 * 3600 * 1000);
    try {
      res.json({ events: await hrEvents(shared.ics, from, to) });
    } catch (err) {
      if (err instanceof FeedError) return res.status(409).json({ error: err.message, code: err.code });
      throw err;
    }
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
    const { username, password, email, companies, departments, fullAccess, manager, breakdown, leadership, calendarNames, pentagonCode } = req.body || {};
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

// IT requests from the Microsoft Form (see itrequests.js): every few
// minutes, each new "[IT Request]" email becomes an IT task for the IT
// default person. Handled ones are remembered in settings, so a task that's
// deleted later doesn't come back.
const IT_REQUESTS_EVERY_MS = 3 * 60 * 1000;
let itRequestsRunning = false;
async function syncItRequests() {
  if (!itRequestsConfigured || itRequestsRunning) return;
  itRequestsRunning = true;
  try {
    const found = await fetchItRequests();
    if (!found.length) return;
    const settings = await getSettings();
    const seen = new Set(settings.itRequestsSeen || []);
    const fresh = found.filter((r) => !seen.has(r.responseId || r.messageId));
    if (!fresh.length) return;
    const owner = (settings.departmentDefaults || {}).IT || "";
    const added = fresh.map((r, i) => ({
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
      requester: r.requester.slice(0, 120),
      formResponseId: r.responseId || r.messageId,
    }));
    await withTasks((tasks) => { tasks.unshift(...added.reverse()); });
    await withSettings((s) => {
      s.itRequestsSeen = [...fresh.map((r) => r.responseId || r.messageId), ...(s.itRequestsSeen || [])].slice(0, 1000);
    });
    console.log(`IT requests: added ${added.length} task(s) from ${IT_REQUESTS_MAILBOX}.`);
  } catch (err) {
    console.error("IT request sync failed (will retry):", err.message);
  } finally {
    itRequestsRunning = false;
  }
}
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
