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
  getPentagonPresets,
  withPentagonPresets,
  getRfqMarks,
  withRfqMarks,
  getSettings,
  withSettings,
  getFinance,
  withFinance,
} = require("./s3store");
const { sendMail } = require("./mailer");
const { upcomingEvents, CalendarError } = require("./calendar");
const { pentagonQuery } = require("./pentagon");
const {
  PENTAGON_VIEWS,
  FIELD_GUESSES,
  allViews,
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

    // Only managers assign work to someone else. Everyone else's tasks are
    // always their own, whatever the form sent.
    const owner = isManager(req.user)
      ? String(body.owner || "").trim().slice(0, 60)
      : req.user.username;

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

app.get(
  "/api/finance",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const company = String(req.query.company || "");
    if (!canSeeFinance(req.user, company)) {
      return res.status(403).json({ error: "Finance isn't available for your account" });
    }
    const all = await getFinance();
    res.json({ ...emptyFinance(), ...(all[company] || {}) });
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

// ---------- Pentagon (generic query proxy) ----------
// One route forwards any named query to Pentagon's API, so adding a new
// query later needs no new backend code — just call this route with that
// query's name and whatever params/limit it expects. The API key never
// reaches the browser. Currently restricted to SOI Aviation only.

function canUsePentagon(user, activeCompany) {
  if (activeCompany !== "SOI Aviation") return false;
  return user.fullAccess || user.departments.includes("Procurement");
}

// Someone in a view's department (or with full access) may run that view's
// query even without access to the general Pentagon tester. The views
// themselves are defined in pentagonViews.js.
const VIEW_DEPARTMENTS = Object.fromEntries(allViews().map((v) => [v.id, v.department]));
const QUERY_DEPARTMENTS = Object.fromEntries(allViews().map((v) => [v.queryName, v.department]));

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
    // "Mentions you" is personal data, not departmental — any SOI Aviation
    // account can run it. Every other Pentagon query stays restricted.
    const allowed =
      queryName === "dashboards.mine" ||
      canUsePentagon(req.user, "SOI Aviation") ||
      (req.user.companies.includes("SOI Aviation") && inDepartment(req.user, QUERY_DEPARTMENTS[queryName]));
    if (!allowed) {
      return res.status(403).json({ error: "Not available for your account" });
    }
    const body = req.body || {};
    try {
      const data = await pentagonQuery(queryName, body);
      res.json(data);
    } catch (err) {
      console.error(`Pentagon query failed: ${err.message}`);
      res.status(502).json({ error: "Pentagon query failed: " + err.message });
    }
  })
);

// Shared saved searches — visible to and editable by anyone who can use
// the Pentagon tab (same audience as running queries themselves).

app.get(
  "/api/pentagon-presets",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!canUsePentagon(req.user, "SOI Aviation")) {
      return res.status(403).json({ error: "Not available for your account" });
    }
    const presets = await getPentagonPresets();
    res.json(presets);
  })
);

app.post(
  "/api/pentagon-presets",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!canUsePentagon(req.user, "SOI Aviation")) {
      return res.status(403).json({ error: "Not available for your account" });
    }
    const body = req.body || {};
    const name = String(body.name || "").trim().slice(0, 80);
    const queryName = String(body.queryName || "").trim();
    if (!name || !queryName) {
      return res.status(400).json({ error: "Name and query name are required" });
    }
    const preset = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name,
      queryName,
      params: body.params && typeof body.params === "object" ? body.params : {},
      limit: Number.isFinite(body.limit) ? body.limit : 10,
      createdBy: req.user.username,
      createdAt: Date.now(),
    };
    await withPentagonPresets((presets) => {
      presets.push(preset);
    });
    res.status(201).json(preset);
  })
);

app.delete(
  "/api/pentagon-presets/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!canUsePentagon(req.user, "SOI Aviation")) {
      return res.status(403).json({ error: "Not available for your account" });
    }
    const { id } = req.params;
    let removed = false;
    await withPentagonPresets((presets) => {
      const idx = presets.findIndex((p) => p.id === id);
      if (idx !== -1) {
        presets.splice(idx, 1);
        removed = true;
      }
    });
    if (!removed) return res.status(404).json({ error: "Preset not found" });
    res.status(204).end();
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
    const data = await pentagonQuery(view.queryName, { params: {}, limit: 200 });
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
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 42);
    const users = await getUsers();
    const u = users.find((x) => sameUser(x.username, req.user.username));
    try {
      res.json(await upcomingEvents(u && u.email, days));
    } catch (err) {
      if (err instanceof CalendarError) return res.status(409).json({ error: err.message, code: err.code });
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
    res.json(settings.sharedCalendar || { name: "", url: "" });
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
    const name = String((req.body || {}).name || "").trim().slice(0, 60) || "HR global calendar";
    const shared = { name, url };
    await withSettings((settings) => {
      settings.sharedCalendar = shared;
    });
    res.json(shared);
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
    const { username, password, email, companies, departments, fullAccess, manager, breakdown, leadership, pentagonCode } = req.body || {};
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

ensureCert();

https
  .createServer(
    { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) },
    app
  )
  .listen(PORT, () => {
    console.log(`SOI tracker listening on https://0.0.0.0:${PORT}`);
  });
