require("dotenv").config();

// A staging copy (SEED_FROM_PREFIX set) works on a copy of live data, so it
// must never email anyone or read Microsoft 365: drop those settings before
// the mail modules read them.
if (process.env.SEED_FROM_PREFIX) {
  for (const name of ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_FROM_EMAIL", "IT_REQUESTS_MAILBOX"]) delete process.env[name];
  console.log("Staging: Microsoft 365 email and calendars are switched off.");
}
// Staging shows a practice email on Emails and never sends a reply (dry run).
const STAGING = !!process.env.SEED_FROM_PREFIX;

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
  passwordStamp,
  setUserCheck,
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
  copyFile,
  moveFile,
  keyPart,
  getSops,
  withSops,
  getPerformance,
  withPerformance,
  getBoard,
  withBoard,
  getMailIndex,
  withMailIndex,
  getInboxIgnored,
  withInboxIgnored,
  getQbr,
  withQbr,
  getStaffForms,
  withStaffForms,
  getPayroll,
  withPayroll,
  getPeople,
  withPeople,
  getDocuments,
  withDocuments,
  getLegal,
  withLegal,
  getStrategy,
  withStrategy,
  getImprovements,
  withImprovements,
  getChats,
  withChats,
} = require("./s3store");
const { sendMail, mailConfigured, MAIL_FROM } = require("./mailer");
const { eventsBetween, whosIn, CalendarError, nameFromTitle } = require("./calendar");
const { hrEvents, cleanFeedUrl, FeedError } = require("./hrcal");
const { itRequestsConfigured, fetchItRequests, IT_REQUESTS_MAILBOX, parseFormWorkbook, recordFromEmail, FormFileError, officeStamp } = require("./itrequests");
const { inboxThreads, syncFollowIndex, MailError, threadMessages, replyToMessage, sendAs, forgetInbox } = require("./mail");
const replies = require("./replies");
const { askClaude, invoke, AiError } = require("./bedrock");
const board = require("./board");
const forms = require("./staffforms");
const employment = require("./people");
const docs = require("./documents");
const legal = require("./legal");
const strategy = require("./strategy");
const improvements = require("./improvements");
const chat = require("./chat");
const payCheck = require("./payrollcheck");
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

// Every signed-in request is checked against the saved logins (read at most
// every 30 seconds): a deleted login or a changed password ends the
// sign-in, and access changes in /admin.html apply without signing out.
let usersSnap = { at: 0, list: null };
setUserCheck(async (payload) => {
  if (!usersSnap.list || Date.now() - usersSnap.at > 30000) usersSnap = { at: Date.now(), list: await getUsers() };
  const raw = usersSnap.list.find((u) => String(u.username).toLowerCase() === String(payload.sub || "").toLowerCase());
  if (!raw) return null;
  if (payload.pv && payload.pv !== passwordStamp(raw)) return null;
  const u = normalizeUser(raw);
  return { username: u.username, companies: u.companies, departments: u.departments, fullAccess: u.fullAccess, manager: u.manager, leadership: u.leadership, pentagonCode: u.pentagonCode };
});

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
// Strategy Meeting: a successful save whose text has #strategymeeting or
// @strategymeeting adds a row there (raiseFromNotes, with the routes).
app.use("/api", (req, res, next) => {
  if (!["POST", "PUT", "PATCH"].includes(req.method) || /^\/(strategy|login|admin|inbox|chat)(\/|$)/.test(req.path)) return next();
  const lines = req.body && !Buffer.isBuffer(req.body) ? strategy.taggedLines(req.body) : [];
  if (lines.length) res.on("finish", () => {
    if (res.statusCode < 400 && req.user) raiseFromNotes(req, lines).catch((err) => console.error("Strategy Meeting row from a note:", err.message));
  });
  next();
});

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
    const { username, password, remember } = req.body || {};
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
    const token = signUserToken(user, remember === true);
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
      // The same as /api/me, so they're right straight after signing in.
      legal: legal.hasLegal(user, await freshLegal()),
      docAdmin: docs.grantsAdmin(user),
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
    // Administration → Legal (Leadership plus the named staff; legal.js).
    legal: legal.hasLegal(req.user, await freshLegal()),
    // Documents: decides edit requests (the editors, IT and full access).
    docAdmin: docs.grantsAdmin(req.user),
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
    // Approved to pay is what a manager approved: others add notes only.
    if (list === "approvedToPay" && !manager && (op === "add" || op === "delete" || (op === "update" && Object.keys(fields).some((k) => k !== "notes")))) {
      return res.status(403).json({ error: "Only a manager can change an approved payment" });
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
    // The key names its list ("quotes:Q-1"; RFQs have no prefix), so a mark
    // can only be set through the list it belongs to.
    const keyView = Object.keys(VIEW_DEPARTMENTS).find((v) => key.startsWith(`${v}:`)) || "rfqs";
    if (keyView !== view) return res.status(400).json({ error: "That document isn't on this list" });
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
// when "Show in team breakdown" is ticked on their login in /admin.html, and
// only under their own departments (Procurement people under Procurement,
// Purchasing people under Purchasing).
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
        people: users.filter((u) => (u.departments || []).includes(department)).map((u) => {
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

// ---------- Operations board ----------
// One file (stored as a "card") per quote, RFQ → Quoted → Sale Received →
// Purchased → Item Received → Item Sent (rules in board.js). Staff see their
// own files and their department's stages; full-access and leadership logins
// see everything in their companies. Moving a file assigns it to that stage's
// manager (Board settings, else the department default). Every change is
// added to the file's history; files are archived, never deleted.
// Pentagon RFQs / Quotes / SOs / POs whose number isn't on a file yet show as
// files too (built on the fly, not stored); the first change to one stores it.
//
// The US Gov board (?board=usgov on every route) runs on the same routes and
// rules with its own stage names, its own S3 document and folders, and its
// own settings. Only US Government (and the top) see it, and its files never
// show on the Operations board or the other way round. Pentagon documents for
// the government customers listed in its settings land on it instead of on
// the Operations board.
const BOARDS = {
  ops: { id: "ops", name: "Operations board", depts: ["Procurement", "Purchasing", "Warehouse"], costDepts: ["Procurement", "Purchasing"], qualityDept: "Warehouse",
    store: "aog_board", files: "board_files", customerFiles: "board_customers", settingsKey: "board" },
  usgov: { id: "usgov", name: "US Gov board", depts: ["US Government"], costDepts: ["US Government"], qualityDept: "US Government",
    store: "usgov_board", files: "usgov_board_files", customerFiles: "usgov_board_customers", settingsKey: "usgovBoard" },
};
const boardOf = (req) => BOARDS[req.query.board] || BOARDS.ops;
const BOARD_BIG_TICKET = 25000;
function boardSettings(settings, cfg = BOARDS.ops) {
  const b = settings[cfg.settingsKey] || {};
  const out = { managers: b.managers || {}, globalManager: b.globalManager || "", bigTicket: Number(b.bigTicket) > 0 ? Number(b.bigTicket) : BOARD_BIG_TICKET };
  if (cfg.id === "usgov") out.customers = Array.isArray(b.customers) ? b.customers : [];
  return out;
}
// Pentagon customer accounts whose documents go to the US Gov board.
function govCustomers(settings) {
  return new Set(boardSettings(settings, BOARDS.usgov).customers.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
}
function stageManager(stage, settings, cfg = BOARDS.ops) {
  return boardSettings(settings, cfg).managers[stage] || (settings.departmentDefaults || {})[board.stageOf(stage, cfg.id).dept] || "";
}
const boardTop = (u) => !!(u.fullAccess || u.leadership);
function canSeeBoard(u, cfg = BOARDS.ops) { return boardTop(u) || cfg.depts.some((d) => (u.departments || []).includes(d)); }
// (Named apart from canSeeCard above, which is for the Pentagon task cards.)
function canSeeBoardCard(u, c, cfg = BOARDS.ops) {
  if (!(u.companies || []).includes(c.company) || !canSeeBoard(u, cfg)) return false;
  return boardTop(u) || sameUser(c.assignee, u.username) || sameUser(c.createdBy, u.username) || inDepartment(u, board.stageOf(c.stage, cfg.id).dept);
}
// Cost and mark-up: the people who source and buy (Procurement and
// Purchasing; US Government on its board) and the top. Margin: the top only.
const mayCost = (u, cfg = BOARDS.ops) => boardTop(u) || cfg.costDepts.some((d) => (u.departments || []).includes(d));
const mayMargin = (u) => boardTop(u);
function mayApprove(u, c, settings, cfg = BOARDS.ops) {
  return boardTop(u) || sameUser(stageManager(c.stage, settings, cfg), u.username) || (isManager(u) && inDepartment(u, board.stageOf(c.stage, cfg.id).dept));
}
function mayQuality(u, settings, cfg = BOARDS.ops) {
  return boardTop(u) || sameUser(stageManager("received", settings, cfg), u.username) || (isManager(u) && inDepartment(u, cfg.qualityDept));
}
function logCard(c, by, what) {
  c.history = c.history || [];
  c.history.push({ at: Date.now(), by, what });
  if (c.history.length > 500) c.history = c.history.slice(-500);
  c.updatedAt = Date.now();
}
// A card as the signed-in person may see it.
function shapeCard(c, u, now, cfg = BOARDS.ops) {
  const out = board.migrateCard(JSON.parse(JSON.stringify(c)));
  out.flags = board.flagsOf(out, now);
  out.hl = board.highlightedFile(out);
  out.onTime = board.onTime(out, now);
  out.total = board.quoteTotal(c);
  out.approvalBlockers = {};
  for (const kind of Object.values(board.APPROVALS)) out.approvalBlockers[kind] = board.approvalBlockers(c, kind);
  const next = board.STAGE_IDS[board.STAGE_IDS.indexOf(c.stage) + 1];
  out.next = next || "";
  out.moveBlockers = next ? board.moveBlockers(c, next) : [];
  for (const l of out.lines || []) {
    if (mayMargin(u)) l.margin = l.price > 0 && l.cost > 0 ? Math.round(((l.price - l.cost) / l.price) * 1000) / 10 : null;
    if (!mayCost(u, cfg)) { delete l.cost; delete l.markup; }
  }
  return out;
}
async function boardCard(req, res) {
  const cfg = boardOf(req);
  const doc = await getBoard(cfg.store);
  const c = (doc.cards || []).find((x) => x.id === req.params.id);
  if (!c || !canSeeBoardCard(req.user, c, cfg)) { res.status(404).json({ error: "That card isn't here" }); return null; }
  return c;
}
// Change one card inside the board queue; fn returns an error string to stop.
// fn gets (card, settings, doc, cfg), cfg being the board it's on.
async function changeCard(req, res, fn) {
  const now = Date.now();
  const cfg = boardOf(req);
  const settings = await getSettings();
  const out = await withBoard(async (doc) => {
    const c = (doc.cards || []).find((x) => x.id === req.params.id);
    if (!c || !canSeeBoardCard(req.user, c, cfg)) return { status: 404, error: "That card isn't here" };
    board.migrateCard(c);
    const err = await fn(c, settings, doc, cfg);
    if (err) return { status: 400, error: err };
    return { card: c };
  }, cfg.store);
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(shapeCard(out.card, req.user, now, cfg));
  return out.card;
}

// Each stored board file has its own folder in S3, named so people can find
// it in the bucket: <files>/<number> - <customer>/ (e.g. "board_files/RFQ
// 10234 - Example Airline/"), with the attachments inside under their own
// names. An empty marker object keeps the folder visible before anything is
// attached. Changing the number or customer renames the folder. c.folder and
// file.key hold the names; attachments from before this kept
// <files>/<card id>/<attachment id> until syncBoardFolder moves them (every
// stored file, once at startup). Customer documents: <customerFiles>/<customer>/<name>.
function boardFolderName(doc, c) {
  const no = c.fileNo ? c.fileNo : c.rfqNo ? `RFQ ${c.rfqNo}` : c.quoteNo ? `Quote ${c.quoteNo}` : c.orderNo ? `SO ${c.orderNo}` : c.poNo ? `PO ${c.poNo}` : "";
  const party = c.customer || c.vendor || "";
  let name = keyPart(no ? [no, party].filter(Boolean).join(" - ") : `${party || "File"} - ${c.id.slice(-6)}`);
  if ((doc.cards || []).some((x) => x.id !== c.id && x.folder === name)) name = `${name} (${c.id.slice(-4)})`;
  return name;
}
// A file name not already used in that folder: "Quote.pdf", "Quote (2).pdf"…
function uniqueFileName(taken, name) {
  const clean = keyPart(name, "file");
  const m = clean.match(/^(.*?)(\.[A-Za-z0-9]{1,6})?$/);
  let out = clean, n = 1;
  while (taken.has(out.toLowerCase())) out = `${m[1]} (${++n})${m[2] || ""}`;
  return out;
}
const boardFileKey = (cfg, c, f) => f.key || `${cfg.files}/${c.id}/${f.id}`;
const customerFileKey = (cfg, f) => f.key || `${cfg.customerFiles}/${f.id}`;
const boardSyncing = new Set();
// Move a stored file's attachments into its named folder and save the names.
async function syncBoardFolder(cfg, cardId) {
  const lock = `${cfg.id}:${cardId}`;
  if (boardSyncing.has(lock)) return null;
  boardSyncing.add(lock);
  try {
    const doc = await getBoard(cfg.store);
    const c = (doc.cards || []).find((x) => x.id === cardId);
    if (!c) return null;
    const folder = boardFolderName(doc, c), base = `${cfg.files}/${folder}`;
    const taken = new Set(), keys = {};
    for (const f of c.files || []) {
      const want = f.key && f.key.startsWith(`${base}/`) ? f.key : `${base}/${uniqueFileName(taken, f.key ? f.key.split("/").pop() : f.name)}`;
      taken.add(want.split("/").pop().toLowerCase());
      if (want !== boardFileKey(cfg, c, f) && !(await moveFile(boardFileKey(cfg, c, f), want))) continue;
      keys[f.id] = want;
    }
    if (c.folder !== folder) {
      await putFile(`${base}/`, Buffer.alloc(0), "application/x-directory");
      if (c.folder) await deleteFile(`${cfg.files}/${c.folder}/`).catch(() => {});
    }
    await withBoard((d) => {
      const x = (d.cards || []).find((y) => y.id === cardId);
      if (!x) return;
      x.folder = folder;
      for (const f of x.files || []) if (keys[f.id]) f.key = keys[f.id];
    }, cfg.store);
    return folder;
  } catch (err) {
    console.error(`Board folder for ${cardId} failed (kept the old names):`, err.message);
    return null;
  } finally {
    boardSyncing.delete(lock);
  }
}
// Where a new attachment goes: the file's folder, under a free name.
async function newBoardFileKey(cfg, cardId, name) {
  await syncBoardFolder(cfg, cardId);
  const c = ((await getBoard(cfg.store)).cards || []).find((x) => x.id === cardId);
  const folder = (c && c.folder) || cardId;
  const taken = new Set(((c && c.files) || []).map((f) => (f.key || "").split("/").pop().toLowerCase()).filter(Boolean));
  return `${cfg.files}/${folder}/${uniqueFileName(taken, name)}`;
}
async function syncCustomerFiles(cfg) {
  const doc = await getBoard(cfg.store), keys = {};
  for (const [customer, x] of Object.entries(doc.customers || {})) {
    const taken = new Set();
    for (const f of x.files || []) {
      const base = `${cfg.customerFiles}/${keyPart(customer, "Customer")}`;
      const want = f.key && f.key.startsWith(`${base}/`) ? f.key : `${base}/${uniqueFileName(taken, f.name)}`;
      taken.add(want.split("/").pop().toLowerCase());
      if (want !== customerFileKey(cfg, f) && (await moveFile(customerFileKey(cfg, f), want))) keys[f.id] = want;
    }
  }
  if (Object.keys(keys).length) await withBoard((d) => { for (const x of Object.values(d.customers || {})) for (const f of x.files || []) if (keys[f.id]) f.key = keys[f.id]; }, cfg.store);
}
setTimeout(async () => {
  for (const cfg of Object.values(BOARDS)) {
    try {
      for (const c of (await getBoard(cfg.store)).cards || []) await syncBoardFolder(cfg, c.id);
      await syncCustomerFiles(cfg);
    } catch (err) { console.error(`${cfg.name} folders:`, err.message); }
  }
}, 20 * 1000);

// Pentagon RFQs / Quotes / SOs / POs not yet on a stored file, grouped one
// file per document number (one line item per row's P/N). A document drops
// off this list as soon as its number is typed on (or stored with) a file on
// either board. Documents for the government customers in the US Gov board's
// settings go to that board; the rest to the Operations board. POs name the
// vendor, not the customer, so they all stay on the Operations board until
// their number is typed on a US Gov file.
async function pentagonBoardFiles(cfg, settings) {
  const views = allViews().filter((v) => board.PENTAGON_STAGE[v.id] && (cfg.id === "ops" || v.id !== "purchase_orders"));
  const gov = govCustomers(settings);
  const taken = new Set();
  const docs = await Promise.all(Object.values(BOARDS).map((b) => getBoard(b.store)));
  for (const doc of docs) for (const c of doc.cards || []) for (const k of board.NUMBER_FIELDS) if (c[k]) taken.add(`${k}:${String(c[k]).toLowerCase()}`);
  const users = (await getUsers()).map(normalizeUser);
  const byCode = new Map(users.filter((u) => u.pentagonCode).map((u) => [u.pentagonCode.trim().toLowerCase(), u.username]));
  const files = new Map(), errors = [];
  for (const view of views) {
    const { rows, error } = await cachedRows(view);
    if (error) errors.push(`${view.label}: ${error}`);
    const [stage, field] = board.PENTAGON_STAGE[view.id];
    for (const row of rows) {
      const f = (name) => { const k = resolveField(view, row, name); return k ? cell(row[k]).trim() : ""; };
      const docNo = f("key");
      if (!docNo || taken.has(`${field}:${docNo.toLowerCase()}`)) continue;
      if (view.id !== "purchase_orders" && gov.has(f("party").toLowerCase()) !== (cfg.id === "usgov")) continue;
      const id = `pg:${view.id}:${docNo}`;
      let file = files.get(id);
      if (!file) {
        const who = f("person"), user = who ? byCode.get(who.toLowerCase()) : "";
        file = {
          id, virtual: true, source: "pentagon", pentagonView: view.id, company: "SOI Aviation", stage, [field]: docNo,
          customer: view.id === "purchase_orders" ? "" : f("party"), vendor: view.id === "purchase_orders" ? f("party") : "",
          dueDate: /^\d{4}-\d{2}-\d{2}/.test(f("due")) ? f("due").slice(0, 10) : "", assignee: user || who, platforms: "",
          lines: [], checks: {}, approvals: {}, notes: [], files: [], links: [], history: [],
          createdAt: Date.parse(f("entered")) || 0, createdBy: user || who,
        };
        files.set(id, file);
      }
      const pn = f("part");
      if (pn && !file.lines.some((l) => l.pn === pn)) file.lines.push({ id: `p${file.lines.length + 1}`, pn, qty: 1 });
    }
  }
  return { files: [...files.values()], errors };
}

app.get(
  "/api/board",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const cfg = boardOf(req);
    if (!canSeeBoard(req.user, cfg)) return res.status(403).json({ error: cfg.id === "usgov" ? "The US Gov board is for US Government" : "The board is for Procurement, Purchasing and Warehouse" });
    const company = String(req.query.company || "");
    const [doc, settings, users] = await Promise.all([getBoard(cfg.store), getSettings(), getUsers()]);
    const now = Date.now();
    const archived = req.query.archived === "1";
    const pentagon = archived || !req.user.companies.includes("SOI Aviation") ? { files: [], errors: [] } : await pentagonBoardFiles(cfg, settings);
    const cards = (doc.cards || []).filter((c) => !c.archived === !archived).concat(pentagon.files)
      .filter((c) => (!company || c.company === company) && canSeeBoardCard(req.user, c, cfg));
    const boardPeople = users.map(normalizeUser).filter((u) => cfg.depts.some((d) => u.departments.includes(d)) || u.fullAccess)
      .filter((u) => u.companies.some((co) => req.user.companies.includes(co)));
    const people = boardPeople.map((u) => u.username).sort((a, b) => a.localeCompare(b));
    // Each person's board departments, for the row colours.
    const peopleDepts = Object.fromEntries(boardPeople.map((u) => [u.username, cfg.depts.filter((d) => u.departments.includes(d))]));
    const customers = {};
    for (const [name, x] of Object.entries(doc.customers || {})) customers[name] = { files: (x.files || []) };
    res.json({
      board: cfg.id, stages: board.stagesOf(cfg.id), checks: board.CHECKS, approvals: board.APPROVALS,
      cards: cards.map((c) => shapeCard(c, req.user, now, cfg)),
      people, peopleDepts, customers, pentagonErrors: pentagon.errors,
      managers: Object.fromEntries(board.STAGE_IDS.map((s) => [s, stageManager(s, settings, cfg)])),
      settings: boardTop(req.user) ? boardSettings(settings, cfg) : null,
      can: { cost: mayCost(req.user, cfg), margin: mayMargin(req.user), quality: mayQuality(req.user, settings, cfg), settings: boardTop(req.user), assign: isManager(req.user) || boardTop(req.user) },
    });
  })
);

app.post(
  "/api/board",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const cfg = boardOf(req), addDept = board.stageOf("rfq", cfg.id).dept;
    if (!canSeeBoard(req.user, cfg) || !(boardTop(req.user) || inDepartment(req.user, addDept))) return res.status(403).json({ error: `New files are added by ${addDept}` });
    const b = req.body || {};
    const company = String(b.company || "");
    if (!req.user.companies.includes(company)) return res.status(400).json({ error: "Pick a company" });
    const customer = board.text(b.customer, 120);
    if (!customer) return res.status(400).json({ error: "Who's the customer?" });
    const settings = await getSettings();
    const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 50).map((l) => board.cleanLine(l, null, { cost: mayCost(req.user, cfg), quality: false, username: req.user.username })).filter((l) => l.pn);
    const card = {
      id: newId(), company, customer, fileNo: board.text(b.fileNo, 40), rfqNo: board.text(b.rfqNo, 40), quoteNo: board.text(b.quoteNo, 40), orderNo: "", poNo: "",
      platforms: board.text(b.platforms, 120), stage: "rfq",
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(b.dueDate || "") ? b.dueDate : "",
      assignee: board.text(b.assignee, 60) || stageManager("rfq", settings, cfg) || req.user.username,
      lines, checks: {}, approvals: {}, notes: [], files: [], history: [], createdAt: Date.now(), createdBy: req.user.username,
    };
    logCard(card, req.user.username, `Added the file for ${customer}`);
    await withBoard((doc) => { doc.cards = doc.cards || []; doc.cards.push(card); }, cfg.store);
    card.folder = await syncBoardFolder(cfg, card.id);
    res.status(201).json(shapeCard(card, req.user, Date.now(), cfg));
  })
);

app.patch(
  "/api/board/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    // A new number or customer renames the file's folder in S3 afterwards.
    if (["customer", "fileNo", "rfqNo", "quoteNo", "orderNo", "poNo"].some((k) => k in b)) res.on("finish", () => { if (res.statusCode < 300) syncBoardFolder(boardOf(req), req.params.id); });
    await changeCard(req, res, (c, settings, doc, cfg) => {
      const by = req.user.username, said = [];
      for (const [k, n, label] of [["customer", 120, "customer"], ["platforms", 120, "platform(s)"], ["fileNo", 40, "file number"], ["rfqNo", 40, "RFQ number"],
        ["quoteNo", 40, "quote number"], ["orderNo", 40, "sales order number"], ["poNo", 40, "PO number"]]) {
        if (k in b && board.text(b[k], n) !== (c[k] || "")) { c[k] = board.text(b[k], n); said.push(`${label} → ${c[k] || "blank"}`); }
      }
      if ("dueDate" in b) { const d = /^\d{4}-\d{2}-\d{2}$/.test(b.dueDate || "") ? b.dueDate : ""; if (d !== (c.dueDate || "")) { c.dueDate = d; said.push(`due date → ${d || "none"}`); } }
      // Old-board files with no lines still carry a whole-file highlight.
      if ("highlighted" in b && !b.highlighted && c.highlighted) { delete c.highlighted; said.push("highlight removed"); }
      if ("assignee" in b && board.text(b.assignee, 60) !== (c.assignee || "")) {
        if (!(isManager(req.user) || boardTop(req.user))) return "Only a manager can reassign a card";
        c.assignee = board.text(b.assignee, 60); said.push(`assigned to ${c.assignee || "nobody"}`);
      }
      if (b.checks && typeof b.checks === "object") {
        c.checks = c.checks || {};
        for (const list of Object.values(board.CHECKS)) for (const ch of list) {
          if (ch.id in b.checks && !!b.checks[ch.id] !== !!c.checks[ch.id]) { c.checks[ch.id] = !!b.checks[ch.id]; said.push(`${ch.label}: ${c.checks[ch.id] ? "✓" : "unticked"}`); }
        }
        // An approval given on a complete file doesn't survive unticking it.
        for (const [stage, kind] of [["rfq", "sourcing"], ["sale", "purchase"]]) {
          if (board.approval(c, kind).state === "approved" && !board.checksDone(c, stage)) { c.approvals[kind] = { state: "" }; said.push(`${board.APPROVAL_LABEL[kind]} approval reset (file no longer complete)`); }
        }
      }
      if (Array.isArray(b.lines)) {
        const may = { cost: mayCost(req.user, cfg), quality: mayQuality(req.user, settings, cfg), username: by };
        if (b.lines.some((l, i) => l && "qualityOk" in l && !may.quality && !!l.qualityOk !== !!((c.lines || []).find((p) => p.id === l.id) || {}).qualityOk)) return cfg.id === "usgov" ? "Only a US Government manager signs off quality" : "Only the warehouse manager signs off quality";
        const before = JSON.stringify((c.lines || []).map((l) => [l.pn, l.qty, l.price]));
        const prevById = new Map((c.lines || []).map((l) => [l.id, l]));
        const lines = b.lines.slice(0, 50).map((l) => board.cleanLine(l || {}, prevById.get(l && l.id), may));
        for (const l of lines) {
          const p = prevById.get(l.id);
          if (p && !!p.qualityOk !== !!l.qualityOk) said.push(`quality ${l.qualityOk ? "signed off" : "sign-off removed"} on ${l.pn || "a line"}`);
          if (!!(p && p.highlighted) !== !!l.highlighted) said.push(`${l.pn || "a line"} ${l.highlighted ? "highlighted (not found online)" : "no longer highlighted"}`);
        }
        c.lines = lines;
        board.migrateCard(c);
        said.push("lines updated");
        // A quote approved at one price isn't approved at another.
        if (board.approval(c, "quote").state === "approved" && JSON.stringify(c.lines.map((l) => [l.pn, l.qty, l.price])) !== before) {
          c.approvals.quote = { state: "" }; said.push("Quote approval reset (lines or prices changed)");
        }
      }
      if (said.length) logCard(c, by, said.join("; "));
    });
  })
);

app.post(
  "/api/board/:id/move",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const to = String((req.body || {}).to || "");
    if (!board.STAGE_IDS.includes(to)) return res.status(400).json({ error: "Unknown column" });
    const card = await changeCard(req, res, (c, settings, doc, cfg) => {
      const from = board.STAGE_IDS.indexOf(c.stage), dest = board.STAGE_IDS.indexOf(to);
      if (dest === from) return "It's already there";
      if (dest > from + 1) return "Cards move one column at a time";
      if (dest < from && !(mayApprove(req.user, c, settings, cfg) || boardTop(req.user))) return "Only a manager can move a card back";
      if (dest === from + 1 && !(canSeeBoardCard(req.user, c, cfg) && (inDepartment(req.user, board.stageOf(c.stage, cfg.id).dept) || sameUser(c.assignee, req.user.username) || boardTop(req.user)))) return "You can't move this card";
      const stops = board.moveBlockers(c, to);
      if (stops.length) return "Not yet: " + stops.join("; ");
      // Going back clears the approvals from the stages it left.
      if (dest < from) for (const [stage, kind] of Object.entries(board.APPROVALS)) if (board.STAGE_IDS.indexOf(stage) >= dest) c.approvals[kind] = { state: "" };
      const prev = c.assignee;
      if (to === "quoted" && !c.quotedAt) c.quotedAt = Date.now();
      c.stage = to;
      c.assignee = stageManager(to, settings, cfg) || c.assignee;
      logCard(c, req.user.username, `Moved to ${board.stageOf(to, cfg.id).label}` + (c.assignee !== prev ? `, assigned to ${c.assignee}` : ""));
    });
    const cfg = boardOf(req);
    if (card && card.assignee) notifyBoardAssignee(card, `${board.stageOf(card.stage, cfg.id).label}: ${cardLabel(card)}`, cfg).catch(() => {});
  })
);

function cardLabel(c) {
  const no = c.fileNo || c.quoteNo || c.rfqNo;
  const n = (no ? `File ${no}` : "New file") + (board.STAGE_IDS.indexOf(c.stage) >= 2 && c.orderNo ? ` (SO ${c.orderNo})` : "");
  return `${n} — ${c.customer || c.vendor || "no customer yet"}`;
}
async function notifyBoardAssignee(c, subject, cfg = BOARDS.ops) {
  const u = (await getUsers()).find((x) => sameUser(x.username, c.assignee));
  if (!u || !u.email) return;
  await sendMail({
    to: u.email,
    subject: `${cfg.name} — ${subject}`,
    html: `<p>A file on the ${escapeHtml(cfg.name)} is now with you (${escapeHtml(board.stageOf(c.stage, cfg.id).label)}):</p><p><strong>${escapeHtml(cardLabel(c))}</strong></p>` +
      (c.dueDate ? `<p>Due: ${escapeHtml(c.dueDate)}</p>` : "") + `<p>Open the tracker's board to work it.</p>`,
  });
}

app.post(
  "/api/board/:id/approval",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const decision = b.decision === "approve" ? "approved" : b.decision === "reject" ? "rejected" : "";
    if (!decision) return res.status(400).json({ error: "Approve or reject" });
    let followUp = null;
    const cfg = boardOf(req);
    const card = await changeCard(req, res, (c, settings) => {
      const kind = board.APPROVALS[c.stage];
      if (!kind || kind !== b.kind) return "Nothing to approve in this column";
      if (!mayApprove(req.user, c, settings, cfg)) return "Only this stage's manager can approve";
      const blockers = board.approvalBlockers(c, kind);
      if (decision === "approved" && blockers.length) return "Not ready: " + blockers.join("; ");
      const note = board.text(b.note, 500);
      c.approvals = c.approvals || {};
      c.approvals[kind] = { state: decision, by: req.user.username, at: Date.now(), note };
      logCard(c, req.user.username, `${board.APPROVAL_LABEL[kind]} ${decision === "approved" ? "✓ approved" : "✗ rejected"}${note ? ": " + note : ""}`);
      if (kind === "quote" && decision === "rejected") {
        const s = boardSettings(settings, cfg), total = board.quoteTotal(c);
        followUp = { card: JSON.parse(JSON.stringify(c)), big: total >= s.bigTicket && s.globalManager, globalManager: s.globalManager, total };
        if (followUp.big) logCard(c, req.user.username, `Big-ticket rejection ($${total.toLocaleString("en-US")}) flagged to ${s.globalManager}`);
      }
    });
    // A rejected quote gets a feedback follow-up task; a big one also goes
    // to the global manager.
    if (card && followUp) {
      const c = followUp.card, due = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
      const mk = (owner, title, priority) => ({ id: newId(), title, company: c.company, department: board.stageOf("rfq", cfg.id).dept, status: "todo", priority, owner, dueDate: due,
        notes: `From the ${cfg.id === "usgov" ? cfg.name : "AOG board"} (${cardLabel(c)}). ${c.approvals.quote.note ? "Why: " + c.approvals.quote.note : ""}`.trim(), createdAt: Date.now(), createdBy: req.user.username, kind: "task" });
      const made = [mk(c.assignee || c.createdBy, `Ask ${c.customer} for feedback on rejected quote ${c.quoteNo || ""}`.replace(/\s+/g, " ").trim(), "medium")];
      if (followUp.big) made.push(mk(followUp.globalManager, `Big-ticket quote rejected: ${cardLabel(c)} ($${Math.round(followUp.total).toLocaleString("en-US")})`, "high"));
      await withTasks((tasks) => { tasks.unshift(...made); });
      for (const t of made) notifyOwner(t).catch(() => {});
    }
  })
);

app.post(
  "/api/board/:id/notes",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const t = String(b.text || "").trim().slice(0, 4000);
    if (!t) return res.status(400).json({ error: "Write a note first" });
    // A manager's feedback / next step can carry a deadline and a person
    // (the file's responsible person by default); it then also becomes a
    // task for them, so it shows on their Mentions of You.
    const manager = !!b.manager && (isManager(req.user) || boardTop(req.user));
    const due = manager && /^\d{4}-\d{2}-\d{2}$/.test(b.due || "") ? b.due : "";
    let task = null;
    const card = await changeCard(req, res, (c, settings, doc, cfg) => {
      const forWho = manager ? board.text(b.for, 60) || c.assignee || "" : "";
      const note = { id: newId(), text: t, by: req.user.username, at: Date.now(), manager };
      if (manager && forWho) {
        task = { id: newId(), title: `Next step on ${cardLabel(c)}: ${t.split("\n")[0]}`.slice(0, 200), company: c.company,
          department: board.stageOf(c.stage, cfg.id).dept, status: "todo", priority: due ? "high" : "medium", owner: forWho, dueDate: due,
          notes: `From the ${cfg.name} (${cardLabel(c)}), by ${req.user.username}:\n${t}`, createdAt: Date.now(), createdBy: req.user.username, kind: "task" };
        Object.assign(note, { for: forWho, due, taskId: task.id });
      }
      c.notes = c.notes || [];
      c.notes.push(note);
      logCard(c, req.user.username, manager ? `Added manager feedback${forWho ? ` for ${forWho}` : ""}${due ? `, due ${due}` : ""}` : "Added a note");
    });
    if (card && task) {
      await withTasks((tasks) => { tasks.unshift(task); });
      notifyOwner(task).catch(() => {});
    }
  })
);

// Flag a line item (anyone who can see the file), to pick it out in meetings.
app.post(
  "/api/board/:id/lines/:lid/flag",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const flagged = !!(req.body || {}).flagged;
    await changeCard(req, res, (c) => {
      const l = (c.lines || []).find((x) => x.id === req.params.lid);
      if (!l) return "That line isn't on this file";
      if (!!l.flagged === flagged) return;
      Object.assign(l, { flagged, flaggedBy: flagged ? req.user.username : "", flaggedAt: flagged ? Date.now() : 0 });
      logCard(c, req.user.username, `${flagged ? "Flagged" : "Unflagged"} ${l.pn || "a line"}`);
    });
  })
);

// No Quote: SOI isn't quoting this file. Anyone who can see it ticks or
// unticks it in any column; the file stays where it is and moving it keeps it.
app.post(
  "/api/board/:id/noquote",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const on = !!(req.body || {}).noQuote;
    await changeCard(req, res, (c) => {
      if (!!c.noQuote === on) return;
      if (on) c.noQuote = { by: req.user.username, at: Date.now() };
      else delete c.noQuote;
      logCard(c, req.user.username, on ? "Marked No Quote" : "No Quote removed");
    });
  })
);

// Store a Pentagon document's file the first time someone works on it.
app.post(
  "/api/board/adopt",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const id = String((req.body || {}).id || "");
    const cfg = boardOf(req);
    if (!canSeeBoard(req.user, cfg) || !id.startsWith("pg:")) return res.status(400).json({ error: "That isn't a Pentagon file" });
    const { files } = await pentagonBoardFiles(cfg, await getSettings());
    const src = files.find((f) => f.id === id);
    if (!src || !canSeeBoardCard(req.user, src, cfg)) {
      // Already stored (someone else got there first, or its number was typed on a file)?
      const [, view, no] = id.match(/^pg:([^:]+):(.*)$/) || [];
      const field = (board.PENTAGON_STAGE[view] || [])[1];
      const doc = await getBoard(cfg.store);
      const have = field && (doc.cards || []).find((c) => String(c[field] || "").toLowerCase() === String(no).toLowerCase() && canSeeBoardCard(req.user, c, cfg));
      if (have) return res.json(shapeCard(have, req.user, Date.now(), cfg));
      return res.status(404).json({ error: "That Pentagon document isn't on the board any more" });
    }
    const card = Object.assign(JSON.parse(JSON.stringify(src)), { id: newId(), pentagonKey: id, createdBy: src.createdBy || req.user.username });
    delete card.virtual;
    if (card.stage === "quoted") card.quotedAt = card.createdAt || Date.now();
    if (!card.createdAt) card.createdAt = Date.now();
    logCard(card, req.user.username, `Put on the board from Pentagon (${id.slice(3).replace(":", " ")})`);
    let stored = card;
    await withBoard((doc) => {
      doc.cards = doc.cards || [];
      const [, field] = board.PENTAGON_STAGE[src.pentagonView];
      stored = doc.cards.find((c) => c.pentagonKey === id || (c[field] && String(c[field]).toLowerCase() === String(src[field]).toLowerCase())) || card;
      if (stored === card) doc.cards.push(card);
    }, cfg.store);
    if (stored === card) card.folder = await syncBoardFolder(cfg, card.id);
    res.status(stored === card ? 201 : 200).json(shapeCard(stored, req.user, Date.now(), cfg));
  })
);

// Links on the case file: websites (with an optional screenshot added as a
// file), emails and Teams messages (link and / or the text pasted in).
const BOARD_FILE_KINDS = ["picture", "pdf", "website", "email", "teams", "other"];
app.post(
  "/api/board/:id/links",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const kind = ["website", "email", "teams"].includes(b.kind) ? b.kind : "";
    if (!kind) return res.status(400).json({ error: "Website, email or Teams message" });
    const url = board.text(b.url, 1000), title = board.text(b.title, 200), note = String(b.text || "").trim().slice(0, 4000);
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Links start with https://" });
    if (!url && !note) return res.status(400).json({ error: "Add a link or paste the text" });
    await changeCard(req, res, (c) => {
      c.links = c.links || [];
      c.links.push({ id: newId(), kind, url, title, text: note, by: req.user.username, at: Date.now(), stage: c.stage });
      logCard(c, req.user.username, `Added ${kind === "teams" ? "a Teams message" : kind === "email" ? "an email" : "a website"}${title ? ": " + title : ""}`);
    });
  })
);

app.post(
  "/api/board/:id/archive",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const archived = !!(req.body || {}).archived;
    await changeCard(req, res, (c) => {
      if (!(isManager(req.user) || boardTop(req.user))) return "Only a manager can archive a card";
      c.archived = archived;
      logCard(c, req.user.username, archived ? "Archived" : "Restored from the archive");
    });
  })
);

// Case-file attachments (PDFs, pictures, invoices, screenshots, emails), up to
// 15 MB each, stored under board_files/<card>/ in S3 (usgov_board_files/ for
// the US Gov board). Like every stored document they're view-only: shown in
// the page, never offered as a download (sendViewOnly).
function boardFileMeta(req) {
  const name = String(req.query.name || "file").replace(/[\\/\r\n"]+/g, "_").slice(0, 160);
  const ext = (name.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  const type = ext && PERF_FILE_TYPES[ext.toLowerCase()];
  return { name, type };
}
// Every stored document goes out through here, view-only (ROADMAP.md
// Phase 6): PDFs, pictures and text inline for the page's viewer, never as
// an attachment, never cached; anything else (Word, Excel, email…) is
// refused, because the browser can't show it without downloading it.
// This discourages copying; it can't stop a screenshot.
function sendViewOnly(res, meta, file) {
  const ext = (String(meta.name || "").match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  const type = [meta.type, file.contentType, ext && PERF_FILE_TYPES[ext.toLowerCase()]].find((t) => t && docs.canPreview(t));
  if (!type) return res.status(415).json({ error: "This kind of file can't be shown in the browser, and downloading is switched off. Ask whoever added it for a PDF." });
  res.set({
    "Content-Type": type.startsWith("text/") ? type + "; charset=utf-8" : type,
    "Content-Disposition": `inline; filename="${String(meta.name || "document").replace(/[^\w .()-]+/g, "_")}"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  });
  if (type !== "application/pdf") res.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.send(file.body);
}
app.post(
  "/api/board/:id/files",
  authMiddleware,
  express.raw({ type: () => true, limit: "15mb" }),
  asyncHandler(async (req, res) => {
    const { name, type } = boardFileMeta(req);
    if (!type) return res.status(400).json({ error: "Attach a PDF, image, Word, Excel, PowerPoint, text or email file" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file came through" });
    const c0 = await boardCard(req, res);
    if (!c0) return;
    // Kind is the case-file tab it was added on; stage says whether it's
    // part of the black file (RFQ / Quoted) or the red file (Sale on).
    const kind = BOARD_FILE_KINDS.includes(req.query.kind) ? req.query.kind : type.startsWith("image/") ? "picture" : type === "application/pdf" ? "pdf" : /outlook|rfc822/.test(type) ? "email" : "other";
    const file = { id: newId(), name, type, size: req.body.length, at: Date.now(), by: req.user.username, kind, stage: c0.stage };
    file.key = await newBoardFileKey(boardOf(req), c0.id, name);
    await putFile(file.key, req.body, type);
    await changeCard(req, res, (c) => { c.files = c.files || []; c.files.push(file); logCard(c, req.user.username, `Attached ${name}`); });
  })
);
app.get(
  "/api/board/:id/files/:fid",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const c = await boardCard(req, res);
    if (!c) return;
    const meta = (c.files || []).find((f) => f.id === req.params.fid);
    const file = meta && (await getFile(boardFileKey(boardOf(req), c, meta)));
    if (!file) return res.status(404).json({ error: "That file isn't here" });
    sendViewOnly(res, meta, file);
  })
);

// Customer file documents (export licences, certificates…), by customer name.
app.post(
  "/api/board-customers/files",
  authMiddleware,
  express.raw({ type: () => true, limit: "15mb" }),
  asyncHandler(async (req, res) => {
    const cfg = boardOf(req);
    if (!canSeeBoard(req.user, cfg)) return res.status(403).json({ error: "Not available for your account" });
    const customer = board.text(req.query.customer, 120);
    const { name, type } = boardFileMeta(req);
    if (!customer) return res.status(400).json({ error: "Which customer?" });
    if (!type) return res.status(400).json({ error: "Attach a PDF, image, Word, Excel, PowerPoint, text or email file" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file came through" });
    const file = { id: newId(), name, type, size: req.body.length, at: Date.now(), by: req.user.username };
    const have = ((await getBoard(cfg.store)).customers || {})[customer];
    file.key = `${cfg.customerFiles}/${keyPart(customer, "Customer")}/${uniqueFileName(new Set(((have && have.files) || []).map((f) => (f.key || "").split("/").pop().toLowerCase())), name)}`;
    await putFile(file.key, req.body, type);
    await withBoard((doc) => { doc.customers = doc.customers || {}; const x = (doc.customers[customer] = doc.customers[customer] || { files: [] }); x.files.push(file); }, cfg.store);
    res.status(201).json(file);
  })
);
app.get(
  "/api/board-customers/files/:fid",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const cfg = boardOf(req);
    if (!canSeeBoard(req.user, cfg)) return res.status(403).json({ error: "Not available for your account" });
    const doc = await getBoard(cfg.store);
    let meta = null;
    for (const x of Object.values(doc.customers || {})) meta = meta || (x.files || []).find((f) => f.id === req.params.fid);
    const file = meta && (await getFile(customerFileKey(cfg, meta)));
    if (!file) return res.status(404).json({ error: "That file isn't here" });
    sendViewOnly(res, meta, file);
  })
);

// Stage managers, the global manager and the big-ticket amount (and, on the
// US Gov board, the government customer accounts).
app.put(
  "/api/board-settings",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!boardTop(req.user)) return res.status(403).json({ error: "Full-access or leadership logins only" });
    const b = req.body || {};
    const managers = {};
    for (const s of board.STAGE_IDS) if (b.managers && b.managers[s]) managers[s] = board.text(b.managers[s], 60);
    const cfg = boardOf(req);
    const next = { managers, globalManager: board.text(b.globalManager, 60), bigTicket: Number(b.bigTicket) > 0 ? Math.round(Number(b.bigTicket)) : BOARD_BIG_TICKET };
    if (cfg.id === "usgov") next.customers = [...new Set((Array.isArray(b.customers) ? b.customers : []).map((x) => board.text(x, 120)).filter(Boolean))].slice(0, 500);
    await withSettings((s) => { s[cfg.settingsKey] = next; });
    res.json(next);
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

// Work inbox: Outlook inbox mail, read and unread (last 1–14 days), one row per
// conversation, Outlook's preview text, no AI. Always the email on the
// person's login, plus any shared mailboxes an admin added to it ("Extra
// inboxes" in /admin.html) — never a mailbox named by the browser. Each item
// says which mailbox it's from; items from extra mailboxes get ids prefixed
// with the mailbox so "Done" ticks don't collide.
// Which company address a message was sent to, for shared inboxes that
// several company addresses deliver into (e.g. a supervisor mailbox for
// SOI, CAS, Red Sun and Nanotech). Looks at the To / CC addresses, split
// into words: "nano" / "nanotech" → NanoTech, "redsun" → RedSun, "cas" →
// CAS, "soi" / "soiaviation" → SOI. An address with the mailbox's own name
// (e.g. supervisor@…) wins over others on the same message.
const INBOX_CO_WORDS = [[/^nano(tech)?/, "NanoTech"], [/^red-?sun/, "RedSun"], [/^cas$|^casaviation$/, "CAS"], [/^soi(aviation)?$/, "SOI"]];
function companyOfAddress(addr) {
  const words = String(addr || "").toLowerCase().split(/[@.\-_+]+/).filter(Boolean);
  for (const [re, co] of INBOX_CO_WORDS) if (words.some((w) => re.test(w))) return { co, address: String(addr).toLowerCase() };
  return null;
}
function companyOfMessage(t, mailbox) {
  const local = String(mailbox || "").split("@")[0].toLowerCase();
  const addrs = [...(t.to || []), ...(t.cc || [])].map((r) => String(r.email || "").toLowerCase()).filter(Boolean);
  const hits = addrs.map(companyOfAddress).filter(Boolean);
  if (!hits.length) return null;
  return hits.find((h) => local && h.address.split("@")[0].includes(local)) || hits[0];
}

// Follow-ups with customers. "Customer" = anyone outside the company:
// not on a login's email domain, the inboxes' domains, INTERNAL_DOMAINS, or
// a domain with soi / cas / redsun / nano in it; automated senders
// (no-reply, notifications, …) don't count. Per conversation, from Sent
// Items and the Inbox (last 14 days):
//  - Needs reply: the latest customer email is newer than anything sent
//    back (from that inbox, or for a shared inbox, from your own mailbox
//    too). Overdue after 24 hours.
//  - Waiting on them: you emailed a customer 2+ days ago and nothing came
//    back in that conversation since.
const AUTOMATED_RE = /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|alerts?|bounces?|automated|system|news(letter)?|marketing|info-?noreply)\b/i;
const WAIT_HOURS = 48, OVERDUE_HOURS = 24;
function internalDomainSet(users, mailboxes) {
  const set = new Set(String(process.env.INTERNAL_DOMAINS || "").toLowerCase().split(",").map((d) => d.trim()).filter(Boolean));
  for (const u of users) if (u.email && u.email.includes("@")) set.add(u.email.split("@")[1].toLowerCase());
  for (const m of mailboxes) if (m && m.includes("@")) set.add(m.split("@")[1].toLowerCase());
  return set;
}
function isCustomer(addr, internal) {
  const a = String(addr || "").toLowerCase();
  if (!a.includes("@")) return false;
  const [local, domain] = a.split("@");
  if (internal.has(domain) || companyOfAddress(domain)) return false;
  return !AUTOMATED_RE.test(local);
}
// Follow-ups for one inbox from its index (mail.js syncFollowIndex). A
// shared inbox also counts replies sent from your own mailbox (ownIdx).
function followUpsFor(box, idx, ownIdx, now) {
  const hours = (at) => Math.max(0, Math.round((now - Date.parse(at)) / 3600000));
  const out = [];
  for (const [conv, e] of Object.entries((idx && idx.convs) || {})) {
    const ownOut = ownIdx && ownIdx !== idx && ownIdx.convs && ownIdx.convs[conv] && ownIdx.convs[conv].out;
    const lastOut = [e.out && e.out.at, ownOut && ownOut.at].filter(Boolean).sort().pop() || "";
    if (e.in && e.in.direct && lastOut < e.in.at) {
      const h = hours(e.in.at), hit = companyOfAddress(e.in.to);
      out.push({ id: `${box}|f|${conv}`, conv, mailbox: box, subject: e.in.subject, from: e.in.from, to: [], cc: [], receivedAt: e.in.at, webLink: e.in.link,
        isRead: true, needsYou: true, preview: "", reason: "Customer email", sentTo: e.in.to, company: hit ? hit.co : undefined,
        followUp: { kind: "reply", since: e.in.at, hours: h, overdue: h >= OVERDUE_HOURS, who: e.in.from } });
    } else if (e.out && e.out.cust && (!e.in || e.in.at < e.out.at)) {
      const h = hours(e.out.at);
      if (h < WAIT_HOURS) continue;
      out.push({ id: `${box}|w|${conv}`, conv, mailbox: box, waiting: true, subject: e.out.subject, from: e.out.cust, to: [e.out.cust], cc: [], receivedAt: e.out.at, webLink: e.out.link,
        isRead: true, needsYou: false, preview: "", reason: "You emailed them",
        followUp: { kind: "waiting", since: e.out.at, hours: h, who: e.out.cust } });
    }
  }
  return out;
}

// Keeps the follow-up index fresh for inboxes someone has opened in the
// last two days, every few minutes, in the background.
const FOLLOW_EVERY_MS = 3 * 60 * 1000;
const followViewed = new Map(); // mailbox -> last time someone opened it
const followRunning = new Set();
async function syncFollowUps(boxes) {
  const todo = boxes.filter((b) => !followRunning.has(b));
  if (!todo.length) return;
  todo.forEach((b) => followRunning.add(b));
  try {
    const users = await getUsers();
    const internal = internalDomainSet(users, [...followViewed.keys()]);
    const isCust = (a) => isCustomer(a, internal);
    const doc = await getMailIndex();
    for (const box of todo) {
      const idx = doc[box] || {};
      try {
        await syncFollowIndex(box, idx, isCust);
        await withMailIndex((d) => { d[box] = idx; });
      } catch (err) {
        console.error(`Follow-up sync for ${box} failed (will retry):`, err.message);
      }
    }
  } finally {
    todo.forEach((b) => followRunning.delete(b));
  }
}
setInterval(() => {
  const cutoff = Date.now() - 2 * 24 * 3600 * 1000;
  const boxes = [...followViewed].filter(([, at]) => at > cutoff).map(([b]) => b);
  if (boxes.length) syncFollowUps(boxes).catch((err) => console.error("Follow-up sync:", err.message));
}, FOLLOW_EVERY_MS);

app.get(
  "/api/inbox",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 3, 1), 14);
    const u = (await getUsers()).map(normalizeUser).find((x) => sameUser(x.username, req.user.username));
    const own = u && u.email ? u.email.toLowerCase() : "";
    const ignoredMap = ((await getInboxIgnored()).users || {})[req.user.username.toLowerCase()] || {};
    if (STAGING) {
      if (!own) return res.status(409).json({ error: "Your login has no email address. Ask an admin to add it at /admin.html.", code: "no_email" });
      const sample = replies.sampleItem(own, (u.calendarNames || [])[0] || u.username);
      const items = [sample].filter((t) => !replies.isIgnored(ignoredMap, t));
      return res.json({ mailbox: own, mailboxes: [own], days, since: new Date(Date.now() - days * 864e5).toISOString(), items, errors: [], capped: [], followUps: [], followStatus: { syncing: [] }, colors: calColors(await getSettings()), staging: true, ignored: 1 - items.length });
    }
    try {
      const mine = await inboxThreads(own, days); // problems with your own mailbox stop here
      const items = mine.items.map((t) => Object.assign({}, t, { mailbox: own, conv: t.id }));
      const errors = [];
      const extras = (u.extraMailboxes || []).filter((m) => m.split("@")[1] === own.split("@")[1]);
      const results = await Promise.allSettled(extras.map((m) => inboxThreads(m, days)));
      results.forEach((r, i) => {
        const box = extras[i];
        if (r.status === "fulfilled") r.value.items.forEach((t) => {
          const hit = companyOfMessage(t, box);
          const extra = hit ? { company: hit.co, sentTo: hit.address } : {};
          // Sent straight to one of this inbox's company addresses (e.g.
          // supervisor@ at any of the four) counts as sent to the inbox.
          const local = box.split("@")[0].toLowerCase();
          if (hit && !t.needsYou && local && hit.address.split("@")[0] === local && (t.to || []).some((r) => String(r.email || "").toLowerCase() === hit.address)) {
            Object.assign(extra, { needsYou: true, reason: "Sent to " + hit.address });
          }
          items.push(Object.assign({}, t, { id: `${box}|${t.id}`, conv: t.id, mailbox: box }, extra));
        });
        else {
          const code = r.reason instanceof MailError ? r.reason.code : "";
          const why = code === "not_found" ? `There's no Microsoft 365 mailbox called ${box}.`
            : code === "no_permission" ? `The tracker isn't allowed to read ${box}. If Mail.Read is limited to certain mailboxes, add this one to that access policy.`
            : "Couldn't read this mailbox right now.";
          errors.push({ mailbox: box, error: why });
        }
      });
      // Customer follow-ups from the background index. The first time an
      // inbox is opened, its index is built in the background (a minute or
      // so for a busy inbox); the page says so meanwhile.
      const loaded = [own, ...extras.filter((m, i) => results[i].status === "fulfilled")];
      loaded.forEach((m) => followViewed.set(m, Date.now()));
      const doc = await getMailIndex();
      const fresh = loaded.filter((m) => !doc[m] || !doc[m].syncedAt);
      if (fresh.length) syncFollowUps(fresh).catch((err) => console.error("Follow-up sync:", err.message));
      const now = Date.now();
      const followUps = [];
      loaded.forEach((box) => { if (doc[box] && doc[box].syncedAt) followUps.push(...followUpsFor(box, doc[box], box === own ? null : doc[own], now)); });
      // Colour the rows in Unread / Read that have a follow-up.
      const fuByConv = new Map(followUps.map((f) => [f.mailbox + "|" + f.conv, f.followUp]));
      for (const t of items) { const f = fuByConv.get(t.mailbox + "|" + t.conv); if (f) t.followUp = f; }
      const followStatus = { syncing: loaded.filter((m) => !doc[m] || !doc[m].syncedAt || followRunning.has(m)) };
      const capped = [mine.capped ? own : null, ...extras.map((m, i) => results[i].status === "fulfilled" && results[i].value.capped ? m : null)].filter(Boolean);
      items.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
      // Ignored conversations stay hidden until a newer message arrives.
      const shown = items.filter((t) => !replies.isIgnored(ignoredMap, t));
      const shownFollow = followUps.filter((t) => !replies.isIgnored(ignoredMap, t));
      res.json({ mailbox: own, mailboxes: [own, ...extras], days, since: mine.since, items: shown, errors, capped, followUps: shownFollow, followStatus, colors: calColors(await getSettings()), ignored: items.length - shown.length });
    } catch (err) {
      if (err instanceof MailError) return res.status(409).json({ error: err.message, code: err.code });
      throw err;
    }
  })
);

// ---------- Email replies (Phase 8) ----------
// Open thread, Draft with AI, Send, Ignore — for the conversations on your
// own Emails page only: your login's mailbox or an extra inbox an admin gave
// you, never one the browser makes up. Draft with AI sends Claude on
// Bedrock (SOI's AWS account) just that conversation; nothing is sent until
// the person clicks Send, and Send refuses a reply that still has [[…]]
// placeholders. Replies go out as the signed-in person (Mail.Send): in the
// same Outlook thread for your own inbox; for a shared inbox, a new email
// from your own mailbox with the shared inbox copied. Staging never sends
// (dry run) and shows a practice email instead of real mail.
async function inboxAccess(req, mailbox) {
  const u = (await getUsers()).map(normalizeUser).find((x) => sameUser(x.username, req.user.username));
  const own = u && u.email ? u.email.toLowerCase() : "";
  if (!own) { const e = new Error("Your login has no email address. Ask an admin to add it at /admin.html."); e.status = 409; throw e; }
  const box = String(mailbox || own).toLowerCase();
  const extras = (u.extraMailboxes || []).map((m) => String(m).toLowerCase()).filter((m) => m.split("@")[1] === own.split("@")[1]);
  if (box !== own && !extras.includes(box)) { const e = new Error("That inbox isn't one of yours."); e.status = 403; throw e; }
  return { u, own, box, name: (u.calendarNames || [])[0] || u.username };
}
async function loadThread(a, conv) {
  if (!conv || typeof conv !== "string" || conv.length > 512) { const e = new Error("Which conversation?"); e.status = 400; throw e; }
  if (conv === replies.SAMPLE_CONV) {
    if (!STAGING) { const e = new Error("That practice email is only on staging."); e.status = 404; throw e; }
    return replies.sampleThread(a.own, a.name);
  }
  const msgs = await threadMessages(a.box, conv);
  if (!msgs.length) { const e = new Error("That conversation isn't in the mailbox any more."); e.status = 404; throw e; }
  return msgs;
}
function inboxRoute(fn) {
  return asyncHandler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof MailError || err instanceof AiError) return res.status(err instanceof AiError ? 502 : 409).json({ error: err.message, code: err.code || "ai" });
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  });
}

app.get(
  "/api/inbox/thread",
  authMiddleware,
  inboxRoute(async (req, res) => {
    const a = await inboxAccess(req, req.query.mailbox);
    const messages = await loadThread(a, String(req.query.conv || ""));
    const rec = replies.defaultRecipients(messages, a.own, a.box);
    const shared = a.box !== a.own;
    if (shared && !rec.cc.includes(a.box)) rec.cc.push(a.box);
    res.json({ mailbox: a.box, from: a.own, shared, staging: STAGING, messages, to: rec.to, cc: rec.cc, subject: replies.replySubject(messages[messages.length - 1].subject) });
  })
);

app.post(
  "/api/inbox/draft",
  authMiddleware,
  inboxRoute(async (req, res) => {
    const b = req.body || {};
    const a = await inboxAccess(req, b.mailbox);
    const messages = await loadThread(a, String(b.conv || ""));
    console.log(`Draft with AI: ${req.user.username}, ${messages.length} message(s) from ${a.box}`);
    const out = await askClaude({
      system: replies.SYSTEM_PROMPT,
      user: replies.draftPrompt({ sender: { name: a.name, email: a.own }, messages, notes: b.notes }),
    });
    res.json({ text: out.text, truncated: out.truncated, model: out.model, placeholders: (out.text.match(replies.PLACEHOLDER_RE) || []).length });
  })
);

app.post(
  "/api/inbox/reply",
  authMiddleware,
  inboxRoute(async (req, res) => {
    const b = req.body || {};
    const a = await inboxAccess(req, b.mailbox);
    const text = String(b.text || "").replace(/\r\n/g, "\n").trim();
    if (!text) return res.status(400).json({ error: "Write the reply first." });
    if (text.length > 50000) return res.status(400).json({ error: "That reply is too long." });
    const left = text.match(replies.PLACEHOLDER_RE);
    if (left) return res.status(400).json({ error: `Fill in or delete the placeholders first: ${[...new Set(left)].slice(0, 5).join(", ")}. Nothing was sent.` });
    const to = replies.parseAddresses(b.to), cc = replies.parseAddresses(b.cc);
    const bad = [...to.bad, ...cc.bad];
    if (bad.length) return res.status(400).json({ error: `Not an email address: ${bad.slice(0, 3).join(", ")}` });
    if (!to.list.length) return res.status(400).json({ error: "Add at least one address in To." });
    if (to.list.length + cc.list.length > 30) return res.status(400).json({ error: "That's more than 30 recipients." });
    const ccList = cc.list.filter((x) => !to.list.includes(x));
    const messages = await loadThread(a, String(b.conv || ""));
    const last = messages[messages.length - 1];
    const subject = replies.replySubject(last.subject);
    const html = replies.replyHtml(text, last);
    const shared = a.box !== a.own;
    if (STAGING) {
      console.log(`Reply (dry run, staging): ${req.user.username} to ${to.list.length + ccList.length} recipient(s)`);
      return res.json({ sent: false, dryRun: true, from: a.own, to: to.list, cc: ccList, subject, text, inThread: !shared, html });
    }
    if (shared) await sendAs(a.own, { to: to.list, cc: ccList, subject, html });
    else await replyToMessage(a.own, last.id, { to: to.list, cc: ccList, html });
    forgetInbox(a.own);
    if (shared) forgetInbox(a.box);
    console.log(`Reply sent: ${req.user.username} as ${a.own}${shared ? ` (for ${a.box})` : ""} to ${to.list.length + ccList.length} recipient(s)`);
    res.json({ sent: true, from: a.own, to: to.list, cc: ccList, subject, inThread: !shared });
  })
);

app.post(
  "/api/inbox/ignore",
  authMiddleware,
  inboxRoute(async (req, res) => {
    const b = req.body || {};
    const a = await inboxAccess(req, b.mailbox);
    const conv = String(b.conv || "");
    if (!conv || conv.length > 512) return res.status(400).json({ error: "Which conversation?" });
    const latest = String(b.latest || new Date().toISOString()).slice(0, 40);
    const me = req.user.username.toLowerCase();
    await withInboxIgnored((doc) => {
      doc.users = doc.users || {};
      const map = replies.pruneIgnored(doc.users[me] || {}, Date.now());
      if (b.undo) delete map[replies.ignoreKey(a.box, conv)];
      else map[replies.ignoreKey(a.box, conv)] = { at: Date.now(), latest };
      doc.users[me] = map;
    });
    res.json({ ok: true, ignored: !b.undo });
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
    sendViewOnly(res, meta, file);
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
  doc.requests = Array.isArray(doc.requests) ? doc.requests : [];
  return doc;
}
function sopDeptOk(dept) { return dept === SOP_ALL || DEPARTMENTS.includes(dept); }
// Leadership reads every SOP's PDFs too: they approve the change requests.
function canReadSops(user, dept) { return dept === SOP_ALL || inDepartment(user, dept) || !!user.leadership; }
// Changing or removing an SOP or a quick answer: a manager of its department.
function mayEditSops(user, dept) { return isManager(user) && (dept === SOP_ALL || inDepartment(user, dept)); }
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

// SOP PDFs are stored under readable names, one folder per department:
//   sop_files/<Department>/<Code Title>_v<N>.pdf
// N counts the SOP's versions (1 = the first upload). A new version gets
// the next N; changing the title, code or department renames every
// version's file to match. sop.key / version.key hold the names; SOPs from
// before this kept sop_files/<id> and sop_versions/<id>/<vid> until
// syncSopKeys moves them (it runs for every SOP once at startup).
const sopKeyOf = (x) => x.key || `sop_files/${x.id}`;
const sopVersionKeyOf = (x, v) => v.key || `sop_versions/${x.id}/${v.id}`;
function sopNames(doc, x) {
  const base = keyPart(`${x.code ? x.code + " " : ""}${x.title || ""}`, "SOP");
  const dept = keyPart(x.dept === SOP_ALL ? "All departments" : x.dept, "SOPs");
  // Two SOPs with the same code and title in one department get the id's end.
  const twin = sopShape(doc).sops.some((y) => y.id !== x.id && y.dept === x.dept && keyPart(`${y.code ? y.code + " " : ""}${y.title || ""}`, "SOP") === base);
  const stem = `sop_files/${dept}/${twin ? `${base} (${x.id.slice(-4)})` : base}`;
  const vs = Array.isArray(x.versions) ? x.versions : []; // newest first
  return { current: `${stem}_v${vs.length + 1}.pdf`, versions: vs.map((v, i) => [v, `${stem}_v${vs.length - i}.pdf`]) };
}
// Move an SOP's files to the names they should have, then save the names.
const sopSyncing = new Set();
async function syncSopKeys(sopId) {
  if (sopSyncing.has(sopId)) return;
  sopSyncing.add(sopId);
  try {
    const doc = sopShape(await getSops());
    const x = doc.sops.find((y) => y.id === sopId);
    if (!x) return;
    const want = sopNames(doc, x), moved = {};
    if (sopKeyOf(x) !== want.current && (await moveFile(sopKeyOf(x), want.current))) moved[""] = want.current;
    for (const [v, k] of want.versions) if (sopVersionKeyOf(x, v) !== k && (await moveFile(sopVersionKeyOf(x, v), k))) moved[v.id] = k;
    if (!Object.keys(moved).length) return;
    await withSops((d) => {
      const y = sopShape(d).sops.find((z) => z.id === sopId);
      if (!y) return;
      if (moved[""]) y.key = moved[""];
      for (const v of y.versions || []) if (moved[v.id]) v.key = moved[v.id];
    });
  } catch (err) {
    console.error(`Naming SOP ${sopId}'s files failed (kept the old names):`, err.message);
  } finally {
    sopSyncing.delete(sopId);
  }
}
setTimeout(async () => {
  try { for (const x of sopShape(await getSops()).sops) await syncSopKeys(x.id); } catch (err) { console.error("SOP file naming:", err.message); }
}, 15 * 1000);

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
    await syncSopKeys(id);
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
    if ("dept" in b && !mayEditSops(req.user, b.dept)) return res.status(400).json({ error: "Pick one of your departments" });
    const sop = await withSops((doc) => {
      const x = sopShape(doc).sops.find((y) => y.id === req.params.id);
      if (!x) return null;
      if (!mayEditSops(req.user, x.dept)) return { forbidden: true };
      if ("code" in b) x.code = sopText(b.code, 30);
      if ("title" in b) x.title = sopText(b.title, 160) || x.title;
      if ("version" in b) x.version = sopText(b.version, 30);
      if ("dept" in b) x.dept = b.dept;
      x.updatedAt = Date.now();
      return Object.assign({}, x);
    });
    if (!sop) return res.status(404).json({ error: "That SOP isn't here any more" });
    if (sop.forbidden) return res.status(403).json({ error: "Only that department's managers can change it" });
    // A new title, code or department renames the files in S3 to match.
    if ("code" in b || "title" in b || "dept" in b) await syncSopKeys(sop.id);
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
      if (!mayEditSops(req.user, list[i].dept)) return { forbidden: true };
      for (const q of doc.qa) if (q.sopId === req.params.id) q.sopId = "";
      return list.splice(i, 1)[0];
    });
    if (!gone) return res.status(404).json({ error: "That SOP isn't here any more" });
    if (gone.forbidden) return res.status(403).json({ error: "Only that department's managers can remove it" });
    await deleteFile(sopKeyOf(gone)).catch(() => {});
    for (const v of gone.versions || []) await deleteFile(sopVersionKeyOf(gone, v)).catch(() => {});
    res.status(204).end();
  })
);

app.get(
  "/api/sops/:id/file",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const sop = sopShape(await getSops()).sops.find((y) => y.id === req.params.id);
    if (!sop || !canReadSops(req.user, sop.dept)) return res.status(404).json({ error: "That SOP isn't here" });
    const file = await getFile(sopKeyOf(sop));
    if (!file) return res.status(404).json({ error: "The PDF is missing" });
    sendViewOnly(res, { name: sop.fileName || `${sop.code || "SOP"} ${sop.title}.pdf`, type: "application/pdf" }, file);
  })
);

// An older version of an SOP, kept when a new one replaced it.
app.get(
  "/api/sops/:id/versions/:vid/file",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const sop = sopShape(await getSops()).sops.find((y) => y.id === req.params.id);
    const v = sop && (sop.versions || []).find((x) => x.id === req.params.vid);
    if (!v || !canReadSops(req.user, sop.dept)) return res.status(404).json({ error: "That version isn't here" });
    const file = await getFile(sopVersionKeyOf(sop, v));
    if (!file) return res.status(404).json({ error: "The PDF is missing" });
    sendViewOnly(res, { name: v.fileName || `${sop.code || "SOP"} ${sop.title} ${v.version || ""}.pdf`, type: "application/pdf" }, file);
  })
);

// A new version of an SOP: the current PDF stays where it is (now an older
// version, still viewable from the SOP's row) and the new one is saved as
// the next _v<N>. Used by a department manager's "New version" and by an
// approved change request that came with a PDF.
async function sopNewVersion(sopId, body, meta, by) {
  await syncSopKeys(sopId); // older SOPs: give the current files their names first
  const doc = sopShape(await getSops());
  const cur = doc.sops.find((y) => y.id === sopId);
  if (!cur) return null;
  const vid = newId();
  const had = !!(await getFile(sopKeyOf(cur)));
  const next = sopNames(doc, Object.assign({}, cur, { versions: had ? [{ id: vid }].concat(cur.versions || []) : cur.versions || [] })).current;
  await putFile(next, body, "application/pdf");
  return withSops((d) => {
    const x = sopShape(d).sops.find((y) => y.id === sopId);
    if (!x) return null;
    x.versions = Array.isArray(x.versions) ? x.versions : [];
    if (had) x.versions.unshift({ id: vid, key: sopKeyOf(x), fileName: x.fileName, size: x.size, version: x.version, at: x.uploadedAt, by: x.uploadedBy });
    Object.assign(x, { key: next, fileName: sopText(meta.fileName, 200) || x.fileName, size: body.length, version: sopText(meta.version, 30), uploadedAt: Date.now(), uploadedBy: by, updatedAt: Date.now() });
    if (meta.request) x.request = meta.request;
    return Object.assign({}, x);
  });
}
const isPdf = (b) => Buffer.isBuffer(b) && b.slice(0, 5).toString() === "%PDF-";
app.post(
  "/api/sops/:id/version",
  authMiddleware,
  express.raw({ type: () => true, limit: "20mb" }),
  asyncHandler(async (req, res) => {
    const sop = sopShape(await getSops()).sops.find((y) => y.id === req.params.id);
    if (!sop) return res.status(404).json({ error: "That SOP isn't here any more" });
    if (!isManager(req.user) || !(sop.dept === SOP_ALL || inDepartment(req.user, sop.dept))) return res.status(403).json({ error: "Only the department's managers add a new version" });
    if (!isPdf(req.body)) return res.status(400).json({ error: "SOPs need to be PDF files" });
    res.json(await sopNewVersion(sop.id, req.body, { fileName: req.query.fileName, version: req.query.version }, req.user.username));
  })
);

// ---------- SOP change requests ----------
// Anyone proposes a change to an SOP they can read (or a new SOP for one of
// their departments): what, why, and optionally the new PDF. Leadership
// approves or declines — never their own. An approved change with a PDF
// becomes the SOP's new version (a new SOP for "new"); without one it's
// recorded and a department manager adds the PDF with "New version".
function sopRequestView(r, user, doc) {
  const sop = r.sopId && doc.sops.find((y) => y.id === r.sopId);
  return Object.assign({}, r, {
    sopLabel: sop ? [sop.code, sop.title].filter(Boolean).join(" · ") : r.sopLabel || "",
    mine: sameUser(r.by, user.username),
    canDecide: r.status === "pending" && !!user.leadership && !sameUser(r.by, user.username),
  });
}
const sopRequestSeen = (r, user) => sameUser(r.by, user.username) || !!user.leadership;

app.get(
  "/api/sop-requests",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const doc = sopShape(await getSops());
    res.json({
      leadership: !!req.user.leadership,
      requests: doc.requests.filter((r) => sopRequestSeen(r, req.user)).map((r) => sopRequestView(r, req.user, doc)).sort((a, b) => b.at - a.at),
    });
  })
);
app.post(
  "/api/sop-requests",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const kind = b.kind === "new" ? "new" : "change";
    const what = String(b.what == null ? "" : b.what).trim().slice(0, 5000);
    const why = String(b.why == null ? "" : b.why).trim().slice(0, 3000);
    if (!what) return res.status(400).json({ error: "Say what should change" });
    const doc = sopShape(await getSops());
    const r = { id: newId(), kind, what, why, status: "pending", by: req.user.username, at: Date.now() };
    if (kind === "change") {
      const sop = doc.sops.find((y) => y.id === b.sopId);
      if (!sop || !(sop.dept === SOP_ALL || inDepartment(req.user, sop.dept))) return res.status(400).json({ error: "Pick one of your departments' SOPs" });
      Object.assign(r, { sopId: sop.id, dept: sop.dept, sopLabel: [sop.code, sop.title].filter(Boolean).join(" · ") });
    } else {
      const dept = String(b.dept || "");
      if (!DEPARTMENTS.includes(dept) || !inDepartment(req.user, dept)) return res.status(400).json({ error: "Pick one of your departments" });
      const title = sopText(b.title, 160);
      if (!title) return res.status(400).json({ error: "Give the new SOP a title" });
      Object.assign(r, { dept, title, code: sopText(b.code, 30), sopLabel: [sopText(b.code, 30), title].filter(Boolean).join(" · ") });
    }
    await withSops((d) => { sopShape(d).requests.push(r); });
    res.status(201).json(sopRequestView(r, req.user, doc));
  })
);
// The proposed PDF: the person who asked, while it's still pending.
app.post(
  "/api/sop-requests/:id/file",
  authMiddleware,
  express.raw({ type: () => true, limit: "20mb" }),
  asyncHandler(async (req, res) => {
    if (!isPdf(req.body)) return res.status(400).json({ error: "Attach the new SOP as a PDF" });
    const r0 = sopShape(await getSops()).requests.find((y) => y.id === req.params.id);
    if (!r0 || !sameUser(r0.by, req.user.username)) return res.status(404).json({ error: "That request isn't yours" });
    if (r0.status !== "pending") return res.status(400).json({ error: "That request has already been decided" });
    await putFile(`sop_request_files/${r0.id}`, req.body, "application/pdf");
    const r = await withSops((d) => {
      const x = sopShape(d).requests.find((y) => y.id === r0.id);
      if (!x || x.status !== "pending") return null;
      x.file = { name: sopText(req.query.fileName, 200) || "Proposed SOP.pdf", size: req.body.length, at: Date.now() };
      return Object.assign({}, x);
    });
    if (!r) return res.status(400).json({ error: "That request has already been decided" });
    res.json(r);
  })
);
app.get(
  "/api/sop-requests/:id/file",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const r = sopShape(await getSops()).requests.find((y) => y.id === req.params.id);
    if (!r || !r.file || !sopRequestSeen(r, req.user)) return res.status(404).json({ error: "That PDF isn't here" });
    const file = await getFile(`sop_request_files/${r.id}`);
    if (!file) return res.status(404).json({ error: "The PDF is missing" });
    sendViewOnly(res, { name: r.file.name, type: "application/pdf" }, file);
  })
);
app.post(
  "/api/sop-requests/:id/withdraw",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const out = await withSops((d) => {
      const x = sopShape(d).requests.find((y) => y.id === req.params.id);
      if (!x || !sameUser(x.by, req.user.username)) return { status: 404, error: "That request isn't yours" };
      if (x.status !== "pending") return { status: 400, error: "That request has already been decided" };
      Object.assign(x, { status: "withdrawn", decidedAt: Date.now(), decidedBy: req.user.username });
      return { r: Object.assign({}, x) };
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json(out.r);
  })
);
// Leadership approves or declines (a note is needed to decline).
app.post(
  "/api/sop-requests/:id/decide",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!req.user.leadership) return res.status(403).json({ error: "Only Leadership approves SOP changes" });
    const b = req.body || {};
    const approve = b.approve === true;
    const note = String(b.note == null ? "" : b.note).trim().slice(0, 2000);
    if (!approve && !note) return res.status(400).json({ error: "Say why it's declined" });
    // Claim the request first, so two approvals at once can't apply it twice.
    const claim = await withSops((d) => {
      const x = sopShape(d).requests.find((y) => y.id === req.params.id);
      if (!x) return { status: 404, error: "That request isn't here any more" };
      if (sameUser(x.by, req.user.username)) return { status: 403, error: "Someone else in Leadership has to decide your own request" };
      if (x.status !== "pending") return { status: 400, error: "That request has already been decided" };
      if (!approve) return { r0: Object.assign({}, x) };
      if (x.kind === "change" && x.file && !d.sops.some((y) => y.id === x.sopId)) return { status: 400, error: "That SOP has been removed since — decline the request" };
      x.status = "approving";
      return { r0: Object.assign({}, x) };
    });
    if (claim.error) return res.status(claim.status).json({ error: claim.error });
    const r0 = claim.r0;
    const unclaim = () => withSops((d) => { const x = sopShape(d).requests.find((y) => y.id === r0.id); if (x && x.status === "approving") x.status = "pending"; });
    // Approved with a PDF: it becomes the SOP's new version, or a new SOP.
    let sopId = r0.sopId || "";
    if (approve && r0.file) {
      try {
        const file = await getFile(`sop_request_files/${r0.id}`);
        if (!file) { await unclaim(); return res.status(400).json({ error: "The proposed PDF is missing — ask for it again" }); }
        const version = sopText(b.version, 30);
        if (r0.kind === "change") {
          await sopNewVersion(r0.sopId, file.body, { fileName: r0.file.name, version, request: r0.id }, r0.by);
        } else {
          sopId = newId();
          await putFile(`sop_files/${sopId}`, file.body, "application/pdf");
          const sop = { id: sopId, dept: r0.dept, code: r0.code || "", title: r0.title, version, fileName: r0.file.name, size: file.body.length, uploadedAt: Date.now(), uploadedBy: r0.by, request: r0.id };
          await withSops((d) => { sopShape(d).sops.push(sop); });
          await syncSopKeys(sopId);
        }
      } catch (err) { await unclaim(); throw err; }
    }
    const out = await withSops((d) => {
      const x = sopShape(d).requests.find((y) => y.id === r0.id);
      if (!x || x.status !== (approve ? "approving" : "pending")) return null;
      Object.assign(x, { status: approve ? "approved" : "declined", decidedBy: req.user.username, decidedAt: Date.now(), note, applied: !!(approve && x.file) });
      if (sopId) x.sopId = sopId;
      return sopRequestView(x, req.user, d);
    });
    if (!out) return res.status(400).json({ error: "That request has already been decided" });
    res.json(out);
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
      if (!mayEditSops(req.user, x.dept)) return { forbidden: true };
      const c = cleanQa(Object.assign({}, x, b));
      if (!c.q) return { error: "A question can't be empty" };
      Object.assign(x, c, { updatedAt: Date.now(), by: req.user.username });
      return Object.assign({}, x);
    });
    if (!item) return res.status(404).json({ error: "That answer isn't here any more" });
    if (item.forbidden) return res.status(403).json({ error: "Only that department's managers can change it" });
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
      if (!mayEditSops(req.user, list[i].dept)) return "forbidden";
      list.splice(i, 1);
      return true;
    });
    if (!ok) return res.status(404).json({ error: "That answer isn't here any more" });
    if (ok === "forbidden") return res.status(403).json({ error: "Only that department's managers can remove it" });
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
    users.forEach((u) => { if (u.pentagonCode) codeToUser.set(u.pentagonCode.trim().toLowerCase(), u); });
    // By person only counts people in the department that owns each list
    // (RFQs / quotes → Procurement, SOs / POs → Purchasing).
    const viewDept = {};
    for (const [dept, list] of Object.entries(PENTAGON_VIEWS)) for (const v of list) viewDept[v.id] = dept;
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
        const u = code ? codeToUser.get(code.toLowerCase()) : null;
        if (u && (!viewDept[view.id] || (u.departments || []).includes(viewDept[view.id]))) {
          const who = u.username;
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

// Email check for /admin.html: is sending set up, and does a test email go
// through? Says exactly what Microsoft objected to when it doesn't.
app.get("/api/admin/email", adminMiddleware, (req, res) => {
  res.json({ configured: mailConfigured, from: MAIL_FROM, itMailbox: IT_REQUESTS_MAILBOX || "" });
});
app.post(
  "/api/admin/email/test",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const to = String((req.body || {}).to || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "Enter an email address to send the test to" });
    if (!mailConfigured) return res.status(400).json({ error: "Email isn't set up: set MS_FROM_EMAIL (plus MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET) on the stack in Portainer and redeploy." });
    try {
      await sendMail({ to, subject: "AOG Tracker — test email", html: `<p>This is a test from the AOG Tracker admin page. If you're reading it, the tracker can send email as <b>${escapeHtml(MAIL_FROM)}</b>.</p>`, saveCopy: true });
      res.json({ ok: true, from: MAIL_FROM });
    } catch (err) {
      console.error("Test email failed:", err.message);
      res.status(502).json({ error: err.reason || err.message.slice(0, 300) });
    }
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

// The dashboard's stylesheet and scripts (index.html lists them in load order).
app.use("/public", express.static(path.join(__dirname, "public"), { index: false }));

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
    const settings = await getSettings();
    res.json({ requests, canRate: isManager(req.user), mailboxConnected: itRequestsConfigured, sync: itSyncStatus(), sla: itSla(settings), notebook: await hasItNotebook(req.user), mailOn: mailConfigured });
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
// The issue as it appears in the "Resolved: your IT request — …" subject.
// Raise RESOLVED_SUBJECT_MAX for longer subjects (most inboxes show about
// 80–100 characters before cutting it off themselves). Uses the first
// sentence when that's long enough, and never cuts a word in half.
const RESOLVED_SUBJECT_MAX = 100;
function subjectIssue(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const first = (t.match(/^.*?[.!?](?=\s|$)/) || [t])[0];
  const pick = first.length >= 20 ? first : t;
  if (pick.length <= RESOLVED_SUBJECT_MAX) return pick.replace(/[.!?]+$/, "");
  return pick.slice(0, RESOLVED_SUBJECT_MAX).replace(/\s+\S*$/, "") + "…";
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
  // Fix the requester's email (one ticket at a time), e.g. a typo on the form.
  if ("email" in body) {
    if (ids.length !== 1) return res.status(400).json({ error: "Change one ticket's email at a time" });
    const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "That email address doesn't look right" });
    Object.assign(change, { email, emailEditedBy: req.user.username, emailEditedAt: Date.now() });
  }
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
  // Archive: out of every tab, the numbers and the charts, onto Archived.
  // Nothing else changes, so Restore puts it back as it was.
  if ("archived" in body) {
    change.archived = !!body.archived;
    change.archivedAt = change.archived ? Date.now() : null;
    change.archivedBy = change.archived ? req.user.username : "";
  }
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
      const prevStatus = r.status, prevEmail = r.email;
      Object.assign(r, change, now);
      if (r.status !== prevStatus) {
        pushActivity(r, { type: "status", text: { new: "New", progress: "In progress", done: "Resolved" }[r.status] || r.status, by: req.user.username });
        // Any move by a person off New counts as the first response.
        if (prevStatus === "new" && !r.firstResponseAt) r.firstResponseAt = Date.now();
      }
      if ("email" in change && prevEmail !== r.email) pushActivity(r, { type: "note", text: `Requester email changed from ${prevEmail || "none"} to ${r.email || "none"}`, by: req.user.username });
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
          subject: `Resolved: your IT request${rec.issue ? " — " + subjectIssue(rec.issue) : ""} [Ticket ${ref}]`,
          html: resolvedEmailHtml(rec, me),
        });
        if (!ok) { emailProblems.push("Email isn't set up on the server: MS_FROM_EMAIL (and MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET) must be set on the stack"); break; }
        emailed++;
        sentIds.set(rec.id, rec.ref);
      } catch (err) {
        console.error("Resolution email failed:", err.message);
        emailProblems.push(`${rec.email}: ${err.reason || "couldn't send (" + err.message.slice(0, 120) + ")"}`);
        // The same setup problem would stop every other one too.
        if (err.reason && !/didn't accept the address/.test(err.reason)) break;
      }
    }
    if (emailed) await withItRequests((list) => {
      for (const r of list) if (sentIds.has(r.id)) {
        r.notifiedAt = Date.now(); r.notifiedBy = req.user.username; r.ref = sentIds.get(r.id);
        pushActivity(r, { type: "resolved", text: r.resolution || "", by: req.user.username, emailedTo: r.email });
        if (!r.firstResponseAt) r.firstResponseAt = Date.now();
      }
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

// Delete forever: archived requests only. Also removes the linked IT task
// and the private notebook write-up, and remembers the ids so the form
// email or an Excel re-import can't bring them back.
app.post(
  "/api/it-requests/delete",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!canSeeItRequests(req.user) || !isManager(req.user)) return res.status(403).json({ error: "Only managers can delete requests" });
    const wanted = new Set((Array.isArray((req.body || {}).ids) ? req.body.ids : []).map(String).slice(0, 1000));
    if (!wanted.size) return res.status(400).json({ error: "Pick the requests to delete" });
    const gone = await withItRequests((list) => {
      const out = list.filter((r) => wanted.has(r.id) && r.archived);
      if (!out.length) return out;
      const ids = new Set(out.map((r) => r.id));
      const keep = list.filter((r) => !ids.has(r.id));
      // Anything that pointed at a deleted request as its original stands alone.
      for (const r of keep) if (ids.has(r.duplicateOf)) { r.duplicateOf = ""; r.notDuplicate = true; }
      list.splice(0, list.length, ...keep);
      return out.map((r) => ({ id: r.id, taskId: r.taskId || "", formId: r.formId }));
    });
    if (!gone.length) return res.status(400).json({ error: "Only archived requests can be deleted — archive them first" });
    const taskIds = new Set(gone.map((r) => r.taskId).filter(Boolean));
    if (taskIds.size) await withTasks((tasks) => { const k = tasks.filter((t) => !taskIds.has(t.id) && !taskIds.has(t.parentId)); tasks.splice(0, tasks.length, ...k); });
    await withItNotebook((nb) => { if (nb.tickets) for (const r of gone) delete nb.tickets[r.id]; });
    await withSettings((st) => { st.itRequestsDeleted = [...gone.map((r) => r.id), ...(st.itRequestsDeleted || [])].slice(0, 5000); });
    console.log(`IT requests: ${req.user.username} deleted ${gone.length} archived request(s).`);
    res.json({ deleted: gone.length });
  })
);

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

// ---------- IT ticket card: activity, files, acknowledgement, SLAs ----------
// Each request keeps an activity list: emailed replies to the requester,
// internal work notes (never emailed), status changes, the automatic
// acknowledgement and the resolved email. Replies go out with the ticket
// number in the subject, so the requester's answers come back onto the
// ticket. Files are kept in S3 under it_request_files/<request>/.
const IT_SLA_DEFAULTS = { ackOn: true, ackMinutes: 30, respondMinutes: 30, resolveHours: { P1: 4, P2: 8, P3: 72, P4: 120 } };
function itSla(settings) {
  const s = settings.itSla || {};
  const h = Object.assign({}, IT_SLA_DEFAULTS.resolveHours, s.resolveHours || {});
  const n = (v, d, max) => (Number(v) > 0 && Number(v) <= max ? Number(v) : d);
  return {
    ackOn: s.ackOn !== false,
    ackMinutes: n(s.ackMinutes, IT_SLA_DEFAULTS.ackMinutes, 1440),
    respondMinutes: n(s.respondMinutes, IT_SLA_DEFAULTS.respondMinutes, 1440),
    resolveHours: { P1: n(h.P1, 4, 2000), P2: n(h.P2, 8, 2000), P3: n(h.P3, 72, 2000), P4: n(h.P4, 120, 2000) },
    since: Number(settings.itSlaSince) || 0,
  };
}
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_ATTACH = 3 * 1024 * 1024;
function pushActivity(r, entry) {
  r.activity = Array.isArray(r.activity) ? r.activity : [];
  r.activity.push(Object.assign({ id: newId(), at: Date.now() }, entry));
  if (r.activity.length > 300) r.activity = r.activity.slice(-300);
}
// A plain-HTML version of a KB article body (headings, bullets, paragraphs;
// pictures are attached instead).
function kbToHtml(body) {
  return String(body || "").replace(/!\[[^\]]*\]\(kb-img:[a-z0-9]+\)/g, "").split(/\n{2,}/).map((block) => {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) return "";
    if (/^#{1,3}\s/.test(lines[0]) && lines.length === 1) return `<p style="margin:10px 0 4px;"><b>${escapeHtml(lines[0].replace(/^#+\s*/, ""))}</b></p>`;
    if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) return "<ul style=\"margin:4px 0 8px;\">" + lines.map((l) => `<li>${escapeHtml(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""))}</li>`).join("") + "</ul>";
    return lines.map((l) => /^#{1,3}\s/.test(l) ? `<p style="margin:10px 0 4px;"><b>${escapeHtml(l.replace(/^#+\s*/, ""))}</b></p>` : `<p style="margin:0 0 8px;">${escapeHtml(l)}</p>`).join("");
  }).join("");
}
function ticketEmailHtml(rec, me, inner) {
  const who = (me && (me.name || me.username)) || "IT";
  const whoName = who.charAt(0).toUpperCase() + who.slice(1);
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:600px;">` +
    `<p>Hi ${escapeHtml((rec.name || "").split(" ")[0] || "there")},</p>` + inner +
    `<p>Just reply to this email to add anything — it'll come straight to ${escapeHtml(whoName)}.</p>` +
    `<p>Thanks,<br>${escapeHtml(whoName)}<br>SOI Aviation IT</p>` +
    `<p style="color:#888;font-size:12px;">Ticket ${escapeHtml(rec.ref || ticketRef(rec.id))}${rec.issue ? " · " + escapeHtml(subjectIssue(rec.issue)) : ""}</p></div>`;
}
async function findRequest(id) {
  return (await getItRequests()).find((x) => x.id === id) || null;
}
const itManagerOnly = (req, res, next) => (canSeeItRequests(req.user) && isManager(req.user) ? next() : res.status(403).json({ error: "Only IT managers can do this" }));

app.post(
  "/api/it-requests/:id/files",
  authMiddleware,
  itManagerOnly,
  express.raw({ type: () => true, limit: "10mb" }),
  asyncHandler(async (req, res) => {
    const name = String(req.query.name || "file").replace(/[\\/\r\n"]+/g, "_").slice(0, 160);
    const ext = (name.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    const type = ext && PERF_FILE_TYPES[ext.toLowerCase()];
    if (!type) return res.status(400).json({ error: "Attach a PDF, image, Word, Excel, PowerPoint, text or email file" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file came through" });
    if (!(await findRequest(req.params.id))) return res.status(404).json({ error: "That ticket isn't here" });
    const file = { id: newId(), name, type, size: req.body.length, at: Date.now(), by: req.user.username };
    await putFile(`it_request_files/${req.params.id}/${file.id}`, req.body, type);
    await withItRequests((list) => { const r = list.find((x) => x.id === req.params.id); if (r) { r.files = r.files || []; r.files.push(file); } });
    res.status(201).json(file);
  })
);
app.get(
  "/api/it-requests/:id/files/:fid",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!canSeeItRequests(req.user)) return res.status(403).json({ error: "Only IT can see this" });
    const r = await findRequest(req.params.id);
    const meta = r && (r.files || []).find((f) => f.id === req.params.fid);
    const file = meta && (await getFile(`it_request_files/${r.id}/${meta.id}`));
    if (!file) return res.status(404).json({ error: "That file isn't here" });
    sendViewOnly(res, meta, file);
  })
);

// A reply to the requester (emailed, with any attachments and a KB article)
// or an internal work note (never emailed).
app.post(
  "/api/it-requests/:id/activity",
  authMiddleware,
  itManagerOnly,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const kind = b.kind === "reply" ? "reply" : "note";
    const text = String(b.text || "").trim().slice(0, 8000);
    const rec = await findRequest(req.params.id);
    if (!rec) return res.status(404).json({ error: "That ticket isn't here" });
    const files = (Array.isArray(b.fileIds) ? b.fileIds : []).map((fid) => (rec.files || []).find((f) => f.id === fid)).filter(Boolean);
    let kb = null;
    if (b.kbId) {
      if (!(await hasItNotebook(req.user))) return res.status(403).json({ error: "KB articles are in the private IT notebook" });
      const a = nbShape(await getItNotebook()).articles.find((x) => x.id === b.kbId);
      if (!a) return res.status(400).json({ error: "That KB article isn't there any more" });
      kb = a;
    }
    if (!text && !files.length && !kb) return res.status(400).json({ error: "Write something first" });
    const entry = { type: kind, text, by: req.user.username, files: files.map((f) => f.id), kb: kb ? { id: kb.id, kb: kb.kb, title: kb.title } : null };
    if (kind === "reply") {
      if (!rec.email || !EMAIL_OK.test(rec.email)) return res.status(400).json({ error: "This ticket has no valid email — fix it with ✎ first, or add an internal note" });
      if (!mailConfigured) return res.status(400).json({ error: "Email isn't set up on the server (see Admin → Email)" });
      const attachments = [];
      for (const f of files) { const x = await getFile(`it_request_files/${rec.id}/${f.id}`); if (x) attachments.push({ name: f.name, contentType: f.type, content: x.body }); }
      if (kb) for (const m of String(kb.body || "").matchAll(KB_IMG_RE)) {
        const x = await getFile(`it_notebook_images/${m[1]}`);
        if (x) attachments.push({ name: `KB-${String(kb.kb).padStart(4, "0")}-${m[1].slice(0, 6)}.${(x.contentType || "image/png").split("/")[1]}`, contentType: x.contentType, content: x.body });
      }
      const total = attachments.reduce((s, a) => s + a.content.length, 0);
      if (total > MAX_EMAIL_ATTACH) return res.status(400).json({ error: `Attachments add up to ${(total / 1048576).toFixed(1)} MB — email can carry about 3 MB. Remove some, or keep them as an internal note.` });
      const users = await getUsers();
      const me = users.find((u) => sameUser(u.username, req.user.username));
      const ref = rec.ref || ticketRef(rec.id);
      rec.ref = ref;
      const inner = (text ? `<div style="margin:0 0 14px;">${escapeHtml(text).replace(/\n/g, "<br>")}</div>` : "") +
        (kb ? `<div style="border-left:3px solid #3d7fd1;padding:4px 0 2px 14px;margin:16px 0;"><p style="margin:0 0 6px;color:#555;font-size:12px;">From our knowledge base · KB-${String(kb.kb).padStart(4, "0")}</p><p style="margin:0 0 8px;"><b>${escapeHtml(kb.title)}</b></p>${kbToHtml(kb.body)}</div>` : "") +
        (attachments.length ? `<p style="color:#555;font-size:12px;">Attached: ${attachments.map((a) => escapeHtml(a.name)).join(", ")}</p>` : "");
      try {
        await sendMail({
          to: rec.email, replyTo: [me && me.email, IT_REQUESTS_MAILBOX], saveCopy: true, attachments,
          subject: `Update on your IT request — ${subjectIssue(rec.issue || "IT request")} [Ticket ${ref}]`,
          html: ticketEmailHtml(rec, me, inner),
        });
      } catch (err) {
        console.error("Ticket reply email failed:", err.message);
        return res.status(502).json({ error: err.reason || "Couldn't send the email" });
      }
      entry.emailedTo = rec.email;
    }
    const saved = await withItRequests((list) => {
      const r = list.find((x) => x.id === rec.id);
      if (!r) return null;
      pushActivity(r, entry);
      if (kind === "reply") {
        r.ref = rec.ref;
        if (!r.firstResponseAt) r.firstResponseAt = Date.now();
        r.replyPending = false;
        // Answering a new ticket starts work on it.
        if (r.status === "new") { r.status = "progress"; pushActivity(r, { type: "status", text: "In progress", by: req.user.username }); }
      }
      r.updatedAt = Date.now(); r.updatedBy = req.user.username;
      return JSON.parse(JSON.stringify(r));
    });
    if (!saved) return res.status(404).json({ error: "That ticket isn't here any more" });
    res.status(201).json(saved);
  })
);

// "We got your ticket" — sent once to a new ticket nobody has answered
// within the set time (Admin → IT ticket SLAs). Only tickets that came in
// after this was switched on; never Excel imports.
let ackRunning = false;
async function sendAcknowledgements() {
  if (ackRunning || !mailConfigured) return;
  ackRunning = true;
  try {
    let settings = await getSettings();
    if (!settings.itSlaSince) { await withSettings((s) => { if (!s.itSlaSince) s.itSlaSince = Date.now(); }); settings = await getSettings(); }
    const sla = itSla(settings);
    if (!sla.ackOn) return;
    const due = (await getItRequests()).filter((r) => r.status === "new" && !r.ackAt && !r.firstResponseAt && !r.archived && !r.duplicateOf &&
      r.source !== "import" && (r.addedAt || 0) >= sla.since && Date.now() - (r.addedAt || 0) >= sla.ackMinutes * 60000 && r.email && EMAIL_OK.test(r.email)).slice(0, 10);
    for (const rec of due) {
      const ref = rec.ref || ticketRef(rec.id);
      rec.ref = ref;
      try {
        await sendMail({
          to: rec.email, replyTo: [IT_REQUESTS_MAILBOX], saveCopy: true,
          subject: `We got your IT request — ${subjectIssue(rec.issue || "IT request")} [Ticket ${ref}]`,
          html: ticketEmailHtml(rec, null, `<p>Thanks for letting us know. We've got your IT request${rec.submittedAt ? " from " + escapeHtml(String(rec.submittedAt).slice(0, 16)) : ""} and we're working on it. We'll email you as soon as there's an update.</p>`),
        });
        await withItRequests((list) => { const r = list.find((x) => x.id === rec.id); if (r && !r.ackAt) { r.ackAt = Date.now(); r.ref = ref; pushActivity(r, { type: "ack", text: "Automatic “we got your ticket” email", by: "tracker", emailedTo: rec.email }); } });
      } catch (err) {
        console.error(`Acknowledgement for ${rec.id} failed (will retry):`, err.message);
        break;
      }
    }
  } catch (err) {
    console.error("Acknowledgement check failed:", err.message);
  } finally {
    ackRunning = false;
  }
}
setInterval(sendAcknowledgements, 60 * 1000);
setTimeout(sendAcknowledgements, 20 * 1000);

// SLA settings (admin page).
app.get("/api/admin/it-sla", adminMiddleware, asyncHandler(async (req, res) => res.json(itSla(await getSettings()))));
app.put(
  "/api/admin/it-sla",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const next = await withSettings((s) => {
      s.itSla = { ackOn: b.ackOn !== false, ackMinutes: Number(b.ackMinutes), respondMinutes: Number(b.respondMinutes), resolveHours: b.resolveHours || {} };
      if (!s.itSlaSince) s.itSlaSince = Date.now();
      return itSla(s);
    });
    res.json(next);
  })
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
    const [tasks, settings] = await Promise.all([getTasks(), getSettings()]);
    const taskByForm = new Map(tasks.filter((t) => t.formResponseId).map((t) => [`form-${t.formResponseId}`, t]));
    const deleted = new Set(settings.itRequestsDeleted || []);
    const counts = await withItRequests((list) => {
      let added = 0, updated = 0;
      for (const rec of records) {
        if (deleted.has(rec.id)) continue; // deleted forever
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
// minutes, each new "[IT Request]" email becomes a request on IT → Requests.
// Handled ones are remembered in settings, so one that's deleted later
// doesn't come back.
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
      added = fresh;
      // Requests live on IT → Requests only, not as IT tasks.
      // Also into the Requests history.
      await withItRequests((list) => {
        fresh.forEach((r) => {
          const rec = recordFromEmail(r);
          if ((settings.itRequestsDeleted || []).includes(rec.id)) return;
          const have = list.find((x) => x.id === rec.id);
          if (have) return;
          list.push(Object.assign(rec, { priority: "", status: "new", taskId: "", addedAt: Date.now() }));
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
// message): a request record like a form one. Anyone who can see Requests
// can add one.
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
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const rec = {
      id: "manual-" + id, formId: null, source: "manual",
      submittedAt: officeStamp(new Date().toISOString()),
      name, email, phone: text(b.phone, 40), company: text(b.company, 40), remote: "", issue, startedOn: "",
      urgency: "", contact: text(b.contact, 60), notes: "",
      priority, status: "new", taskId: "", addedAt: Date.now(), addedBy: req.user.username,
    };
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

// ---------- Administration: staff forms (ROADMAP.md Phase 4) ----------
// Each Administration department's Staff-Facing tab has forms for everyone:
// IT ticket, admin request, HR issue / leave request / performance comment,
// reimbursement. The rules are in staffforms.js. Staff see only their own;
// the department sees its own kinds; HR's kinds are HR, Leadership and full
// access only. IT tickets become IT requests (IT → Requests), as before.
function loginsByName(users) {
  return new Map(users.map((u) => [String(u.username).toLowerCase(), normalizeUser(u)]));
}
const formLog = (item, by, what, pub) => { (item.history = item.history || []).push({ at: Date.now(), by, what, public: !!pub }); };

// Your own forms (every department), your own IT tickets, and leave waiting
// for your approval.
app.get(
  "/api/staff-forms/mine",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const [doc, itList, tasks, users] = await Promise.all([getStaffForms(), getItRequests(), getTasks(), getUsers()]);
    const items = doc.items || [];
    const logins = loginsByName(users);
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const approvals = [];
    for (const i of items) {
      if (i.kind !== "leave") continue;
      const step = forms.leaveStep(req.user, i, logins.get(String(i.by).toLowerCase()));
      if (step) approvals.push(Object.assign(forms.forRequester(i), { step }));
    }
    res.json({
      items: items.filter((i) => sameUser(i.by, req.user.username)).map(forms.forRequester),
      tickets: itList.filter((r) => r.source === "staff" && sameUser(r.addedBy, req.user.username)).map((r) => ({
        id: r.id, ref: ticketRef(r.id), submittedAt: r.submittedAt, issue: r.issue, urgency: r.urgency, company: r.company,
        status: requestStatus(r, r.taskId ? taskById.get(r.taskId) : null), withdrawn: !!r.withdrawn, archived: !!r.archived,
      })),
      approvals,
    });
  })
);

// The IT ticket form: an IT request like one added on IT → Requests, from
// the signed-in person (their login's email, so IT's replies reach them).
app.post(
  "/api/staff-forms/it-ticket",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const issue = String(b.issue || "").trim().slice(0, 1000);
    if (!issue) return res.status(400).json({ error: "Describe the issue" });
    const login = (await getUsers()).find((u) => sameUser(u.username, req.user.username)) || {};
    const urgency = ["Low", "Normal", "High", "Immediate"].includes(b.urgency) ? b.urgency : "Normal";
    const company = ["SOI", "CAS", "RedSun", "NanoTech"].includes(b.company) ? b.company : COMPANY_ENTITY[req.user.companies[0]] || "SOI";
    const rec = {
      id: "manual-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), formId: null, source: "staff",
      submittedAt: officeStamp(new Date().toISOString()),
      name: req.user.username, email: String(login.email || "").trim().toLowerCase().slice(0, 120),
      phone: forms.text(b.phone, 40), company, remote: "", issue, startedOn: "",
      urgency, contact: forms.text(b.contact, 60), notes: "",
      priority: "", status: "new", taskId: "", addedAt: Date.now(), addedBy: req.user.username,
    };
    await withItRequests((list) => { list.push(rec); });
    res.status(201).json({ id: rec.id, ref: ticketRef(rec.id), submittedAt: rec.submittedAt, issue, urgency, company, status: "new" });
  })
);

// Withdraw your own IT ticket while it's still New (nobody has picked it
// up). It's archived on IT → Requests, marked as withdrawn.
app.post(
  "/api/staff-forms/it-ticket/:id/cancel",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const tasks = await getTasks();
    let out = null, problem = "";
    await withItRequests((list) => {
      const r = list.find((x) => x.id === req.params.id);
      if (!r || r.source !== "staff" || !sameUser(r.addedBy, req.user.username)) { problem = "That isn't one of yours"; return; }
      const task = r.taskId ? tasks.find((t) => t.id === r.taskId) : null;
      if (r.archived || requestStatus(r, task) !== "new") { problem = "It's already being handled — ask IT instead"; return; }
      r.archived = true;
      r.archivedAt = Date.now();
      r.archivedBy = req.user.username;
      r.withdrawn = true;
      pushActivity(r, { type: "status", text: "Withdrawn by the requester", by: req.user.username });
      out = { id: r.id, ref: ticketRef(r.id), withdrawn: true };
    });
    if (problem) return res.status(400).json({ error: problem });
    res.json(out);
  })
);

// Send a form. Reimbursements start as "draft" until a receipt is attached
// (POST …/files, then …/submit).
const FORM_START = { admin: "new", hr_issue: "new", perf_comment: "new", leave: "cover", reimburse: "draft" };
app.post(
  "/api/staff-forms",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const kind = String(b.kind || "");
    const clean = forms.cleanFields(kind, b.fields);
    if (clean.error) return res.status(400).json({ error: clean.error });
    const company = req.user.companies.includes(b.company) ? b.company : req.user.companies[0];
    if (kind === "leave") {
      const login = (await getUsers()).map(normalizeUser).find((u) => sameUser(u.username, clean.fields.cover));
      if (!forms.canCover(login, req.user)) return res.status(400).json({ error: "Pick someone in your company to cover for you" });
      clean.fields.cover = login.username;
    }
    const item = {
      id: newId(), kind, company, by: req.user.username, at: Date.now(), status: FORM_START[kind],
      fields: clean.fields, assignee: "", notes: "", files: [], history: [],
    };
    formLog(item, req.user.username, kind === "reimburse" ? "Started" : "Sent", true);
    await withStaffForms((doc) => { doc.items.push(item); });
    res.status(201).json(forms.forRequester(item));
  })
);

async function findForm(id) {
  return ((await getStaffForms()).items || []).find((i) => i.id === id) || null;
}
// The department side may see this one (Finance only for its companies).
function seesForm(u, item) {
  if (!forms.canSeeKind(u, item.kind)) return false;
  return item.kind !== "reimburse" || u.companies.includes(item.company);
}

// Withdraw your own form while nobody has acted on it yet.
app.post(
  "/api/staff-forms/:id/cancel",
  authMiddleware,
  asyncHandler(async (req, res) => {
    let out = null, problem = "";
    await withStaffForms((doc) => {
      const item = doc.items.find((i) => i.id === req.params.id);
      if (!item || !sameUser(item.by, req.user.username)) { problem = "That isn't one of yours"; return; }
      if (!forms.canWithdraw(item)) { problem = "It's already being handled — ask the department instead"; return; }
      item.status = "cancelled";
      formLog(item, req.user.username, "Withdrawn", true);
      out = forms.forRequester(item);
    });
    if (problem) return res.status(400).json({ error: problem });
    res.json(out);
  })
);

// A new cover person for your own leave request, after the last one said
// no (or before they've answered). It goes to them to agree.
app.post(
  "/api/staff-forms/:id/cover",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const login = (await getUsers()).map(normalizeUser).find((u) => sameUser(u.username, (req.body || {}).cover));
    if (!forms.canCover(login, req.user)) return res.status(400).json({ error: "Pick someone in your company to cover for you" });
    let out = null, problem = "";
    await withStaffForms((doc) => {
      const item = doc.items.find((i) => i.id === req.params.id && i.kind === "leave");
      if (!item || !sameUser(item.by, req.user.username)) { problem = "That isn't one of yours"; return; }
      if (item.status !== "recover" && item.status !== "cover") { problem = "Your cover has already agreed"; return; }
      item.fields.cover = login.username;
      item.status = "cover";
      delete item.reason;
      formLog(item, req.user.username, "Asked " + login.username + " to cover", true);
      out = forms.forRequester(item);
    });
    if (problem) return res.status(400).json({ error: problem });
    res.json(out);
  })
);

// Receipts and other files: the person who sent it (while it's a draft or
// just submitted) or the department.
app.post(
  "/api/staff-forms/:id/files",
  authMiddleware,
  express.raw({ type: () => true, limit: "10mb" }),
  asyncHandler(async (req, res) => {
    const item = await findForm(req.params.id);
    if (!item) return res.status(404).json({ error: "That form isn't here" });
    const own = sameUser(item.by, req.user.username) && ["draft", "submitted", "new"].includes(item.status);
    if (!own && !(seesForm(req.user, item) && forms.canWorkKind(req.user, item.kind))) return res.status(403).json({ error: "You can't add files to this" });
    const name = String(req.query.name || "file").replace(/[\\/\r\n"]+/g, "_").slice(0, 160);
    const ext = (name.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    const type = ext && PERF_FILE_TYPES[ext.toLowerCase()];
    if (!type) return res.status(400).json({ error: "Attach a PDF, image, Word, Excel, text or email file" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file came through" });
    const file = { id: newId(), name, type, size: req.body.length, at: Date.now(), by: req.user.username };
    await putFile(`staff_form_files/${item.id}/${file.id}`, req.body, type);
    await withStaffForms((doc) => { const i = doc.items.find((x) => x.id === item.id); if (i) { i.files = i.files || []; i.files.push(file); } });
    res.status(201).json(file);
  })
);
app.get(
  "/api/staff-forms/:id/files/:fid",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const item = await findForm(req.params.id);
    if (!item || !(sameUser(item.by, req.user.username) || seesForm(req.user, item))) return res.status(404).json({ error: "That file isn't here" });
    const meta = (item.files || []).find((f) => f.id === req.params.fid);
    const file = meta && (await getFile(`staff_form_files/${item.id}/${meta.id}`));
    if (!file) return res.status(404).json({ error: "That file isn't here" });
    sendViewOnly(res, meta, file);
  })
);
// A reimbursement goes to Finance once it has a receipt.
app.post(
  "/api/staff-forms/:id/submit",
  authMiddleware,
  asyncHandler(async (req, res) => {
    let out = null, problem = "";
    await withStaffForms((doc) => {
      const item = doc.items.find((i) => i.id === req.params.id);
      if (!item || !sameUser(item.by, req.user.username)) { problem = "That isn't one of yours"; return; }
      if (item.kind !== "reimburse" || item.status !== "draft") { problem = "That's already been sent"; return; }
      if (!(item.files || []).length) { problem = "Attach a receipt first"; return; }
      item.status = "submitted";
      formLog(item, req.user.username, "Sent to Finance", true);
      out = forms.forRequester(item);
    });
    if (problem) return res.status(400).json({ error: problem });
    res.json(out);
  })
);

// The department's side: every form of its kinds (Finance: one company,
// drafts left out), plus who can be made responsible.
app.get(
  "/api/staff-forms/dept",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const dept = String(req.query.dept || "");
    const kinds = forms.kindsOf(dept).filter((k) => forms.canSeeKind(req.user, k));
    if (!kinds.length) return res.status(403).json({ error: "That department's forms aren't available to you" });
    const company = String(req.query.company || "");
    if (company && !req.user.companies.includes(company)) return res.status(403).json({ error: "You don't have access to that company" });
    const [doc, users] = await Promise.all([getStaffForms(), getUsers()]);
    const items = (doc.items || []).filter((i) => kinds.includes(i.kind) && seesForm(req.user, i) &&
      !(i.kind === "reimburse" && (i.status === "draft" || (company && i.company !== company))));
    const people = users.map(normalizeUser).filter((u) => u.fullAccess || u.departments.includes(dept)).map((u) => u.username)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    res.json({ items, kinds, canWork: kinds.some((k) => forms.canWorkKind(req.user, k)), manager: isManager(req.user), people });
  })
);

// Department side: status, person responsible, internal notes. A reason
// given when declining or rejecting is shown to the person who sent it.
app.post(
  "/api/staff-forms/:id/update",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const users = await getUsers();
    let out = null, problem = "", status = 400;
    await withStaffForms((doc) => {
      const item = doc.items.find((i) => i.id === req.params.id);
      if (!item || !seesForm(req.user, item)) { problem = "That form isn't here"; status = 404; return; }
      if (!forms.canWorkKind(req.user, item.kind)) { problem = "Only the department can change this"; status = 403; return; }
      const dept = forms.KINDS[item.kind].dept;
      if ("status" in b && b.status !== item.status) {
        problem = forms.moveBlocker(req.user, item, b.status);
        if (problem) { status = 403; return; }
        const reason = forms.text(b.reason, 500);
        formLog(item, req.user.username, forms.statusLabel(item.kind, b.status) + (reason ? ": " + reason : ""), true);
        item.status = b.status;
        if (reason) item.reason = reason;
        if (item.kind === "reimburse" && (b.status === "approved" || b.status === "paid")) {
          item[b.status + "By"] = req.user.username;
          item[b.status + "At"] = Date.now();
        }
      }
      if ("assignee" in b) {
        const who = forms.text(b.assignee, 80);
        const ok = !who || users.map(normalizeUser).some((u) => sameUser(u.username, who) && (u.fullAccess || u.departments.includes(dept)));
        if (!ok) { problem = "Pick someone in the department"; return; }
        if (!sameUser(who, item.assignee)) formLog(item, req.user.username, who ? "Given to " + who : "Unassigned");
        item.assignee = who;
      }
      if ("notes" in b) item.notes = String(b.notes == null ? "" : b.notes).trim().slice(0, 2000);
      item.updatedAt = Date.now();
      out = item;
    });
    if (problem) return res.status(status).json({ error: problem });
    res.json(out);
  })
);

// Leave approvals, one step at a time: the person covering, then a manager
// in the requester's department, then HR. A no from the cover person sends
// it back to the requester to pick someone else; a no from the manager or
// HR declines it. HR can cancel approved leave (it then drops out of Payroll).
app.post(
  "/api/staff-forms/:id/leave",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const decision = String(b.decision || "");
    const note = forms.text(b.note, 500);
    const logins = loginsByName(await getUsers());
    let out = null, problem = "";
    await withStaffForms((doc) => {
      const item = doc.items.find((i) => i.id === req.params.id && i.kind === "leave");
      if (!item) { problem = "That leave request isn't here"; return; }
      if (decision === "cancel") {
        if (!forms.hrManager(req.user) || item.status !== "approved") { problem = "Only HR can cancel approved leave"; return; }
        if (!note) { problem = "Say why it's cancelled"; return; }
        item.status = "cancelled";
        formLog(item, req.user.username, "Cancelled by HR: " + note, true);
        out = item;
        return;
      }
      const step = forms.leaveStep(req.user, item, logins.get(String(item.by).toLowerCase()));
      if (!step) { problem = "This leave request isn't waiting for you"; return; }
      const mark = { by: req.user.username, at: Date.now(), note };
      if (decision === "approve") {
        if (step === "cover") { item.coverOk = mark; item.status = "manager"; }
        else if (step === "manager") { item.managerOk = mark; item.status = "hr"; }
        else { item.hrOk = mark; item.status = "approved"; }
        formLog(item, req.user.username, { cover: "Cover agreed", manager: "Approved by manager", hr: "Approved by HR" }[step] + (note ? ": " + note : ""), true);
      } else if (decision === "decline" && step === "cover") {
        if (!note) { problem = "Say why you can't cover"; return; }
        item.coverDeclined = mark;
        item.status = "recover";
        item.reason = note;
        formLog(item, req.user.username, "Can't cover: " + note, true);
      } else if (decision === "decline") {
        if (!note) { problem = "Say why it's declined"; return; }
        item.declined = Object.assign({ step }, mark);
        item.status = "declined";
        item.reason = note;
        formLog(item, req.user.username, "Declined: " + note, true);
      } else { problem = "Approve or decline"; return; }
      out = forms.forRequester(item);
    });
    if (problem) return res.status(400).json({ error: problem });
    res.json(out);
  })
);

// ---------- HR → Payroll (ROADMAP.md Phase 4) ----------
// Approved leave per person per pay week, each person's weekly base pay
// (entered by HR) and one-off adjustments, grouped by entity. HR hasn't
// given the rules for how each kind of leave changes pay, so nothing here
// works out pay: each entity has a "rules" box HR fills in as a reference,
// and every figure must be checked by a qualified person before any real
// payroll is sent. HR, Leadership and full access see it; HR managers (and
// full access) change it. Phase 5's spot bonus adds an adjustment.
const PAY_ENTITY_LABEL = { SOI: "SOI Aviation · US (California)", CAS: "CAS · New Zealand", RedSun: "Red Sun Aviation · Singapore", NanoTech: "Nanotech Aviation · UK" };
const PAY_FREQUENCIES = ["weekly", "fortnightly", "monthly"];
function payrollShape(doc) {
  doc.entities = doc.entities && typeof doc.entities === "object" ? doc.entities : {};
  doc.people = doc.people && typeof doc.people === "object" ? doc.people : {};
  doc.adjustments = Array.isArray(doc.adjustments) ? doc.adjustments : [];
  doc.approvals = doc.approvals && typeof doc.approvals === "object" ? doc.approvals : {};
  doc.approvalLog = Array.isArray(doc.approvalLog) ? doc.approvalLog : [];
  return doc;
}
const hrManagerOnly = (req, res, next) => (forms.hrManager(req.user) ? next() : res.status(403).json({ error: "Only HR managers can change payroll" }));

app.get(
  "/api/payroll",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!forms.canSeeHr(req.user)) return res.status(403).json({ error: "Payroll is for HR, Leadership and full access" });
    const [doc, stored, users] = await Promise.all([getPayroll(), getStaffForms(), getUsers()]);
    payrollShape(doc);
    const logins = users.map(normalizeUser).map((u) => ({ username: u.username, entity: COMPANY_ENTITY[u.companies[0]] || "SOI", departments: u.departments }));
    const leave = (stored.items || []).filter((i) => i.kind === "leave" && i.status !== "cancelled");
    res.json({
      entities: doc.entities, people: doc.people, adjustments: doc.adjustments, logins, leave,
      approvals: doc.approvals, approvalLog: doc.approvalLog.slice(-200), mailConfigured,
      entityLabels: PAY_ENTITY_LABEL, leaveTypes: forms.LEAVE_TYPES, currencies: forms.CURRENCIES, canEdit: forms.hrManager(req.user),
    });
  })
);

// One entity's pay period, currency and leave rules (text HR writes; the
// tracker doesn't apply them).
app.put(
  "/api/payroll/entity/:entity",
  authMiddleware,
  hrManagerOnly,
  asyncHandler(async (req, res) => {
    const ent = req.params.entity;
    if (!PAY_ENTITY_LABEL[ent]) return res.status(404).json({ error: "Unknown entity" });
    const b = req.body || {};
    let accountants = null;
    if ("accountants" in b) {
      const parsed = payCheck.parseEmails(b.accountants);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      accountants = parsed.emails;
    }
    let out = null;
    await withPayroll((doc) => {
      payrollShape(doc);
      const e = (doc.entities[ent] = doc.entities[ent] || {});
      // The external accountants who check the week's figures (approve and send).
      if (accountants) { e.accountants = accountants; e.accountantsBy = req.user.username; e.accountantsAt = Date.now(); }
      if ("frequency" in b) e.frequency = PAY_FREQUENCIES.includes(b.frequency) ? b.frequency : "weekly";
      if ("currency" in b) e.currency = forms.CURRENCIES.includes(b.currency) ? b.currency : "";
      if (b.rules && typeof b.rules === "object") {
        e.rules = {};
        for (const t of forms.LEAVE_TYPES) e.rules[t.id] = String(b.rules[t.id] || "").trim().slice(0, 1000);
        e.rulesBy = req.user.username;
        e.rulesAt = Date.now();
      }
      out = e;
    });
    res.json(out);
  })
);

// One person's entity and weekly base pay.
app.put(
  "/api/payroll/person/:username",
  authMiddleware,
  hrManagerOnly,
  asyncHandler(async (req, res) => {
    const login = (await getUsers()).find((u) => sameUser(u.username, req.params.username));
    if (!login) return res.status(404).json({ error: "No login by that name" });
    const b = req.body || {};
    if ("basePay" in b && sameUser(login.username, req.user.username)) return res.status(403).json({ error: "Someone else in HR changes your own pay" });
    let out = null, problem = "";
    await withPayroll((doc) => {
      payrollShape(doc);
      const p = (doc.people[login.username] = doc.people[login.username] || {});
      if ("entity" in b) p.entity = PAY_ENTITY_LABEL[b.entity] ? b.entity : "";
      if ("basePay" in b) {
        const n = Math.round(Number(b.basePay) * 100) / 100;
        if (b.basePay === "" || b.basePay == null) p.basePay = null;
        else if (Number.isFinite(n) && n >= 0 && n < 1e6) p.basePay = n;
        else { problem = "Enter the weekly base pay as a number"; return; }
      }
      if ("employeeId" in b) p.employeeId = forms.text(b.employeeId, 40);
      p.updatedBy = req.user.username;
      p.updatedAt = Date.now();
      out = p;
    });
    if (problem) return res.status(400).json({ error: problem });
    res.json(out);
  })
);

// One-off additions or deductions in a pay week (Phase 5's spot bonus is one).
app.post(
  "/api/payroll/adjustments",
  authMiddleware,
  hrManagerOnly,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const users = await getUsers();
    const login = users.find((u) => sameUser(u.username, b.person));
    if (!login) return res.status(400).json({ error: "Pick a person" });
    if (sameUser(login.username, req.user.username)) return res.status(403).json({ error: "Someone else in HR adds pay for you" });
    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!Number.isFinite(amount) || !amount || Math.abs(amount) >= 1e6) return res.status(400).json({ error: "Enter an amount" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.week || "")) return res.status(400).json({ error: "Pick the pay week" });
    const reason = forms.text(b.reason, 200);
    if (!reason) return res.status(400).json({ error: "Say what it's for" });
    const adj = {
      id: newId(), person: login.username, week: b.week, amount, currency: forms.CURRENCIES.includes(b.currency) ? b.currency : "",
      reason, source: "manual", by: req.user.username, at: Date.now(),
    };
    let locked = false;
    await withPayroll((doc) => {
      payrollShape(doc);
      // An approved week is locked until HR undoes the approval.
      if (payCheck.approvalOf(doc, payCheck.entityOf(doc, normalizeUser(login), COMPANY_ENTITY), adj.week)) { locked = true; return; }
      doc.adjustments.push(adj);
    });
    if (locked) return res.status(409).json({ error: "That pay week is approved and sent to the accountants — undo the approval first" });
    res.status(201).json(adj);
  })
);
app.delete(
  "/api/payroll/adjustments/:id",
  authMiddleware,
  hrManagerOnly,
  asyncHandler(async (req, res) => {
    const users = (await getUsers()).map(normalizeUser);
    let locked = false;
    await withPayroll((doc) => {
      payrollShape(doc);
      const adj = doc.adjustments.find((a) => a.id === req.params.id);
      const login = adj && users.find((u) => sameUser(u.username, adj.person));
      if (adj && payCheck.adjustmentLocked(doc, adj, login ? payCheck.entityOf(doc, login, COMPANY_ENTITY) : "")) { locked = true; return; }
      doc.adjustments = doc.adjustments.filter((a) => a.id !== req.params.id);
    });
    if (locked) return res.status(409).json({ error: "That pay week is approved and sent to the accountants — undo the approval first" });
    res.json({ ok: true });
  })
);

// ---------- HR → Payroll: approve and send to the accountants ----------
// An entity's pay week, approved by someone who can edit Payroll, is
// emailed to that entity's external accountants for their check before
// they run payroll (rules and email in payrollcheck.js). The figures are
// stored with the approval as they were sent, and the week is locked (no
// adjustments added or removed, spot bonuses included) until it's undone
// with a reason. Without email set up (staging) the approval is still
// recorded, marked as not sent.
app.post(
  "/api/payroll/approve",
  authMiddleware,
  hrManagerOnly,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const ent = String(b.entity || ""), week = String(b.week || "");
    if (!PAY_ENTITY_LABEL[ent]) return res.status(404).json({ error: "Unknown entity" });
    if (!payCheck.isMonday(week)) return res.status(400).json({ error: "Pick the pay week" });
    const [users, stored] = await Promise.all([getUsers(), getStaffForms()]);
    const logins = users.map(normalizeUser);
    const me = logins.find((u) => sameUser(u.username, req.user.username)) || {};
    let approval = null, problem = "", status = 400;
    await withPayroll((doc) => {
      payrollShape(doc);
      const sentTo = ((doc.entities[ent] || {}).accountants || []).slice();
      if (!sentTo.length) { problem = "Add the accountants' email first"; return; }
      if (payCheck.approvalOf(doc, ent, week)) { problem = "That week is already approved"; status = 409; return; }
      const snapshot = payCheck.buildSnapshot({ payroll: doc, logins, leave: stored.items || [], entity: ent, week, label: PAY_ENTITY_LABEL[ent], companyEntity: COMPANY_ENTITY });
      approval = { by: req.user.username, at: Date.now(), sentTo, mailed: false, snapshot };
      (doc.approvals[ent] = doc.approvals[ent] || {})[week] = approval;
      doc.approvalLog.push({ entity: ent, week, what: "approved", by: approval.by, at: approval.at, sentTo });
    });
    if (problem) return res.status(status).json({ error: problem });
    // Recorded first, then sent: a failed send leaves it approved and says why.
    let mailed = false, mailError = "";
    if (mailConfigured) {
      const mail = payCheck.snapshotEmail(approval.snapshot, approval, escapeHtml);
      try {
        mailed = await sendMail({ to: approval.sentTo, subject: mail.subject, html: mail.html, saveCopy: true, replyTo: me.email ? [me.email] : undefined });
      } catch (err) {
        console.error("Payroll approval email failed:", err.message);
        mailError = err.reason || "The email couldn't be sent";
      }
    }
    await withPayroll((doc) => {
      const ap = payCheck.approvalOf(payrollShape(doc), ent, week);
      if (ap && ap.at === approval.at) { ap.mailed = mailed; if (mailError) ap.mailError = mailError; approval = ap; }
      const log = doc.approvalLog.find((l) => l.entity === ent && l.week === week && l.at === approval.at);
      if (log) log.mailed = mailed;
    });
    res.status(201).json(Object.assign({ mailConfigured }, approval));
  })
);
// Undo an approval (a reason is required): the week unlocks; approving it
// again sends again.
app.post(
  "/api/payroll/approve/undo",
  authMiddleware,
  hrManagerOnly,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const ent = String(b.entity || ""), week = String(b.week || "");
    const reason = forms.text(b.reason, 500);
    if (!reason) return res.status(400).json({ error: "Say why the approval is undone" });
    let found = false;
    await withPayroll((doc) => {
      payrollShape(doc);
      if (!payCheck.approvalOf(doc, ent, week)) return;
      found = true;
      delete doc.approvals[ent][week];
      doc.approvalLog.push({ entity: ent, week, what: "undone", by: req.user.username, at: Date.now(), reason });
    });
    if (!found) return res.status(404).json({ error: "That week isn't approved" });
    res.json({ ok: true });
  })
);

// ---------- People (ROADMAP.md Phase 5) ----------
// Leadership only, checked on every route: every login with its employment
// file (people.json, documents under people_files/<file id>/) and a
// one-click $100 spot bonus on the next pay week. Weekly base pay, pay
// currency and entity are Payroll's (payroll.json), so both pages show the
// same figures. History is read from what's already stored: approved
// leave, payroll adjustments and performance comments. Rules in people.js.
const peopleOnly = (req, res, next) => (employment.isLeadership(req.user) ? next() : res.status(403).json({ error: "People is for Leadership only" }));

function payEntityFor(payroll, u) {
  const ent = ((payroll.people || {})[u.username] || {}).entity;
  return PAY_ENTITY_LABEL[ent] ? ent : COMPANY_ENTITY[u.companies[0]] || "SOI";
}
// One row of the list (and the top of a file).
function personSummary(u, file, payroll) {
  const f = file || {};
  return {
    username: u.username, email: String(u.email || "").trim().toLowerCase(), companies: u.companies, entity: payEntityFor(payroll, u),
    department: f.department || u.departments[0] || "", departments: u.fullAccess ? ["Full access"] : u.departments, role: employment.roleLabel(u),
    jobTitle: f.jobTitle || "", manager: f.manager || "", employmentType: f.employmentType || "", startDate: f.startDate || "",
  };
}
async function personLogin(username) {
  return (await getUsers()).map(normalizeUser).find((u) => sameUser(u.username, username)) || null;
}
const peopleLog = (file, by, what) => { file.history.push({ at: Date.now(), by, what }); file.history = file.history.slice(-200); };

app.get(
  "/api/people",
  authMiddleware,
  peopleOnly,
  asyncHandler(async (req, res) => {
    const [users, doc, payroll] = await Promise.all([getUsers(), getPeople(), getPayroll()]);
    employment.peopleShape(doc);
    payrollShape(payroll);
    const list = users.map(normalizeUser).map((u) => personSummary(u, doc.people[u.username], payroll))
      .sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
    res.json({ people: list, entityLabels: PAY_ENTITY_LABEL });
  })
);

// One person's employment file, pay (from Payroll) and history.
app.get(
  "/api/people/:username",
  authMiddleware,
  peopleOnly,
  asyncHandler(async (req, res) => {
    const login = await personLogin(req.params.username);
    if (!login) return res.status(404).json({ error: "No login by that name" });
    const [users, doc, payroll, stored, perfDoc, seesPerf] = await Promise.all([getUsers(), getPeople(), getPayroll(), getStaffForms(), getPerformance(), hasPerformance(req.user)]);
    employment.peopleShape(doc);
    payrollShape(payroll);
    const f = doc.people[login.username] || {};
    const p = payroll.people[login.username] || {};
    const today = perfOfficeToday();
    const entity = payEntityFor(payroll, login);
    const items = stored.items || [];
    const logins = users.map(normalizeUser);
    const isThem = (name) => employment.matchLogin(name, logins).username === login.username;
    // Performance comments name people in free text (older ones) or by
    // username (the form's list since Phase 5): linked by matchLogin. One
    // that could be more than one login is attached to none and listed as
    // unmatched on each of their files.
    const perfComments = [], perfUnmatched = [];
    for (const i of items) {
      if (i.kind !== "perf_comment" || i.status === "cancelled") continue;
      const m = employment.matchLogin((i.fields || {}).about, logins);
      if (m.username === login.username) perfComments.push({ id: i.id, by: i.by, at: i.at, status: i.status, fields: i.fields });
      else if ((m.ambiguous || []).includes(login.username)) perfUnmatched.push({ id: i.id, at: i.at, about: i.fields.about, type: i.fields.type, could: m.ambiguous });
    }
    // The Performance tracker is private: the summary is only for Leadership
    // who also have Performance access; anyone else is told records exist.
    // Its records are the login's own, plus people added without a login
    // ("x-…") whose name matches this login.
    const perfMatched = perfPeople(logins, perfShape(perfDoc)).filter((x) => x.key === login.username || (!x.login && isThem(x.name)));
    let performance;
    if (seesPerf) {
      const settings = await perfSettings();
      performance = { access: true, records: perfMatched.map((x) => {
        const st = perfStatus(x.rec, settings, today);
        return { key: x.key, name: x.name, stageLabel: st.stageLabel, stageDate: st.stageDate, notes: (x.rec.entries || []).length };
      }) };
    } else {
      performance = { access: false, exists: perfMatched.some((x) => (x.rec.entries || []).length || (x.rec.steps || []).length) };
    }
    res.json(Object.assign(personSummary(login, f, payroll), {
      birthday: f.birthday || "", emergency: f.emergency || {}, notes: f.notes || "", otherNotes: f.otherNotes || "", files: f.files || [],
      history: (f.history || []).slice().reverse(), updatedBy: f.updatedBy || "", updatedAt: f.updatedAt || 0,
      pay: { basePay: p.basePay == null ? null : p.basePay, currency: p.currency || "", entity: PAY_ENTITY_LABEL[p.entity] ? p.entity : "", employeeId: p.employeeId || "", entityCurrency: (payroll.entities[entity] || {}).currency || "",
        exempt: typeof p.exempt === "boolean" ? p.exempt : null },
      spot: { amount: employment.SPOT_BONUS.amount, week: employment.nextPayWeek(today), currency: employment.payCurrency(payroll, login.username, entity, forms.CURRENCIES) },
      leave: items.filter((i) => i.kind === "leave" && i.status === "approved" && sameUser(i.by, login.username))
        .map((i) => ({ id: i.id, fields: i.fields, status: i.status })).sort((a, b) => String(b.fields.from).localeCompare(String(a.fields.from))),
      adjustments: payroll.adjustments.filter((a) => sameUser(a.person, login.username))
        .map((a) => Object.assign({}, a, { removable: !employment.spotBonusLock(a, payCheck.adjustmentLocked(payroll, a, entity)) }))
        .sort((a, b) => String(b.week).localeCompare(String(a.week)) || (b.at || 0) - (a.at || 0)),
      perfComments: perfComments.sort((a, b) => b.at - a.at), perfUnmatched: perfUnmatched.sort((a, b) => b.at - a.at),
      performance, today,
      options: {
        departments: DEPARTMENTS, logins: users.map((u) => u.username).filter((n) => !sameUser(n, login.username)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
        employmentTypes: employment.EMPLOYMENT_TYPES, currencies: forms.CURRENCIES, entities: PAY_ENTITY_LABEL,
      },
    }));
  })
);

// Save one section of the employment file (only the fields sent change).
// basePay, currency and entity are written to Payroll (the same record
// HR → Payroll edits).
app.put(
  "/api/people/:username",
  authMiddleware,
  peopleOnly,
  asyncHandler(async (req, res) => {
    const users = (await getUsers()).map(normalizeUser);
    const login = users.find((u) => sameUser(u.username, req.params.username));
    if (!login) return res.status(404).json({ error: "No login by that name" });
    const b = req.body || {};
    const clean = employment.cleanFile(b, DEPARTMENTS, users.map((u) => u.username).filter((n) => !sameUser(n, login.username)));
    if (clean.error) return res.status(400).json({ error: clean.error });
    const pay = {};
    if ("basePay" in b) {
      const n = Math.round(Number(b.basePay) * 100) / 100;
      if (b.basePay === "" || b.basePay == null) pay.basePay = null;
      else if (Number.isFinite(n) && n >= 0 && n < 1e6) pay.basePay = n;
      else return res.status(400).json({ error: "Enter the weekly base pay as a number" });
    }
    if ("currency" in b) pay.currency = forms.CURRENCIES.includes(b.currency) ? b.currency : "";
    if ("entity" in b) pay.entity = PAY_ENTITY_LABEL[b.entity] ? b.entity : "";
    // Exempt (salaried, no overtime): a flag HR or Leadership sets for SOI
    // (US) employees only. Nothing works out overtime from it.
    if ("exempt" in b) pay.exempt = !!b.exempt;
    if (Object.keys(pay).length && sameUser(login.username, req.user.username)) return res.status(403).json({ error: "Someone else in Leadership (or HR) changes your own pay" });
    const changed = [];
    let problem = "";
    if (Object.keys(pay).length) {
      await withPayroll((doc) => {
        payrollShape(doc);
        const p = (doc.people[login.username] = doc.people[login.username] || {});
        const entityAfter = payEntityFor({ people: { [login.username]: { entity: "entity" in pay ? pay.entity : p.entity } } }, login);
        if ("exempt" in pay && entityAfter !== "SOI") {
          if (pay.exempt) { problem = "Exempt is for SOI (US) employees only"; return; }
          delete pay.exempt;
        }
        for (const k of Object.keys(pay)) {
          if ((p[k] == null ? "" : String(p[k])) !== (pay[k] == null ? "" : String(pay[k]))) changed.push({ basePay: "base pay", currency: "pay currency", entity: "entity", exempt: "exempt status" }[k]);
          p[k] = pay[k];
        }
        if (changed.length) { p.updatedBy = req.user.username; p.updatedAt = Date.now(); }
      });
    }
    if (problem) return res.status(400).json({ error: problem });
    await withPeople((doc) => {
      const f = employment.fileOf(employment.peopleShape(doc), login.username, newId);
      changed.unshift(...employment.changedFields(f, clean.fields));
      Object.assign(f, clean.fields);
      if (changed.length) {
        peopleLog(f, req.user.username, "Updated " + changed.join(", "));
        f.updatedBy = req.user.username;
        f.updatedAt = Date.now();
      }
    });
    res.json({ ok: true, changed });
  })
);

// Supporting documents (contract, offer letter, certificates), up to 10 MB.
app.post(
  "/api/people/:username/files",
  authMiddleware,
  peopleOnly,
  express.raw({ type: () => true, limit: "10mb" }),
  asyncHandler(async (req, res) => {
    const login = await personLogin(req.params.username);
    if (!login) return res.status(404).json({ error: "No login by that name" });
    const name = String(req.query.name || "file").replace(/[\\/\r\n"]+/g, "_").slice(0, 160);
    const ext = (name.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    const type = ext && PERF_FILE_TYPES[ext.toLowerCase()];
    if (!type) return res.status(400).json({ error: "Attach a PDF, image, Word, Excel, text or email file" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file came through" });
    const meta = { id: newId(), name, type, size: req.body.length, at: Date.now(), by: req.user.username };
    // The folder id is made (and saved) before the upload so the file is never orphaned.
    const folder = await withPeople((doc) => employment.fileOf(employment.peopleShape(doc), login.username, newId).id);
    await putFile(`people_files/${folder}/${meta.id}`, req.body, type);
    await withPeople((doc) => {
      const f = employment.fileOf(employment.peopleShape(doc), login.username, newId);
      f.files.push(meta);
      peopleLog(f, req.user.username, "Added " + name);
    });
    res.status(201).json(meta);
  })
);
app.get(
  "/api/people/:username/files/:fid",
  authMiddleware,
  peopleOnly,
  asyncHandler(async (req, res) => {
    const login = await personLogin(req.params.username);
    const f = login && employment.peopleShape(await getPeople()).people[login.username];
    const meta = f && (f.files || []).find((x) => x.id === req.params.fid);
    const file = meta && (await getFile(`people_files/${f.id}/${meta.id}`));
    if (!file) return res.status(404).json({ error: "That file isn't here" });
    sendViewOnly(res, meta, file);
  })
);
app.delete(
  "/api/people/:username/files/:fid",
  authMiddleware,
  peopleOnly,
  asyncHandler(async (req, res) => {
    const login = await personLogin(req.params.username);
    if (!login) return res.status(404).json({ error: "No login by that name" });
    const gone = await withPeople((doc) => {
      const f = employment.fileOf(employment.peopleShape(doc), login.username, newId);
      const i = f.files.findIndex((x) => x.id === req.params.fid);
      if (i === -1) return null;
      const meta = f.files.splice(i, 1)[0];
      peopleLog(f, req.user.username, "Removed " + meta.name);
      return { folder: f.id, id: meta.id };
    });
    if (!gone) return res.status(404).json({ error: "That file isn't here" });
    await deleteFile(`people_files/${gone.folder}/${gone.id}`).catch(() => {});
    res.status(204).end();
  })
);

// Spot bonus: $100 (in the person's pay currency, else USD) as an
// adjustment on the next pay week, shown on HR → Payroll. The browser sends
// the currency it showed in the confirm; if that has changed since, nothing
// is added. A second click within 10 seconds doesn't add another.
app.post(
  "/api/people/:username/spot-bonus",
  authMiddleware,
  peopleOnly,
  asyncHandler(async (req, res) => {
    const login = await personLogin(req.params.username);
    if (!login) return res.status(404).json({ error: "No login by that name" });
    if (sameUser(login.username, req.user.username)) return res.status(403).json({ error: "You can't give yourself a spot bonus" });
    const b = req.body || {};
    const reason = forms.text(b.reason, 200) || "Spot bonus";
    const week = employment.nextPayWeek(perfOfficeToday());
    let out = null, problem = "", created = false;
    await withPayroll((doc) => {
      payrollShape(doc);
      const currency = employment.payCurrency(doc, login.username, payEntityFor(doc, login), forms.CURRENCIES);
      if (payCheck.approvalOf(doc, payEntityFor(doc, login), week)) { problem = "Next week's payroll for their entity is already approved and sent — HR has to undo the approval first"; return; }
      if (b.currency && b.currency !== currency) { problem = `Their pay currency is now ${currency} — reload and try again`; return; }
      out = doc.adjustments.find((a) => a.source === employment.SPOT_BONUS.source && sameUser(a.person, login.username) && sameUser(a.by, req.user.username) && Date.now() - (a.at || 0) < 10000);
      if (out) return;
      out = {
        id: newId(), person: login.username, week, amount: employment.SPOT_BONUS.amount, currency,
        reason, source: employment.SPOT_BONUS.source, by: req.user.username, at: Date.now(),
      };
      doc.adjustments.push(out);
      created = true;
    });
    if (problem) return res.status(409).json({ error: problem });
    if (created) {
      await withPeople((doc) => { peopleLog(employment.fileOf(employment.peopleShape(doc), login.username, newId), req.user.username, `Spot bonus ${out.currency} ${out.amount} for the week of ${out.week}: ${reason}`); });
    }
    res.status(created ? 201 : 200).json(out);
  })
);
// Take a spot bonus back while its pay week hasn't ended (see people.js).
app.delete(
  "/api/people/:username/spot-bonus/:id",
  authMiddleware,
  peopleOnly,
  asyncHandler(async (req, res) => {
    const login = await personLogin(req.params.username);
    if (!login) return res.status(404).json({ error: "No login by that name" });
    let gone = null, problem = "";
    await withPayroll((doc) => {
      payrollShape(doc);
      const adj = doc.adjustments.find((a) => a.id === req.params.id && sameUser(a.person, login.username));
      if (!adj) { problem = "That spot bonus isn't here"; return; }
      problem = employment.spotBonusLock(adj, payCheck.adjustmentLocked(doc, adj, payEntityFor(doc, login)));
      if (problem) return;
      doc.adjustments = doc.adjustments.filter((a) => a !== adj);
      gone = adj;
    });
    if (problem) return res.status(400).json({ error: problem });
    await withPeople((doc) => { peopleLog(employment.fileOf(employment.peopleShape(doc), login.username, newId), req.user.username, `Removed the spot bonus for the week of ${gone.week}`); });
    res.status(204).end();
  })
);

// ---------- Documents ----------
// A file manager for SOI's S3 (ROADMAP.md Phase 6; rules in documents.js).
// One space per company and department you're in (every department for full
// access and Leadership), plus the Operations / US Gov board files you can
// see. Read-only unless IT has granted you edit access to the folder (full
// access edits everywhere it sees). Documents are shown in the page, never
// offered as a download; the page says that this only discourages copying.
const DOC_MAX = "15mb";
function docSpaces(u) {
  return docs.spacesFor(u, { companies: COMPANIES, departments: DEPARTMENTS, canSeeBoard: (x, b) => canSeeBoard(x, BOARDS[b]), legal: legal.hasLegal(u, legalSnap.doc) });
}
// Legal's named staff, read at most every 30 seconds (and kept current by
// every Legal change), so Documents knows who sees the Legal folders.
let legalSnap = { at: 0, doc: legal.shape({}) };
async function freshLegal() {
  if (Date.now() - legalSnap.at > 30000) legalSnap = { at: Date.now(), doc: legal.shape(await getLegal()) };
  return legalSnap.doc;
}
app.use("/api/documents", (req, res, next) => { freshLegal().then(() => next(), next); });
// docs.folderIn, plus Legal's per-section access: a Legal section folder
// (and everything in it) is only there for people ticked for that section.
function docIn(req, doc, space, folderId) {
  const here = docs.folderIn(doc, space, folderId);
  if (!here || !folderId) return here;
  const sp = docs.parseSpace(space);
  if (!sp || sp.kind !== "dept" || sp.dept !== legal.LEGAL) return here;
  const section = docs.chain(doc, folderId).find((f) => f.legal);
  return section && !legal.hasSection(req.user, legalSnap.doc, section.legal) ? null : here;
}
function docSpace(req, res, id) {
  const sp = docSpaces(req.user).find((s) => s.id === id);
  if (!sp) res.status(404).json({ error: "That folder isn't here" });
  return sp || null;
}
function docFileOut(f) {
  const v = f.versions[f.versions.length - 1] || {};
  return { id: f.id, name: f.name, type: v.type || f.type, size: v.size || 0, at: v.at || f.at, by: v.by || f.by, versions: f.versions.length, preview: docs.canPreview(v.type || f.type) };
}
function docBoardLabel(c) {
  return [c.fileNo || c.quoteNo || c.rfqNo || c.orderNo || "File", c.customer || c.vendor || ""].filter(Boolean).join(" · ") + (c.archived ? " (archived)" : "");
}
// A "Request edit" ticket nobody has decided yet (resolving or withdrawing
// the ticket on IT → Requests closes it too).
const docEditOpen = (r) => !!(r.docEdit && !r.docEdit.decidedAt && !r.archived && r.status !== "done");
// An open "Request edit" ticket of yours for this folder (or one above it).
function docOpenRequest(list, doc, u, space, folder) {
  const ids = new Set([""].concat(docs.chain(doc, folder).map((f) => f.id)));
  return list.find((r) => docEditOpen(r) && sameUser(r.addedBy, u.username) && r.docEdit.space === space && ids.has(r.docEdit.folder || "")) || null;
}

app.get(
  "/api/documents",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const doc = docs.shape(await getDocuments());
    const now = Date.now();
    const grants = doc.grants.filter((g) => docs.grantLive(g, now) && sameUser(g.user, req.user.username))
      .map((g) => ({ id: g.id, space: g.space, folder: g.folder || "", path: docs.pathLabel(doc, g.space, g.folder), until: g.until || null }));
    res.json({ spaces: docSpaces(req.user), grants, grantsAdmin: docs.grantsAdmin(req.user), fullAccess: !!req.user.fullAccess, previewTypes: docs.PREVIEW_TYPES });
  })
);

// One folder: its subfolders and documents. ?space=…&folder=… ("" = top).
app.get(
  "/api/documents/list",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const sp = docSpace(req, res, String(req.query.space || ""));
    if (!sp) return;
    const folderId = String(req.query.folder || "");
    if (sp.kind === "board") {
      const cfg = BOARDS[sp.board];
      const cards = ((await getBoard(cfg.store)).cards || []).filter((c) => canSeeBoardCard(req.user, c, cfg) && (c.files || []).length);
      if (!folderId) {
        return res.json({ space: sp.id, folder: "", path: [], canEdit: false,
          folders: cards.map((c) => ({ id: c.id, name: docBoardLabel(c), at: c.updatedAt || c.createdAt || 0, count: c.files.length })).sort((a, b) => b.at - a.at),
          files: [] });
      }
      const c = cards.find((x) => x.id === folderId);
      if (!c) return res.status(404).json({ error: "That file isn't here" });
      return res.json({ space: sp.id, folder: c.id, path: [{ id: c.id, name: docBoardLabel(c) }], canEdit: false, folders: [],
        files: c.files.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size, at: f.at, by: f.by, versions: 1, preview: docs.canPreview(f.type) })) });
    }
    const [doc, itList] = await Promise.all([getDocuments().then(docs.shape), getItRequests()]);
    const here = docIn(req, doc, sp.id, folderId);
    if (!here) return res.status(404).json({ error: "That folder isn't here" });
    const grant = docs.liveGrant(doc, req.user, sp.id, folderId);
    const reqOpen = docOpenRequest(itList, doc, req.user, sp.id, folderId);
    res.json({
      space: sp.id, folder: folderId,
      path: docs.chain(doc, folderId).reverse().map((f) => ({ id: f.id, name: f.name })),
      canEdit: docs.mayEdit(doc, req.user, sp.id, folderId, true),
      editUntil: grant ? grant.until || null : undefined,
      request: reqOpen ? { ref: ticketRef(reqOpen.id), at: reqOpen.addedAt } : null,
      folders: doc.folders.filter((f) => f.space === sp.id && (f.parent || "") === folderId && !f.archived && docIn(req, doc, sp.id, f.id))
        .map((f) => ({ id: f.id, name: f.name, at: f.at, by: f.by })).sort((a, b) => a.name.localeCompare(b.name)),
      files: doc.files.filter((f) => f.space === sp.id && (f.folder || "") === folderId && !f.archived).map(docFileOut).sort((a, b) => a.name.localeCompare(b.name)),
    });
  })
);

// A document you can see, by { space, folder, file, v } (v = a version id;
// the latest when left out): its name and type, its S3 key and where it is.
// Answers 404 itself and returns null when it isn't yours to see.
async function docSource(req, res, q) {
  const sp = docSpace(req, res, String(q.space || ""));
  if (!sp) return null;
  let meta = null, key = "", where = "", docFile = null;
  if (sp.kind === "board") {
    const cfg = BOARDS[sp.board];
    const c = ((await getBoard(cfg.store)).cards || []).find((x) => x.id === String(q.folder || ""));
    meta = c && canSeeBoardCard(req.user, c, cfg) && (c.files || []).find((f) => f.id === String(q.file || ""));
    if (meta) { key = boardFileKey(cfg, c, meta); where = `${sp.label} › ${docBoardLabel(c)}`; }
  } else {
    const doc = docs.shape(await getDocuments());
    const f = doc.files.find((x) => x.id === String(q.file || "") && x.space === sp.id && !x.archived);
    const v = f && docIn(req, doc, sp.id, f.folder) && (q.v ? f.versions.find((x) => x.id === String(q.v)) : f.versions[f.versions.length - 1]);
    if (v) { meta = { name: f.name, type: v.type || f.type }; key = `documents_files/${f.id}/${v.id}`; where = docs.pathLabel(doc, sp.id, f.folder); docFile = f; }
  }
  if (!meta) { res.status(404).json({ error: "That document isn't here" }); return null; }
  return { sp, meta, key, where, docFile };
}

// Show a document in the page: PDFs, pictures and text only, inline, never
// as an attachment. ?space=…&folder=…&file=…[&v=version id]
app.get(
  "/api/documents/view",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const src = await docSource(req, res, req.query);
    if (!src) return;
    const { meta, key } = src;
    if (!docs.canPreview(meta.type)) return res.status(415).json({ error: "This kind of file can't be shown in the browser, and downloading is switched off." });
    const file = await getFile(key);
    if (!file) return res.status(404).json({ error: "That document isn't here" });
    sendViewOnly(res, meta, file);
  })
);

// Earlier versions of a document (newest first), for those who see it.
app.get(
  "/api/documents/files/:id/versions",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const doc = docs.shape(await getDocuments());
    const f = doc.files.find((x) => x.id === req.params.id && !x.archived);
    if (!f || !docs.parseSpace(f.space) || !docSpaces(req.user).some((s) => s.id === f.space) || !docIn(req, doc, f.space, f.folder)) return res.status(404).json({ error: "That document isn't here" });
    res.json({ versions: f.versions.slice().reverse().map((v) => ({ id: v.id, at: v.at, by: v.by, size: v.size, type: v.type, name: v.name || f.name, preview: docs.canPreview(v.type) })), history: (f.history || []).slice(-50).reverse() });
  })
);

// ----- Changes (edit access needed; checked here on every request) -----
// Runs fn(doc) inside the documents queue; fn returns an error string to stop.
async function docChange(res, fn) {
  let problem = "", out = null;
  await withDocuments((doc) => {
    docs.shape(doc);
    const r = fn(doc);
    if (typeof r === "string") problem = r; else out = r;
  });
  if (problem) { res.status(/isn't here/.test(problem) ? 404 : /^You can/.test(problem) ? 403 : 400).json({ error: problem }); return null; }
  return out;
}
function docLog(f, by, what) {
  f.history = Array.isArray(f.history) ? f.history : [];
  f.history.push({ at: Date.now(), by, what });
  if (f.history.length > 200) f.history = f.history.slice(-200);
}
const NO_EDIT = "You can only view this folder. Use Request edit to ask IT for edit access.";

// Upload into a folder: ?space=…&folder=…&name=… (raw body). A live document
// with the same name in that folder gets this as its new version.
app.post(
  "/api/documents/files",
  authMiddleware,
  express.raw({ type: () => true, limit: DOC_MAX }),
  asyncHandler(async (req, res) => {
    const sp = docSpace(req, res, String(req.query.space || ""));
    if (!sp) return;
    if (sp.kind !== "dept") return res.status(403).json({ error: "Add board documents on the board's case file" });
    const { name, type } = boardFileMeta(req);
    if (!type) return res.status(400).json({ error: "Add a PDF, image, Word, Excel, PowerPoint, text or email file" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file came through" });
    const folderId = String(req.query.folder || "");
    const pre = docs.shape(await getDocuments());
    if (!docIn(req, pre, sp.id, folderId)) return res.status(404).json({ error: "That folder isn't here" });
    if (!docs.mayEdit(pre, req.user, sp.id, folderId, true)) return res.status(403).json({ error: NO_EDIT });
    const same = pre.files.find((f) => f.space === sp.id && (f.folder || "") === folderId && !f.archived && docs.sameName(f.name, name));
    const fileId = same ? same.id : newId();
    const v = { id: newId(), at: Date.now(), by: req.user.username, size: req.body.length, type, name };
    // Stored before it's listed, so a listed version always has its bytes.
    await putFile(`documents_files/${fileId}/${v.id}`, req.body, type);
    const out = await docChange(res, (doc) => {
      if (!docIn(req, doc, sp.id, folderId)) return "That folder isn't here";
      if (!docs.mayEdit(doc, req.user, sp.id, folderId, true)) return NO_EDIT;
      let f = doc.files.find((x) => x.id === fileId);
      if (!f) {
        f = { id: fileId, space: sp.id, folder: folderId, name, type, at: v.at, by: v.by, versions: [], history: [] };
        doc.files.push(f);
      }
      f.versions.push(v);
      f.type = type;
      docLog(f, req.user.username, f.versions.length > 1 ? `Uploaded version ${f.versions.length}` : "Added");
      return docFileOut(f);
    });
    if (out) res.status(201).json(out);
  })
);
// A new version of one document (keeps its name; earlier versions stay).
app.post(
  "/api/documents/files/:id/versions",
  authMiddleware,
  express.raw({ type: () => true, limit: DOC_MAX }),
  asyncHandler(async (req, res) => {
    const { name, type } = boardFileMeta(req);
    if (!type) return res.status(400).json({ error: "Add a PDF, image, Word, Excel, PowerPoint, text or email file" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file came through" });
    const pre = docs.shape(await getDocuments());
    const f0 = pre.files.find((x) => x.id === req.params.id && !x.archived);
    const seen = f0 && docSpaces(req.user).some((s) => s.id === f0.space) && docIn(req, pre, f0.space, f0.folder);
    if (!seen) return res.status(404).json({ error: "That document isn't here" });
    if (!docs.mayEdit(pre, req.user, f0.space, f0.folder, true)) return res.status(403).json({ error: NO_EDIT });
    const v = { id: newId(), at: Date.now(), by: req.user.username, size: req.body.length, type, name };
    await putFile(`documents_files/${f0.id}/${v.id}`, req.body, type);
    const out = await docChange(res, (doc) => {
      const f = doc.files.find((x) => x.id === f0.id && !x.archived);
      if (!f || !docIn(req, doc, f.space, f.folder)) return "That document isn't here";
      if (!docs.mayEdit(doc, req.user, f.space, f.folder, true)) return NO_EDIT;
      f.versions.push(v);
      f.type = type;
      docLog(f, req.user.username, `Uploaded version ${f.versions.length} (${name})`);
      return docFileOut(f);
    });
    if (out) res.status(201).json(out);
  })
);
// Rename and / or move a document within its space. Edit access is needed
// where it is and where it goes.
app.patch(
  "/api/documents/files/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const spaces = docSpaces(req.user);
    const out = await docChange(res, (doc) => {
      const f = doc.files.find((x) => x.id === req.params.id && !x.archived);
      if (!f || !spaces.some((s) => s.id === f.space) || !docIn(req, doc, f.space, f.folder)) return "That document isn't here";
      if (!docs.mayEdit(doc, req.user, f.space, f.folder, true)) return NO_EDIT;
      const to = "folder" in b ? String(b.folder || "") : f.folder || "";
      const name = "name" in b ? docs.cleanName(b.name) : f.name;
      if (!name) return "Give it a name";
      if (!docIn(req, doc, f.space, to)) return "That folder isn't here";
      if (!docs.mayEdit(doc, req.user, f.space, to, true)) return "You can't add to that folder. Use Request edit there first.";
      if (doc.files.some((x) => x !== f && x.space === f.space && (x.folder || "") === to && !x.archived && docs.sameName(x.name, name))) return `There's already a document called ${name} there`;
      if (to !== (f.folder || "")) docLog(f, req.user.username, `Moved from ${docs.pathLabel(doc, f.space, f.folder)} to ${docs.pathLabel(doc, f.space, to)}`);
      if (name !== f.name) docLog(f, req.user.username, `Renamed from ${f.name}`);
      f.folder = to; f.name = name;
      return docFileOut(f);
    });
    if (out) res.json(out);
  })
);
// Archive (hide) a document. It stays in S3; IT can restore it.
app.post(
  "/api/documents/files/:id/archive",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const spaces = docSpaces(req.user);
    const out = await docChange(res, (doc) => {
      const f = doc.files.find((x) => x.id === req.params.id && !x.archived);
      if (!f || !spaces.some((s) => s.id === f.space) || !docIn(req, doc, f.space, f.folder)) return "That document isn't here";
      if (!docs.mayEdit(doc, req.user, f.space, f.folder, true)) return NO_EDIT;
      Object.assign(f, { archived: true, archivedAt: Date.now(), archivedBy: req.user.username });
      docLog(f, req.user.username, "Archived");
      return { ok: true };
    });
    if (out) res.json(out);
  })
);

app.post(
  "/api/documents/folders",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const sp = docSpace(req, res, String(b.space || ""));
    if (!sp) return;
    if (sp.kind !== "dept") return res.status(403).json({ error: "Board folders come from the board" });
    const parent = String(b.parent || "");
    const name = docs.cleanName(b.name);
    if (!name) return res.status(400).json({ error: "Name the folder" });
    const out = await docChange(res, (doc) => {
      if (!docIn(req, doc, sp.id, parent)) return "That folder isn't here";
      if (!docs.mayEdit(doc, req.user, sp.id, parent, true)) return NO_EDIT;
      if (doc.folders.some((f) => f.space === sp.id && (f.parent || "") === parent && !f.archived && docs.sameName(f.name, name))) return `There's already a folder called ${name} there`;
      const f = { id: newId(), space: sp.id, parent, name, at: Date.now(), by: req.user.username };
      doc.folders.push(f);
      return { id: f.id, name: f.name, at: f.at, by: f.by };
    });
    if (out) res.status(201).json(out);
  })
);
// Rename and / or move a folder within its space (never into itself).
app.patch(
  "/api/documents/folders/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const spaces = docSpaces(req.user);
    const out = await docChange(res, (doc) => {
      const f = doc.folders.find((x) => x.id === req.params.id);
      if (!f || !spaces.some((s) => s.id === f.space) || !docIn(req, doc, f.space, f.id)) return "That folder isn't here";
      if (f.legal) return docs.LOCKED_FOLDER;
      // Changing a folder needs edit access where it sits, not just inside it.
      if (!docs.mayEdit(doc, req.user, f.space, f.parent, true)) return NO_EDIT;
      const to = "parent" in b ? String(b.parent || "") : f.parent || "";
      const name = "name" in b ? docs.cleanName(b.name) : f.name;
      if (!name) return "Name the folder";
      if (!docIn(req, doc, f.space, to) || docs.wouldLoop(doc, f, to)) return "It can't go there";
      if (!docs.mayEdit(doc, req.user, f.space, to, true)) return "You can't add to that folder. Use Request edit there first.";
      if (doc.folders.some((x) => x !== f && x.space === f.space && (x.parent || "") === to && !x.archived && docs.sameName(x.name, name))) return `There's already a folder called ${name} there`;
      f.parent = to; f.name = name;
      return { id: f.id, name: f.name };
    });
    if (out) res.json(out);
  })
);
app.post(
  "/api/documents/folders/:id/archive",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const spaces = docSpaces(req.user);
    const out = await docChange(res, (doc) => {
      const f = doc.folders.find((x) => x.id === req.params.id);
      if (!f || !spaces.some((s) => s.id === f.space) || !docIn(req, doc, f.space, f.id)) return "That folder isn't here";
      if (f.legal) return docs.LOCKED_FOLDER;
      if (!docs.mayEdit(doc, req.user, f.space, f.parent, true)) return NO_EDIT;
      Object.assign(f, { archived: true, archivedAt: Date.now(), archivedBy: req.user.username });
      return { ok: true };
    });
    if (out) res.json(out);
  })
);

// Add to…: copy a document you can see onto a board file's case file
// (Operations or US Gov, e.g. a quote) or a person's employment file
// (Leadership only). It's a copy — later versions here don't follow it —
// and both sides' history says where it came from and went. The target's
// own rules apply: you must be able to open that board file or People.
// Body: { space, folder, file, v?, target: "board" | "person", board, card, username }.
const DOC_ADD_PEOPLE_MAX = 10 * 1024 * 1024; // People's own upload limit
app.post(
  "/api/documents/add-to",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const src = await docSource(req, res, b);
    if (!src) return;
    const file = await getFile(src.key);
    if (!file) return res.status(404).json({ error: "That document isn't here" });
    const { name, type } = src.meta;
    const by = req.user.username;
    let label = "";
    if (b.target === "board") {
      const cfg = BOARDS[b.board];
      if (!cfg || !canSeeBoard(req.user, cfg)) return res.status(403).json({ error: "You can't add to that board" });
      const pre = ((await getBoard(cfg.store)).cards || []).find((c) => c.id === String(b.card || ""));
      if (!pre || !canSeeBoardCard(req.user, pre, cfg)) return res.status(404).json({ error: "That board file isn't here" });
      const meta = { id: newId(), name, type, size: file.body.length, at: Date.now(), by, kind: type.startsWith("image/") ? "picture" : type === "application/pdf" ? "pdf" : /outlook|rfc822/.test(type) ? "email" : "other", stage: pre.stage, fromDocuments: src.where };
      meta.key = await newBoardFileKey(cfg, pre.id, name);
      await putFile(meta.key, file.body, type);
      let gone = false;
      await withBoard((doc) => {
        const c = (doc.cards || []).find((x) => x.id === pre.id);
        if (!c || !canSeeBoardCard(req.user, c, cfg)) { gone = true; return; }
        c.files = c.files || [];
        c.files.push(meta);
        logCard(c, by, `Attached ${name} from Documents › ${src.where}`);
        label = `${cfg.name} › ${docBoardLabel(c)}`;
      }, cfg.store);
      if (gone) return res.status(404).json({ error: "That board file isn't here" });
    } else if (b.target === "project") {
      const all = await getTasks();
      const pre = all.find((t) => t.id === String(b.project || ""));
      if (!pre || !bdProject(pre) || !maySeeProject(req.user, pre, all)) return res.status(404).json({ error: "That project isn't here" });
      const meta = { id: newId(), name, type, size: file.body.length, at: Date.now(), by, fromDocuments: src.where };
      await putFile(`task_files/${pre.id}/${meta.id}`, file.body, type);
      let gone = false;
      await withTasks((tasks) => {
        const t = tasks.find((x) => x.id === pre.id);
        if (!t || !bdProject(t)) { gone = true; return; }
        t.files = Array.isArray(t.files) ? t.files : [];
        t.files.push(meta);
        label = `Business Development › ${t.title || "project"}`;
      });
      if (gone) return res.status(404).json({ error: "That project isn't here" });
    } else if (b.target === "person") {
      if (!employment.isLeadership(req.user)) return res.status(403).json({ error: "People is for Leadership only" });
      const login = await personLogin(String(b.username || ""));
      if (!login) return res.status(404).json({ error: "No login by that name" });
      if (file.body.length > DOC_ADD_PEOPLE_MAX) return res.status(400).json({ error: "Employment files take documents up to 10 MB" });
      const meta = { id: newId(), name, type, size: file.body.length, at: Date.now(), by, fromDocuments: src.where };
      const folder = await withPeople((doc) => employment.fileOf(employment.peopleShape(doc), login.username, newId).id);
      await putFile(`people_files/${folder}/${meta.id}`, file.body, type);
      await withPeople((doc) => {
        const f = employment.fileOf(employment.peopleShape(doc), login.username, newId);
        f.files.push(meta);
        peopleLog(f, by, `Added ${name} from Documents`);
      });
      label = `${login.username}'s employment file`;
    } else {
      return res.status(400).json({ error: "Add it to a board file, a project or a person's file" });
    }
    // The document's own history (department folders; never names the person's file).
    if (src.docFile) {
      const note = b.target === "person" ? "Copied to an employment file (People)" : `Copied to ${label}`;
      await withDocuments((doc) => { const f = docs.shape(doc).files.find((x) => x.id === src.docFile.id); if (f) docLog(f, by, note); });
    }
    res.status(201).json({ ok: true, to: label });
  })
);

// Business Development projects (top-level, not quick tasks) can hold
// copies of documents too, under task_files/<task id>/<file id>. They're
// seen by whoever sees the project on Business Development → Projects:
// managers in the department, the person responsible and who added it, and
// whoever has one of its sub-tasks.
function bdProject(t) {
  return t.department === "Business Development" && !t.parentId && t.kind !== "task" && t.source !== "form";
}
function maySeeProject(u, t, tasks) {
  if (!canTouch(u, t)) return false;
  return canSee(u, t) || tasks.some((s) => s.parentId === t.id && canSee(u, s));
}
app.get(
  "/api/documents/projects",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const tasks = await getTasks();
    res.json({ projects: tasks.filter((t) => bdProject(t) && maySeeProject(req.user, t, tasks)).map((t) => ({
      id: t.id, title: t.title || "", owner: t.owner || "", dueDate: t.dueDate || "", done: t.status === "done", company: taskCompany(t), files: (t.files || []).length,
    })) });
  })
);
// A project's document, shown in the Documents viewer (same rules as there:
// inline, PDFs / pictures / text only, never as a download).
app.get(
  "/api/tasks/:id/files/:fid/view",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const tasks = await getTasks();
    const t = tasks.find((x) => x.id === req.params.id);
    const meta = t && maySeeProject(req.user, t, tasks) && (t.files || []).find((f) => f.id === req.params.fid);
    if (!meta) return res.status(404).json({ error: "That document isn't here" });
    const file = await getFile(`task_files/${t.id}/${meta.id}`);
    if (!file) return res.status(404).json({ error: "That document isn't here" });
    sendViewOnly(res, meta, file);
  })
);
// Take a document off a project (whoever may edit the project). Only this
// copy goes; the original stays in Documents.
app.delete(
  "/api/tasks/:id/files/:fid",
  authMiddleware,
  asyncHandler(async (req, res) => {
    let problem = "", gone = null;
    await withTasks((tasks) => {
      const t = tasks.find((x) => x.id === req.params.id);
      if (!t || !maySeeProject(req.user, t, tasks)) { problem = "404"; return; }
      if (!canEdit(req.user, t)) { problem = "403"; return; }
      gone = (t.files || []).find((f) => f.id === req.params.fid);
      if (!gone) { problem = "404"; return; }
      t.files = t.files.filter((f) => f !== gone);
    });
    if (problem === "404") return res.status(404).json({ error: "That document isn't here" });
    if (problem === "403") return res.status(403).json({ error: "Only someone who can edit this project can remove its documents" });
    await deleteFile(`task_files/${req.params.id}/${gone.id}`);
    res.status(204).end();
  })
);

// ----- Request edit → IT ticket → grant -----
// Raises an IT ticket (on IT → Requests and your "What you've sent") naming
// the folder. One open request per folder.
app.post(
  "/api/documents/request-edit",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const sp = docSpace(req, res, String(b.space || ""));
    if (!sp) return;
    if (sp.kind !== "dept") return res.status(400).json({ error: "Board documents are changed on the board itself" });
    const folder = String(b.folder || "");
    const doc = docs.shape(await getDocuments());
    if (!docIn(req, doc, sp.id, folder)) return res.status(404).json({ error: "That folder isn't here" });
    if (docs.mayEdit(doc, req.user, sp.id, folder, true)) return res.status(400).json({ error: "You can already edit this folder" });
    const reason = forms.text(b.reason, 500);
    if (!reason) return res.status(400).json({ error: "Say briefly what you need to change" });
    const where = docs.pathLabel(doc, sp.id, folder);
    const login = (await getUsers()).find((u) => sameUser(u.username, req.user.username)) || {};
    let out = null;
    await withItRequests((list) => {
      const open = docOpenRequest(list, doc, req.user, sp.id, folder);
      if (open) { out = { ref: ticketRef(open.id), at: open.addedAt, already: true }; return; }
      const rec = {
        id: "manual-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), formId: null, source: "staff",
        submittedAt: officeStamp(new Date().toISOString()),
        name: req.user.username, email: String(login.email || "").trim().toLowerCase().slice(0, 120),
        phone: "", company: COMPANY_ENTITY[sp.company] || "SOI", remote: "",
        issue: `Edit access to Documents › ${where}: ${reason}`, startedOn: "",
        urgency: "Normal", contact: "", notes: "",
        priority: "", status: "new", taskId: "", addedAt: Date.now(), addedBy: req.user.username,
        docEdit: { space: sp.id, folder, where },
      };
      list.push(rec);
      out = { ref: ticketRef(rec.id), at: rec.addedAt };
    });
    res.status(out.already ? 200 : 201).json(out);
  })
);

// IT's view: open edit requests, live and recent grants, archived items.
const docAdminOnly = (req, res, next) => (docs.grantsAdmin(req.user) ? next() : res.status(403).json({ error: "Edit access is handled by the document editors and IT" }));
// Edit a document in Word (or anything else): the editors and anyone with
// edit access download the latest version, then upload it back with "New
// version". Everyone else only views documents in the page.
app.get(
  "/api/documents/download",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const src = await docSource(req, res, req.query);
    if (!src) return;
    const doc = docs.shape(await getDocuments());
    const f = doc.files.find((x) => x.id === String(req.query.file || ""));
    if (!f || !docs.mayEdit(doc, req.user, f.space, f.folder || "", true)) return res.status(403).json({ error: "Ask to edit this folder first" });
    const file = await getFile(src.key);
    if (!file) return res.status(404).json({ error: "That document isn't here" });
    res.set({ "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${String(f.name).replace(/[^\w .()-]+/g, "_")}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    res.send(file.body);
  })
);
app.get(
  "/api/documents/access",
  authMiddleware,
  docAdminOnly,
  asyncHandler(async (req, res) => {
    const [doc, list] = await Promise.all([getDocuments().then(docs.shape), getItRequests()]);
    const now = Date.now();
    res.json({
      requests: list.filter(docEditOpen).map((r) => ({
        id: r.id, ref: ticketRef(r.id), by: r.addedBy, at: r.addedAt, where: docs.pathLabel(doc, r.docEdit.space, r.docEdit.folder), issue: r.issue,
        gone: !docIn(req, doc, r.docEdit.space, r.docEdit.folder),
      })).sort((a, b) => a.at - b.at),
      grants: doc.grants.filter((g) => docs.grantLive(g, now) || (g.revokedAt || g.until || 0) > now - 30 * 24 * 3600 * 1000)
        .map((g) => ({ id: g.id, user: g.user, where: docs.pathLabel(doc, g.space, g.folder), until: g.until || null, by: g.by, at: g.at, ref: g.ticket ? ticketRef(g.ticket) : "", live: docs.grantLive(g, now), revokedAt: g.revokedAt || null, revokedBy: g.revokedBy || "" }))
        .sort((a, b) => b.at - a.at),
      archived: doc.files.filter((f) => f.archived).map((f) => ({ kind: "file", id: f.id, name: f.name, where: docs.pathLabel(doc, f.space, f.folder), at: f.archivedAt, by: f.archivedBy }))
        .concat(doc.folders.filter((f) => f.archived).map((f) => ({ kind: "folder", id: f.id, name: f.name, where: docs.pathLabel(doc, f.space, f.parent), at: f.archivedAt, by: f.archivedBy })))
        .sort((a, b) => b.at - a.at).slice(0, 200),
      grantDays: docs.GRANT_DAYS,
    });
  })
);
// Grant (or decline) a request. The grant covers the folder and everything
// under it until the end date ("" = no expiry; left out = 30 days). Nobody
// grants themselves.
app.post(
  "/api/documents/requests/:id/decide",
  authMiddleware,
  docAdminOnly,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const grant = b.decision === "grant";
    if (!grant && b.decision !== "decline") return res.status(400).json({ error: "Grant or decline?" });
    const r0 = (await getItRequests()).find((x) => x.id === req.params.id && x.docEdit);
    if (!r0 || !docEditOpen(r0)) return res.status(404).json({ error: "That request isn't open" });
    if (sameUser(r0.addedBy, req.user.username)) return res.status(403).json({ error: "Someone else in IT has to decide your own request" });
    const u = await getUsers().then((list) => list.find((x) => sameUser(x.username, r0.addedBy)));
    const until = grant ? docs.grantUntil(b.until) : { until: null };
    if (until.error) return res.status(400).json({ error: until.error });
    const reason = forms.text(b.reason, 300);
    if (!grant && !reason) return res.status(400).json({ error: "Say why, for the requester" });
    let g = null;
    if (grant) {
      if (!u || !docSpaces(normalizeUser(u)).some((s) => s.id === r0.docEdit.space)) return res.status(400).json({ error: "That login can't see this folder any more" });
      g = await docChange(res, (doc) => {
        if (!docIn(req, doc, r0.docEdit.space, r0.docEdit.folder)) return "That folder isn't here";
        const x = { id: newId(), user: u.username, space: r0.docEdit.space, folder: r0.docEdit.folder || "", until: until.until, by: req.user.username, at: Date.now(), ticket: r0.id };
        doc.grants.push(x);
        return Object.assign({ where: docs.pathLabel(doc, x.space, x.folder) }, x);
      });
      if (!g) return;
    }
    const when = (ms) => new Date(ms).toISOString().slice(0, 10);
    await withItRequests((list) => {
      const r = list.find((x) => x.id === r0.id);
      if (!r) return;
      Object.assign(r.docEdit, { decidedAt: Date.now(), decidedBy: req.user.username, decision: grant ? "granted" : "declined", grantId: g ? g.id : "" });
      pushActivity(r, { type: "note", by: req.user.username, text: grant
        ? `Edit access granted to Documents › ${g.where} ${g.until ? "until " + when(g.until) : "with no end date"}${reason ? ": " + reason : ""}`
        : `Edit access declined: ${reason}` });
      r.status = "done";
      pushActivity(r, { type: "status", text: "Resolved", by: req.user.username });
    });
    res.json({ ok: true, grant: g });
  })
);
app.post(
  "/api/documents/grants/:id/revoke",
  authMiddleware,
  docAdminOnly,
  asyncHandler(async (req, res) => {
    const out = await docChange(res, (doc) => {
      const g = doc.grants.find((x) => x.id === req.params.id);
      if (!g || !docs.grantLive(g, Date.now())) return "That grant isn't here";
      Object.assign(g, { revokedAt: Date.now(), revokedBy: req.user.username });
      return { ok: true, ticket: g.ticket || "", where: docs.pathLabel(doc, g.space, g.folder) };
    });
    if (!out) return;
    if (out.ticket) await withItRequests((list) => { const r = list.find((x) => x.id === out.ticket); if (r) pushActivity(r, { type: "note", by: req.user.username, text: `Edit access to Documents › ${out.where} revoked` }); });
    res.json({ ok: true });
  })
);
// Bring back an archived document or folder (IT and full access).
app.post(
  "/api/documents/restore",
  authMiddleware,
  docAdminOnly,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const out = await docChange(res, (doc) => {
      const list = b.kind === "folder" ? doc.folders : doc.files;
      const x = list.find((y) => y.id === String(b.id || "") && y.archived);
      if (!x) return "That isn't here";
      const parent = b.kind === "folder" ? x.parent : x.folder;
      if (!docIn(req, doc, x.space, parent)) return "Restore the folder it was in first";
      const clash = list.some((y) => y !== x && y.space === x.space && !y.archived && (b.kind === "folder" ? (y.parent || "") === (parent || "") : (y.folder || "") === (parent || "")) && docs.sameName(y.name, x.name));
      if (clash) return `Something called ${x.name} is already there — rename that first`;
      delete x.archived; delete x.archivedAt; delete x.archivedBy;
      if (b.kind !== "folder") docLog(x, req.user.username, "Restored");
      return { ok: true };
    });
    if (out) res.json(out);
  })
);

// ---------- Legal ----------
// Administration → Legal (rules in legal.js): one tab per section, listing
// the documents in that section's Documents folder (and its subfolders)
// with an expiry date, notes and a person responsible typed in here.
// Leadership plus the named staff only, checked on every route.
const legalOnly = asyncHandler(async (req, res, next) => {
  if (legal.hasLegal(req.user, await freshLegal())) return next();
  res.status(403).json({ error: "Legal is for Leadership and the people they add" });
});
const officeToday = () => officeStamp(new Date().toISOString()).slice(0, 10);

// The section folders, made the first time Legal is opened: a "Legal" space
// per company in Documents with one folder per section (US Government
// Contracts under SOI Aviation only). A folder already there with the same
// name is taken over rather than duplicated.
async function legalFolders() {
  const want = [];
  for (const company of COMPANIES) for (const s of legal.sectionsFor(company)) want.push({ space: docs.deptSpaceId(company, legal.LEGAL), company, s });
  const missing = (doc) => want.filter((w) => !doc.folders.some((f) => f.space === w.space && f.legal === w.s.id && !f.archived));
  let doc = docs.shape(await getDocuments());
  if (missing(doc).length) {
    await withDocuments((d) => {
      docs.shape(d);
      for (const w of missing(d)) {
        const same = d.folders.find((f) => f.space === w.space && !f.parent && !f.archived && docs.sameName(f.name, w.s.label));
        if (same) same.legal = w.s.id;
        else d.folders.push({ id: newId(), space: w.space, parent: "", name: w.s.label, at: Date.now(), by: "tracker", legal: w.s.id });
      }
    });
    doc = docs.shape(await getDocuments());
  }
  return { doc, sections: want.map((w) => Object.assign({ folder: doc.folders.find((f) => f.space === w.space && f.legal === w.s.id && !f.archived) }, w)) };
}
// Who's responsible: whoever was picked, else whoever added the document.
function legalOwner(rec, f) {
  return rec && "owner" in rec ? rec.owner : (f.versions[0] || {}).by || f.by || "";
}
// Every Legal document this login sees, with its record and status.
async function legalRows(u) {
  const [{ doc, sections }, ldoc] = await Promise.all([legalFolders(), freshLegal()]);
  const today = officeToday();
  const rows = [];
  for (const sec of sections) {
    if (!sec.folder || !(u.companies || []).includes(sec.company) || !legal.hasSection(u, ldoc, sec.s.id)) continue;
    for (const f of doc.files) {
      if (f.space !== sec.space || f.archived || !docs.folderIn(doc, f.space, f.folder)) continue;
      const up = docs.chain(doc, f.folder);
      const at = up.findIndex((x) => x.id === sec.folder.id);
      if (at === -1) continue;
      const rec = ldoc.records[f.id] || {};
      const v = f.versions[f.versions.length - 1] || {};
      rows.push({
        id: f.id, section: sec.s.id, company: sec.company, space: f.space, folder: f.folder || "",
        name: f.name, type: v.type || f.type, at: v.at || f.at, by: v.by || f.by,
        path: up.slice(0, at).reverse().map((x) => x.name).join(" › "),
        expiry: rec.expiry || "", notes: rec.notes || "", owner: legalOwner(rec, f),
        status: legal.status(rec.expiry, today), daysLeft: legal.daysLeft(rec.expiry, today), updatedBy: rec.by || "", updatedAt: rec.at || 0,
      });
    }
  }
  return { rows, sections, doc, today };
}

app.get(
  "/api/legal",
  authMiddleware,
  legalOnly,
  asyncHandler(async (req, res) => {
    const { rows, sections, doc, today } = await legalRows(req.user);
    const ldoc = await freshLegal();
    const logins = (await getUsers()).map(normalizeUser);
    // People who can be responsible: anyone with Legal sharing a company.
    const people = logins.filter((u) => legal.hasLegal(u, ldoc) && u.companies.some((c) => req.user.companies.includes(c))).map((u) => u.username).sort((a, b) => a.localeCompare(b));
    res.json({
      today, soonDays: legal.SOON_DAYS, rows, people,
      sections: sections.filter((s) => s.folder && req.user.companies.includes(s.company) && legal.hasSection(req.user, ldoc, s.s.id)).map((s) => ({
        id: s.s.id, label: s.s.label, company: s.company, space: s.space, folder: s.folder.id,
        canEdit: docs.mayEdit(doc, req.user, s.space, s.folder.id, true),
      })),
      // Leadership manages the named staff and their sections.
      members: req.user.leadership ? ldoc.members : undefined,
      access: req.user.leadership ? ldoc.access : undefined,
      allSections: req.user.leadership ? legal.SECTIONS.map((x) => ({ id: x.id, label: x.label })) : undefined,
      logins: req.user.leadership ? logins.filter((u) => !u.leadership).map((u) => u.username).sort((a, b) => a.localeCompare(b)) : undefined,
    });
  })
);
// Expiry date, notes and person responsible for one Legal document.
app.put(
  "/api/legal/records/:id",
  authMiddleware,
  legalOnly,
  asyncHandler(async (req, res) => {
    const { rows } = await legalRows(req.user);
    const row = rows.find((r) => r.id === req.params.id);
    if (!row) return res.status(404).json({ error: "That document isn't in Legal" });
    const { out, error } = legal.cleanRecord(req.body || {});
    if (error) return res.status(400).json({ error });
    if (out.owner) {
      const ldoc = await freshLegal();
      const who = (await getUsers()).map(normalizeUser).find((u) => sameUser(u.username, out.owner));
      if (!who || !legal.hasSection(who, ldoc, row.section)) return res.status(400).json({ error: "The person responsible needs access to this Legal section" });
      out.owner = who.username;
    }
    const doc = await withLegal((d) => {
      legal.shape(d);
      d.records[row.id] = Object.assign({}, d.records[row.id], out, { by: req.user.username, at: Date.now() });
      return d;
    });
    legalSnap = { at: Date.now(), doc: legal.shape(doc) };
    const rec = doc.records[row.id], today = officeToday();
    res.json(Object.assign(row, { expiry: rec.expiry || "", notes: rec.notes || "", owner: "owner" in rec ? rec.owner : row.owner,
      status: legal.status(rec.expiry, today), daysLeft: legal.daysLeft(rec.expiry, today), updatedBy: rec.by, updatedAt: rec.at }));
  })
);
// The named staff (Leadership has Legal already). Leadership only.
app.put(
  "/api/legal/members",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!req.user.leadership) return res.status(403).json({ error: "Only Leadership adds or removes people on Legal" });
    const want = Array.isArray((req.body || {}).members) ? req.body.members : null;
    if (!want) return res.status(400).json({ error: "Send the list of people" });
    const logins = (await getUsers()).map(normalizeUser);
    const members = [];
    for (const m of want) {
      const u = logins.find((x) => sameUser(x.username, m));
      if (!u) return res.status(400).json({ error: `No login called ${String(m).slice(0, 60)}` });
      if (!members.includes(u.username)) members.push(u.username);
    }
    const doc = await withLegal((d) => {
      legal.shape(d);
      const next = {};
      for (const m of members) next[m] = (Object.entries(d.access).find(([k]) => sameUser(k, m)) || [])[1] || legal.SECTION_IDS.slice();
      d.access = next; d.members = members; d.membersBy = req.user.username; d.membersAt = Date.now();
      return d;
    });
    legalSnap = { at: Date.now(), doc: legal.shape(doc) };
    res.json({ members, access: legalSnap.doc.access });
  })
);
// Which sections each named person sees: { access: { username: [ids] } }.
// Leadership only; anyone left with no section is off Legal.
app.put(
  "/api/legal/access",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!req.user.leadership) return res.status(403).json({ error: "Only Leadership changes who sees Legal" });
    const want = legal.cleanAccess((req.body || {}).access);
    const logins = (await getUsers()).map(normalizeUser), access = {};
    for (const [m, ids] of Object.entries(want)) {
      const u = logins.find((x) => sameUser(x.username, m));
      if (!u) return res.status(400).json({ error: `No login called ${String(m).slice(0, 60)}` });
      if (!u.leadership) access[u.username] = ids;
    }
    const doc = await withLegal((d) => { legal.shape(d); d.access = access; d.members = Object.keys(access); d.membersBy = req.user.username; d.membersAt = Date.now(); return d; });
    legalSnap = { at: Date.now(), doc: legal.shape(doc) };
    res.json({ members: legalSnap.doc.members, access: legalSnap.doc.access });
  })
);
// Mentions of You: Legal documents you're responsible for that expire
// within 60 days or already have. Nothing for logins without Legal.
app.get(
  "/api/legal/mine",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!legal.hasLegal(req.user, await freshLegal())) return res.json({ items: [] });
    const { rows } = await legalRows(req.user);
    const label = Object.fromEntries(legal.SECTIONS.map((s) => [s.id, s.label]));
    res.json({ items: rows.filter((r) => sameUser(r.owner, req.user.username) && (r.status === "soon" || r.status === "expired"))
      .map((r) => ({ id: r.id, name: r.name, section: r.section, sectionLabel: label[r.section], company: r.company, expiry: r.expiry, daysLeft: r.daysLeft, status: r.status }))
      .sort((a, b) => a.daysLeft - b.daysLeft) });
  })
);

// ---------- Strategy Meeting ----------
// Company → Strategy Meeting (rules in strategy.js): one table of topics,
// each with a date to discuss it, an owner, a status and a running log of
// notes and decisions. Leadership only on every route. A note assigned to
// someone becomes a task for them (so it shows on their Mentions of You),
// like a board file's next step.
function strategyOnly(req, res, next) {
  if (req.user.leadership) return next();
  res.status(403).json({ error: "The Strategy Meeting is for Leadership logins" });
}
async function strategyLogins() {
  return (await getUsers()).map(normalizeUser);
}
const loginFinder = (logins) => (v) => (logins.find((u) => sameUser(u.username, v)) || {}).username || "";
const strategyRow = (t) => Object.assign({ owner: "", discussOn: "", status: "open", log: [] }, t);

app.get(
  "/api/strategy",
  authMiddleware,
  strategyOnly,
  asyncHandler(async (req, res) => {
    const [doc, logins, tasks] = await Promise.all([getStrategy(), strategyLogins(), getTasks()]);
    strategy.shape(doc);
    // Assigned notes show whether their task is done yet.
    const taskDone = Object.fromEntries(tasks.filter((t) => t.strategy).map((t) => [t.id, t.status === "done"]));
    const topics = doc.topics.map(strategyRow).map((t) => Object.assign({}, t, { log: t.log.map((e) => (e.taskId ? Object.assign({}, e, { taskDone: !!taskDone[e.taskId], taskGone: !(e.taskId in taskDone) }) : e)) }));
    const today = officeToday(), settings = await getSettings();
    const dates = strategy.meetingDates(doc, settings, today);
    res.json({ topics, today, dates, nextDate: strategy.nextDate(doc, today, dates), people: strategy.people(settings, logins),
      logins: logins.map((u) => u.username).sort((a, b) => a.localeCompare(b)) });
  })
);
// Mentions of You: open Strategy Meeting topics you own. Any login (only
// their own rows come back); notes assigned to you already arrive as tasks.
app.get(
  "/api/strategy/mine",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const doc = strategy.shape(await getStrategy());
    res.json({ items: doc.topics.filter((t) => sameUser(t.owner, req.user.username) && t.status !== "closed")
      .map((t) => ({ id: t.id, topic: t.topic, discussOn: t.discussOn || "", status: t.status }))
      .sort((a, b) => (a.discussOn || "9999").localeCompare(b.discussOn || "9999")) });
  })
);
// A new row, optionally with its first note.
app.post(
  "/api/strategy/topics",
  authMiddleware,
  strategyOnly,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const isLogin = loginFinder(await strategyLogins());
    const { out, error } = strategy.cleanTopic(Object.assign({ topic: "" }, b, { status: "open" }), isLogin);
    if (error) return res.status(400).json({ error });
    const note = String(b.note == null ? "" : b.note).trim().slice(0, 4000);
    const row = Object.assign({ id: newId(), owner: "", discussOn: "", raisedBy: req.user.username, at: Date.now(), log: [] }, out);
    if (note) row.log.push({ id: newId(), kind: "note", text: note, by: req.user.username, at: Date.now() });
    await withStrategy((doc) => { strategy.shape(doc).topics.push(row); });
    res.status(201).json(row);
  })
);
app.patch(
  "/api/strategy/topics/:id",
  authMiddleware,
  strategyOnly,
  asyncHandler(async (req, res) => {
    const isLogin = loginFinder(await strategyLogins());
    const { out, error } = strategy.cleanTopic(req.body || {}, isLogin);
    if (error) return res.status(400).json({ error });
    const row = await withStrategy((doc) => {
      const t = strategy.shape(doc).topics.find((x) => x.id === req.params.id);
      if (!t) return null;
      Object.assign(t, out, { updatedBy: req.user.username, updatedAt: Date.now() });
      return strategyRow(t);
    });
    if (!row) return res.status(404).json({ error: "That row isn't here any more" });
    res.json(row);
  })
);
app.delete(
  "/api/strategy/topics/:id",
  authMiddleware,
  strategyOnly,
  asyncHandler(async (req, res) => {
    const ok = await withStrategy((doc) => {
      const list = strategy.shape(doc).topics;
      const i = list.findIndex((x) => x.id === req.params.id);
      if (i === -1) return false;
      list.splice(i, 1);
      return true;
    });
    if (!ok) return res.status(404).json({ error: "That row isn't here any more" });
    res.status(204).end();
  })
);
// Add to a row's running log: a note or a decision, optionally for someone
// with a due date — that becomes a task for them in their first company and
// department (Mentions of You, and that department's Tasks).
app.post(
  "/api/strategy/topics/:id/log",
  authMiddleware,
  strategyOnly,
  asyncHandler(async (req, res) => {
    const logins = await strategyLogins();
    const { out, error } = strategy.cleanEntry(req.body || {}, loginFinder(logins));
    if (error) return res.status(400).json({ error });
    let task = null;
    const row = await withStrategy((doc) => {
      const t = strategy.shape(doc).topics.find((x) => x.id === req.params.id);
      if (!t) return null;
      const e = Object.assign({ id: newId(), by: req.user.username, at: Date.now() }, out);
      if (out.for) {
        const who = logins.find((u) => u.username === out.for);
        task = { id: newId(), title: `Strategy Meeting: ${t.topic}: ${out.text.split("\n")[0]}`.slice(0, 200), company: who.companies[0] || DEFAULT_COMPANY,
          department: who.departments[0] || "", status: "todo", priority: out.due ? "high" : "medium", owner: who.username, dueDate: out.due || "",
          notes: `From the Strategy Meeting (${t.topic}), by ${req.user.username}:\n${out.text}`, createdAt: Date.now(), createdBy: req.user.username, kind: "task", strategy: t.id };
        e.taskId = task.id;
      }
      t.log = Array.isArray(t.log) ? t.log : [];
      t.log.push(e);
      if (e.kind === "decision" && (t.status || "open") === "open") t.status = "decided";
      t.updatedBy = req.user.username; t.updatedAt = Date.now();
      return strategyRow(t);
    });
    if (!row) return res.status(404).json({ error: "That row isn't here any more" });
    if (task) {
      await withTasks((tasks) => { tasks.unshift(task); });
      notifyOwner(task).catch(() => {});
      row.log = row.log.map((e) => (e.taskId === task.id ? Object.assign({}, e, { taskDone: false }) : e));
    }
    res.status(201).json(row);
  })
);

// ---------- Chat with AOG ----------
// One Claude chat for the company (chat.js), on Bedrock (bedrock.js). Every
// tool runs as the signed-in person: reads and changes go through the
// tracker's own routes on this server with their sign-in (chatCall), so the
// chat can never see or do more than they can. Changes say "via Chat with
// AOG" on the file. Each person's chats are kept; IT and full access can
// open anyone's.
function chatCall(req, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = https.request({ host: "127.0.0.1", port: PORT, method, path: url, rejectUnauthorized: false,
      headers: Object.assign({ Authorization: req.headers.authorization || "" }, data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks), type = String(res.headers["content-type"] || "");
        let json = null;
        if (type.includes("json")) { try { json = JSON.parse(buf.toString("utf8")); } catch (e) { /* not JSON */ } }
        resolve({ status: res.statusCode, type, buf, json });
      });
    });
    r.on("error", reject);
    r.setTimeout(60000, () => r.destroy(new Error("The tracker took too long to answer")));
    if (data) r.write(data);
    r.end();
  });
}
const callError = (r) => (r.json && r.json.error) || `The tracker answered ${r.status}`;
// ILS (ilsmart.com) needs SOI's ILS API subscription; there's no connection
// yet, so search_ils says so and the chat records pasted results instead.
const ILS_CONNECTED = false;

function chatTools(req) {
  const boards = {};
  async function boardList(id) {
    if (!boards[id]) {
      if (!canSeeBoard(req.user, BOARDS[id])) boards[id] = [];
      else {
        const r = await chatCall(req, "GET", `/api/board?board=${id}`);
        boards[id] = r.status === 200 && r.json ? r.json.cards || [] : [];
      }
    }
    return boards[id];
  }
  async function findCard(b, id) {
    if (!BOARDS[b]) return null;
    return (await boardList(b)).find((c) => c.id === id) || null;
  }
  // A Pentagon document not yet on the board is stored before it's changed.
  async function storedId(b, id) {
    if (!String(id).startsWith("pg:")) return id;
    const r = await chatCall(req, "POST", `/api/board/adopt?board=${b}`, { id });
    if (r.status >= 300) throw new Error(callError(r));
    delete boards[b];
    return r.json.id;
  }
  const VIA = `\n— via Chat with AOG for ${req.user.username}`;
  const run = {
    async find_files({ query }) {
      const out = [];
      for (const b of ["ops", "usgov"]) for (const c of chat.matchCards(await boardList(b), query)) out.push(chat.cardBrief(c, b));
      return { result: out.length ? { files: out.slice(0, 15) } : `No board file you can see matches "${query}".` };
    },
    async get_file({ board: b, id }) {
      const c = await findCard(b, id);
      if (!c) return { result: "That file isn't there, or you can't see it." };
      return { result: chat.cardDetail(c, b, `board:${b}`) };
    },
    async search_documents({ query }) {
      await freshLegal();
      const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return { result: "Say what to look for." };
      const hit = (s) => words.every((w) => s.toLowerCase().includes(w));
      const spaces = docSpaces(req.user), doc = docs.shape(await getDocuments()), out = [];
      for (const sp of spaces.filter((s) => s.kind !== "board")) {
        for (const f of doc.files.filter((x) => x.space === sp.id && !x.archived && docIn(req, doc, sp.id, x.folder || ""))) {
          const where = docs.pathLabel(doc, sp.id, f.folder || "");
          if (hit(`${f.name} ${where}`)) out.push({ name: f.name, where, ref: { space: sp.id, folder: f.folder || "", file: f.id } });
        }
      }
      for (const b of ["ops", "usgov"]) for (const c of await boardList(b)) for (const f of c.files || []) {
        const where = `${BOARDS[b].name} › ${chat.cardLabel(c)}`;
        if (!c.virtual && hit(`${f.name} ${where}`)) out.push({ name: f.name, where, ref: { space: `board:${b}`, folder: c.id, file: f.id } });
      }
      return { result: out.length ? { documents: out.slice(0, 20), more: Math.max(0, out.length - 20) } : `No document you can see matches "${query}".` };
    },
    async read_document({ ref }) {
      const q = new URLSearchParams({ space: ref.space || "", folder: ref.folder || "", file: ref.file || "" });
      const r = await chatCall(req, "GET", `/api/documents/view?${q}`);
      if (r.status !== 200) return { result: callError(r) };
      const type = r.type.split(";")[0].trim();
      if (type.startsWith("text/")) return { result: r.buf.toString("utf8").slice(0, 50000) };
      const data = r.buf.toString("base64");
      if (type === "application/pdf") {
        if (r.buf.length > 10 * 1024 * 1024) return { result: "That PDF is too large to read here (over 10 MB)." };
        return { result: "The PDF follows this message.", extra: { type: "document", source: { type: "base64", media_type: type, data } } };
      }
      if (/^image\/(png|jpeg|gif|webp)$/.test(type)) {
        if (r.buf.length > 3.5 * 1024 * 1024) return { result: "That picture is too large to read here (over 3.5 MB)." };
        return { result: "The picture follows this message.", extra: { type: "image", source: { type: "base64", media_type: type, data } } };
      }
      return { result: "That kind of file can't be read here." };
    },
    async add_note_to_file({ board: b, id, text }) {
      const t = chat.text(text, 3800);
      if (!t) return { result: "The note is empty." };
      const c = await findCard(b, id);
      if (!c) return { result: "That file isn't there, or you can't see it." };
      const sid = await storedId(b, id);
      const r = await chatCall(req, "POST", `/api/board/${encodeURIComponent(sid)}/notes?board=${b}`, { text: t + VIA });
      if (r.status >= 300) return { result: `Not added: ${callError(r)}` };
      return { result: `Note added to ${chat.cardLabel(c)}.`, action: `Added a note to ${chat.cardLabel(c)}` };
    },
    async attach_document_to_file({ board: b, id, ref }) {
      const c = await findCard(b, id);
      if (!c) return { result: "That file isn't there, or you can't see it." };
      const sid = await storedId(b, id);
      const r = await chatCall(req, "POST", "/api/documents/add-to", { space: ref.space, folder: ref.folder || "", file: ref.file, target: "board", board: b, card: sid });
      if (r.status >= 300) return { result: `Not attached: ${callError(r)}` };
      return { result: `Attached to ${r.json.to}.`, action: `Attached a document to ${chat.cardLabel(c)}` };
    },
    async search_ils() {
      if (!ILS_CONNECTED) return { result: "ILS isn't connected to the tracker yet (it needs SOI's ILS API access). Ask the person to search ilsmart.com and paste the results here; you can then record them on the file with add_ils_results_to_file." };
      return { result: "ILS isn't connected." };
    },
    async add_ils_results_to_file({ board: b, id, part_number: pn, results }) {
      const t = chat.text(results, 3800);
      if (!t) return { result: "There are no ILS results to add." };
      const c = await findCard(b, id);
      if (!c) return { result: "That file isn't there, or you can't see it." };
      const sid = await storedId(b, id);
      const title = `ILS results${pn ? " for " + chat.text(pn, 60) : ""}`;
      const r = await chatCall(req, "POST", `/api/board/${encodeURIComponent(sid)}/links?board=${b}`, { kind: "website", url: "https://www.ilsmart.com", title, text: t + VIA });
      if (r.status >= 300) return { result: `Not added: ${callError(r)}` };
      const k = await chatCall(req, "PATCH", `/api/board/${encodeURIComponent(sid)}?board=${b}`, { checks: { ils: true } });
      const ticked = k.status < 300;
      return { result: `${title} added to ${chat.cardLabel(c)}${ticked ? " and ILS checked ticked." : `, but ILS checked wasn't ticked: ${callError(k)}`}`, action: `Added ${title} to ${chat.cardLabel(c)}${ticked ? " (ILS checked ✓)" : ""}` };
    },
  };
  return async (name, input) => {
    if (!run[name]) return { result: "There's no such tool." };
    try { return await run[name](input || {}); } catch (err) { return { result: `That didn't work: ${err.message}` }; }
  };
}

// One question: the model calls tools until it has an answer.
async function chatAnswer(req, history, question) {
  const tool = chatTools(req);
  const messages = chat.contextMessages(history).concat([{ role: "user", content: question }]);
  if (messages.length > 1 && messages[messages.length - 2].role === "user") messages.splice(messages.length - 2, 1);
  const actions = [], looked = [];
  for (let round = 0; round < chat.MAX_ROUNDS; round++) {
    const out = await invoke({ max_tokens: 4000, system: chat.SYSTEM_PROMPT, tools: chat.TOOLS, messages });
    if (out.stop_reason === "refusal") return { text: "Claude declined to answer that one.", actions, looked };
    messages.push({ role: "assistant", content: out.content || [] });
    const uses = (out.content || []).filter((b) => b.type === "tool_use");
    if (out.stop_reason !== "tool_use" || !uses.length) {
      const text = (out.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      return { text: text || "(No answer.)", actions, looked, truncated: out.stop_reason === "max_tokens" };
    }
    const results = [], extras = [];
    for (const u of uses) {
      const r = await tool(u.name, u.input);
      looked.push(u.name);
      if (r.action) actions.push(r.action);
      results.push({ type: "tool_result", tool_use_id: u.id, content: typeof r.result === "string" ? r.result : JSON.stringify(r.result) });
      if (r.extra) extras.push(r.extra);
    }
    messages.push({ role: "user", content: results.concat(extras) });
  }
  return { text: "I stopped after several steps without a final answer. Try a narrower question.", actions, looked };
}

app.get(
  "/api/chat",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const who = String(req.query.user || req.user.username);
    if (!chat.canReadChatsOf(req.user, who)) return res.status(403).json({ error: "Only IT can open someone else's chats" });
    const doc = chat.shape(await getChats(chat.safeName(who)));
    const audit = chat.canReadChatsOf(req.user, "\u0000");
    res.json({
      user: who, mine: sameUser(who, req.user.username), audit, ils: ILS_CONNECTED,
      logins: audit ? (await getUsers()).map((u) => u.username).sort((a, b) => a.localeCompare(b)) : [],
      chats: doc.chats.map((c) => ({ id: c.id, title: c.title, at: c.at, updatedAt: c.updatedAt, count: (c.messages || []).length })),
    });
  })
);
app.get(
  "/api/chat/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const who = String(req.query.user || req.user.username);
    if (!chat.canReadChatsOf(req.user, who)) return res.status(403).json({ error: "Only IT can open someone else's chats" });
    const c = chat.shape(await getChats(chat.safeName(who))).chats.find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: "That chat isn't here" });
    res.json(c);
  })
);
// Ask: { chatId?, text }. Only in your own chats.
app.post(
  "/api/chat",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const question = chat.text(b.text, chat.MAX_MESSAGE);
    if (!question) return res.status(400).json({ error: "Type a question first" });
    const name = chat.safeName(req.user.username);
    const existing = b.chatId ? chat.shape(await getChats(name)).chats.find((x) => x.id === b.chatId) : null;
    if (b.chatId && !existing) return res.status(404).json({ error: "That chat isn't here any more" });
    let answer;
    try {
      answer = await chatAnswer(req, existing || { messages: [] }, question);
    } catch (err) {
      if (err instanceof AiError) return res.status(502).json({ error: err.message });
      throw err;
    }
    console.log(`Chat with AOG: ${req.user.username}, ${answer.looked.length} tool call(s), ${answer.actions.length} change(s)`);
    const now = Date.now();
    const saved = await withChats(name, (doc) => {
      chat.shape(doc);
      let c = existing && doc.chats.find((x) => x.id === existing.id);
      if (!c) { c = { id: newId(), title: chat.chatTitle(question), at: now, messages: [] }; doc.chats.push(c); }
      c.messages.push({ role: "user", text: question, at: now });
      c.messages.push({ role: "assistant", text: answer.text, at: Date.now(), actions: answer.actions, truncated: !!answer.truncated });
      c.updatedAt = Date.now();
      chat.trim(doc);
      return JSON.parse(JSON.stringify(c));
    });
    res.json(saved);
  })
);

// ---------- Improvements ----------
// Requests for changes to the tracker (improvements.js). Everyone adds and
// sees their own; Leadership and IMPROVEMENTS_OWNERS see all and are the
// only ones who change the status or reply — checked here on every write.
async function rawLogin(user) {
  return (await getUsers()).find((u) => sameUser(u.username, user.username)) || null;
}
app.get(
  "/api/improvements",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const [doc, raw] = await Promise.all([getImprovements(), rawLogin(req.user)]);
    res.json(improvements.view(doc, req.user, raw));
  })
);
app.post(
  "/api/improvements",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const out = improvements.newItem(req.body, req.user.username, newId(), Date.now());
    if (out.error) return res.status(400).json({ error: out.error });
    await withImprovements((doc) => { improvements.shape(doc).items.push(out.item); });
    res.status(201).json(out.item);
  })
);
// The screenshot: an image, added by the person who asked while it's New.
app.post(
  "/api/improvements/:id/screenshot",
  authMiddleware,
  express.raw({ type: () => true, limit: "10mb" }),
  asyncHandler(async (req, res) => {
    const name = String(req.query.name || "screenshot").replace(/[\\/\r\n"]+/g, "_").slice(0, 160);
    const ext = (name.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
    const type = ext && improvements.SCREENSHOT_TYPES[ext.toLowerCase()];
    if (!type) return res.status(400).json({ error: "Attach the screenshot as a PNG, JPG, GIF or WebP image" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "No file came through" });
    const x0 = improvements.shape(await getImprovements()).items.find((x) => x.id === req.params.id);
    if (!x0 || !sameUser(x0.by, req.user.username)) return res.status(404).json({ error: "That request isn't yours" });
    if (x0.status !== "new") return res.status(400).json({ error: "That request has already been picked up" });
    await putFile(`improvement_files/${x0.id}`, req.body, type);
    const item = await withImprovements((doc) => {
      const x = improvements.shape(doc).items.find((y) => y.id === x0.id);
      if (!x) return null;
      x.screenshot = { name, type, size: req.body.length, at: Date.now() };
      return Object.assign({}, x);
    });
    if (!item) return res.status(404).json({ error: "That request isn't here any more" });
    res.json(item);
  })
);
app.get(
  "/api/improvements/:id/screenshot",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const [doc, raw] = await Promise.all([getImprovements(), rawLogin(req.user)]);
    const x = improvements.shape(doc).items.find((y) => y.id === req.params.id);
    if (!x || !x.screenshot || !(sameUser(x.by, req.user.username) || improvements.canManage(req.user, raw))) return res.status(404).json({ error: "That screenshot isn't here" });
    const file = await getFile(`improvement_files/${x.id}`);
    if (!file) return res.status(404).json({ error: "The screenshot is missing" });
    sendViewOnly(res, x.screenshot, file);
  })
);
// Status and/or a reply: Leadership and owners only.
app.post(
  "/api/improvements/:id/update",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!improvements.canManage(req.user, await rawLogin(req.user))) return res.status(403).json({ error: "Only Leadership changes the status of a request" });
    const out = await withImprovements((doc) => {
      const x = improvements.shape(doc).items.find((y) => y.id === req.params.id);
      if (!x) return { status: 404, error: "That request isn't here any more" };
      const r = improvements.applyUpdate(x, req.body, req.user.username, newId(), Date.now());
      if (r.error) return { status: 400, error: r.error };
      return { item: Object.assign({}, x) };
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json(out.item);
  })
);
// Opening Improvements clears "updated" on your own requests.
app.post(
  "/api/improvements/seen",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const doc = await getImprovements();
    if (!improvements.shape(doc).items.some((x) => sameUser(x.by, req.user.username) && improvements.unseenUpdate(x))) return res.json({ ok: true });
    await withImprovements((d) => {
      const now = Date.now();
      improvements.shape(d).items.forEach((x) => { if (sameUser(x.by, req.user.username)) x.bySeenAt = now; });
    });
    res.json({ ok: true });
  })
);

// #strategymeeting / @strategymeeting in any note saved anywhere in the
// tracker (any text field of a successful save) adds a row dated for the
// next meeting, quoting the line and saying where it came from. Each tagged
// line is added once, however often the note is saved again.
async function noteSource(req) {
  const seg = req.path.split("/").filter(Boolean);
  if (seg[0] === "board" && seg[1]) {
    const cfg = boardOf(req);
    const c = ((await getBoard(cfg.store)).cards || []).find((x) => x.id === seg[1]);
    return `${cfg.name}${c ? " · " + cardLabel(c) : ""}`;
  }
  if (seg[0] === "tasks") {
    const t = seg[1] && (await getTasks()).find((x) => x.id === seg[1]);
    const title = t ? taskLabel(t) : (req.body || {}).title;
    return `Task${title ? " · " + String(title).slice(0, 120) : ""}`;
  }
  const NAMES = { "staff-forms": "Administration form", performance: "Performance", people: "People", legal: "Legal", finance: "Finance",
    "rfq-marks": "Pentagon list", qbr: "Quarterly review", "it-requests": "IT request", "it-notebook": "IT notebook", sops: "SOP",
    "sop-requests": "SOP change request", documents: "Documents", payroll: "Payroll", calendar: "Calendar", improvements: "Improvements" };
  return NAMES[seg[0]] || "A note";
}
async function raiseFromNotes(req, lines) {
  const source = await noteSource(req).catch(() => "A note");
  const today = officeToday(), settings = await getSettings();
  await withStrategy((doc) => {
    strategy.shape(doc);
    const date = strategy.nextDate(doc, today, strategy.meetingDates(doc, settings, today));
    for (const l of lines) {
      const key = strategy.raisedKey(l.line);
      if (doc.raised.includes(key)) continue;
      strategy.remember(doc, key);
      doc.topics.push({ id: newId(), topic: l.topic, owner: "", discussOn: date, status: "open", raisedBy: req.user.username, at: Date.now(), source,
        log: [{ id: newId(), kind: "note", text: l.line, by: req.user.username, at: Date.now(), source }] });
    }
  });
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
