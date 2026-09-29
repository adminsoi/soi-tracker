require("dotenv").config();

const path = require("path");
const express = require("express");

const {
  DEPARTMENTS,
  hashPassword,
  verifyPassword,
  signUserToken,
  signAdminToken,
  authMiddleware,
  adminMiddleware,
} = require("./auth");
const { getUsers, getTasks, withUsers, withTasks } = require("./s3store");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error("Missing required env var: ADMIN_PASSWORD");
  process.exit(1);
}

const PORT = process.env.PORT || 4000;

const app = express();
app.use(express.json());

// ---------- Login ----------

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }
  const users = await getUsers();
  const user = users.find(
    (u) => u.username.toLowerCase() === String(username).toLowerCase()
  );
  if (!user) return res.status(401).json({ error: "Invalid username or password" });

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid username or password" });

  const token = signUserToken(user);
  res.json({ token, username: user.username, department: user.department });
});

app.get("/api/me", authMiddleware, (req, res) => {
  res.json({ username: req.user.username, department: req.user.department });
});

app.get("/api/departments", (req, res) => {
  res.json(DEPARTMENTS);
});

// ---------- Tasks (scoped by department) ----------

app.get("/api/tasks", authMiddleware, async (req, res) => {
  const tasks = await getTasks();
  const scoped =
    req.user.department === "Operations"
      ? tasks
      : tasks.filter((t) => t.department === req.user.department);
  res.json(scoped);
});

app.post("/api/tasks", authMiddleware, async (req, res) => {
  const body = req.body || {};
  const title = String(body.title || "").trim().slice(0, 140);
  if (!title) return res.status(400).json({ error: "Title is required" });

  let department = req.user.department;
  if (req.user.department === "Operations") {
    if (!DEPARTMENTS.includes(body.department) || body.department === "Operations") {
      return res.status(400).json({ error: "Choose a valid department" });
    }
    department = body.department;
  }

  const priority = ["low", "medium", "high"].includes(body.priority)
    ? body.priority
    : "medium";

  const task = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    title,
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
});

function canTouch(user, task) {
  return user.department === "Operations" || user.department === task.department;
}

app.patch("/api/tasks/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const allowedFields = ["status", "title", "priority", "owner", "dueDate", "notes"];
  let updated = null;
  let forbidden = false;

  await withTasks((tasks) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    if (!canTouch(req.user, t)) {
      forbidden = true;
      return;
    }
    allowedFields.forEach((k) => {
      if (k in req.body) t[k] = req.body[k];
    });
    updated = t;
  });

  if (forbidden) return res.status(403).json({ error: "That task isn't in your department" });
  if (!updated) return res.status(404).json({ error: "Task not found" });
  res.json(updated);
});

app.delete("/api/tasks/:id", authMiddleware, async (req, res) => {
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

  if (forbidden) return res.status(403).json({ error: "That task isn't in your department" });
  if (!removed) return res.status(404).json({ error: "Task not found" });
  res.status(204).end();
});

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

app.get("/api/admin/users", adminMiddleware, async (req, res) => {
  const users = await getUsers();
  res.json(users.map((u) => ({ username: u.username, department: u.department })));
});

app.post("/api/admin/users", adminMiddleware, async (req, res) => {
  const { username, password, department } = req.body || {};
  if (!username || !password || !department) {
    return res.status(400).json({ error: "Username, password, and department are required" });
  }
  if (!DEPARTMENTS.includes(department)) {
    return res.status(400).json({ error: "Invalid department" });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const passwordHash = await hashPassword(password);
  await withUsers((users) => {
    const idx = users.findIndex((u) => u.username.toLowerCase() === username.toLowerCase());
    if (idx !== -1) {
      users[idx].passwordHash = passwordHash;
      users[idx].department = department;
    } else {
      users.push({ username, passwordHash, department });
    }
  });

  res.status(201).json({ username, department });
});

app.delete("/api/admin/users/:username", adminMiddleware, async (req, res) => {
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
});

// ---------- Frontend (flat layout: html files sit next to this file) ----------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.listen(PORT, () => {
  console.log(`SOI tracker listening on :${PORT}`);
});
