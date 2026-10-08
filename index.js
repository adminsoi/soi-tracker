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
} = require("./s3store");
const { sendMail } = require("./mailer");
const { pentagonQuery } = require("./pentagon");
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

async function notifyOwner(task, previousOwner) {
  if (!task.owner || task.owner === previousOwner) return;
  const users = await getUsers();
  const ownerUser = users.find((u) => u.username === task.owner);
  if (!ownerUser || !ownerUser.email) return;
  try {
    await sendMail({
      to: ownerUser.email,
      subject: `New task assigned: ${task.title}`,
      html:
        `<p>You've been assigned a task in the SOI Aviation tracker — ${escapeHtml(taskCompany(task))} / ${escapeHtml(task.department)}:</p>` +
        `<p><strong>${escapeHtml(task.title)}</strong></p>` +
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
      return res.json(scoped.filter((t) => canSee(req.user, t)));
    }

    if (!req.user.companies.includes(company)) {
      return res.status(403).json({ error: "You don't have access to that company" });
    }
    const inCompany = tasks.filter((t) => taskCompany(t) === company);
    const scoped = req.user.fullAccess
      ? inCompany
      : inCompany.filter((t) => req.user.departments.includes(t.department));
    res.json(scoped.filter((t) => canSee(req.user, t)));
  })
);

app.post(
  "/api/tasks",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const title = String(body.title || "").trim().slice(0, 140);
    if (!title) return res.status(400).json({ error: "Title is required" });

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
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate || "") ? body.dueDate : "",
      notes: String(body.notes || "").trim().slice(0, 500),
      createdAt: Date.now(),
      createdBy: req.user.username,
    };

    await withTasks((tasks) => {
      tasks.unshift(task);
    });

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
    if ("title" in body && !String(body.title || "").trim()) {
      return res.status(400).json({ error: "Title is required" });
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
      previousOwner = t.owner;
      if ("title" in body) t.title = String(body.title).trim().slice(0, 140);
      if ("status" in body) t.status = body.status;
      if ("priority" in body) t.priority = body.priority;
      if (manager && "owner" in body) t.owner = String(body.owner || "").trim().slice(0, 60);
      if ("dueDate" in body) t.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate || "") ? body.dueDate : "";
      if ("notes" in body) t.notes = String(body.notes || "").trim().slice(0, 500);
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
      tasks.splice(idx, 1);
      removed = true;
    });

    if (forbidden) return res.status(403).json({ error: "You can only delete tasks you created" });
    if (!removed) return res.status(404).json({ error: "Task not found" });
    res.status(204).end();
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

app.post(
  "/api/pentagon/:queryName",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { queryName } = req.params;
    // "Mentions you" is personal data, not departmental — any SOI Aviation
    // account can run it. Every other Pentagon query stays restricted.
    const allowed = queryName === "dashboards.mine" || canUsePentagon(req.user, "SOI Aviation");
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

// ---------- RFQ ticks (✓ / ✗) and notes ----------
// Pentagon RFQs are read-only from here, so the tick and the note live in
// the tracker, keyed by RFQ number. Anyone who can see the RFQ list can read
// them; only managers can set them.

app.get(
  "/api/rfq-marks",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!canUsePentagon(req.user, "SOI Aviation")) {
      return res.status(403).json({ error: "Not available for your account" });
    }
    res.json(await getRfqMarks());
  })
);

app.put(
  "/api/rfq-marks/:key",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!canUsePentagon(req.user, "SOI Aviation")) {
      return res.status(403).json({ error: "Not available for your account" });
    }
    if (!isManager(req.user)) {
      return res.status(403).json({ error: "Only a manager can tick off RFQs or edit their notes" });
    }
    const key = String(req.params.key || "").trim().slice(0, 80);
    if (!key) return res.status(400).json({ error: "Missing RFQ number" });
    const body = req.body || {};
    let saved = null;
    await withRfqMarks((marks) => {
      const mark = marks[key] || { done: false, notes: "" };
      if ("done" in body) mark.done = !!body.done;
      if ("notes" in body) mark.notes = String(body.notes || "").trim().slice(0, 500);
      mark.updatedBy = req.user.username;
      mark.updatedAt = Date.now();
      marks[key] = mark;
      saved = mark;
    });
    res.json(saved);
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
    const { username, password, email, companies, departments, fullAccess, manager, pentagonCode } = req.body || {};
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
