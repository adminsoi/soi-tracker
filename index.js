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
} = require("./auth");
const { getUsers, getTasks, withUsers, withTasks } = require("./s3store");
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

// Accounts created before companies existed only have a single
// "department" field. Treat them as belonging to just SOI Aviation (the
// only company that existed at the time) until someone re-saves them via
// the admin page with real company/full-access settings.
function normalizeUser(u) {
  return {
    ...u,
    companies: u.companies && u.companies.length ? u.companies : [DEFAULT_COMPANY],
    fullAccess: !!u.fullAccess,
  };
}

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
      department: user.department || null,
      fullAccess: user.fullAccess,
    });
  })
);

app.get("/api/me", authMiddleware, (req, res) => {
  res.json({
    username: req.user.username,
    companies: req.user.companies,
    department: req.user.department,
    fullAccess: req.user.fullAccess,
  });
});

app.get("/api/companies", (req, res) => {
  res.json(COMPANIES);
});

app.get("/api/departments", (req, res) => {
  res.json(DEPARTMENTS);
});

// Directory of real logins, for picking a task's Owner. Scoped to people
// who have access to this company, and who are either in the same
// department or have full access — so people don't see the whole
// company's account list unnecessarily.
app.get(
  "/api/users",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const company = req.query.company;
    const dept = req.query.department;
    const rawUsers = await getUsers();
    const users = rawUsers.map(normalizeUser);
    const filtered = users
      .filter((u) => !company || u.companies.includes(company))
      .filter((u) => !dept || u.department === dept || u.fullAccess)
      .map((u) => ({ username: u.username, department: u.department }));
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
      return res.json(scoped);
    }

    if (!req.user.companies.includes(company)) {
      return res.status(403).json({ error: "You don't have access to that company" });
    }
    const inCompany = tasks.filter((t) => taskCompany(t) === company);
    const scoped = req.user.fullAccess
      ? inCompany
      : inCompany.filter((t) => t.department === req.user.department);
    res.json(scoped);
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

    let department = req.user.department;
    if (req.user.fullAccess) {
      if (!DEPARTMENTS.includes(body.department)) {
        return res.status(400).json({ error: "Choose a valid department" });
      }
      department = body.department;
    }
    if (!department) {
      return res.status(400).json({ error: "This account has no department set — ask an admin to fix it" });
    }

    const priority = ["low", "medium", "high"].includes(body.priority)
      ? body.priority
      : "medium";

    const task = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      title,
      company: body.company,
      department,
      status: "todo",
      priority,
      owner: String(body.owner || "").trim().slice(0, 60),
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
  return user.fullAccess || user.department === task.department;
}

app.patch(
  "/api/tasks/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const allowedFields = ["status", "title", "priority", "owner", "dueDate", "notes"];
    let updated = null;
    let forbidden = false;
    let previousOwner = null;

    await withTasks((tasks) => {
      const t = tasks.find((x) => x.id === id);
      if (!t) return;
      if (!canTouch(req.user, t)) {
        forbidden = true;
        return;
      }
      previousOwner = t.owner;
      allowedFields.forEach((k) => {
        if (k in req.body) t[k] = req.body[k];
      });
      updated = t;
    });

    if (forbidden) return res.status(403).json({ error: "That task isn't accessible to you" });
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
      if (idx === -1) return;
      if (!canTouch(req.user, tasks[idx])) {
        forbidden = true;
        return;
      }
      tasks.splice(idx, 1);
      removed = true;
    });

    if (forbidden) return res.status(403).json({ error: "That task isn't accessible to you" });
    if (!removed) return res.status(404).json({ error: "Task not found" });
    res.status(204).end();
  })
);

// ---------- Pentagon (generic query proxy) ----------
// One route forwards any named query to Pentagon's API, so adding a new
// query later (RFQs, actual Queries, etc.) needs no new backend code —
// just call this route with that query's name and whatever params/limit
// it expects. The API key never reaches the browser.

function canUsePentagon(user) {
  return user.fullAccess || user.department === "Procurement";
}

app.post(
  "/api/pentagon/:queryName",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!canUsePentagon(req.user)) {
      return res.status(403).json({ error: "Not available for your account" });
    }
    const { queryName } = req.params;
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
        department: u.department || null,
        fullAccess: u.fullAccess,
      }))
    );
  })
);

app.post(
  "/api/admin/users",
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const { username, password, email, companies, department, fullAccess } = req.body || {};
    if (!username || !password || !email) {
      return res.status(400).json({ error: "Username, password, and email are required" });
    }
    if (!Array.isArray(companies) || companies.length === 0) {
      return res.status(400).json({ error: "Select at least one company" });
    }
    if (companies.some((c) => !COMPANIES.includes(c))) {
      return res.status(400).json({ error: "Invalid company selected" });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }
    if (!fullAccess && !DEPARTMENTS.includes(department)) {
      return res.status(400).json({ error: "Choose a department, or turn on full access" });
    }

    const passwordHash = await hashPassword(password);
    const record = {
      username,
      passwordHash,
      email,
      companies,
      fullAccess: !!fullAccess,
      department: fullAccess ? department || null : department,
    };

    await withUsers((users) => {
      const idx = users.findIndex((u) => u.username.toLowerCase() === username.toLowerCase());
      if (idx !== -1) {
        users[idx] = { ...users[idx], ...record, passwordHash };
      } else {
        users.push(record);
      }
    });

    res.status(201).json({ username, email, companies, department: record.department, fullAccess: record.fullAccess });
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
