const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("Missing required env var: JWT_SECRET");
  process.exit(1);
}

const DEPARTMENTS = [
  "Procurement",
  "Purchasing",
  "IT",
  "HR",
  "Operations",
  "US Government",
  "Warehouse",
];

// Accounts in any of these departments see and can touch every
// department's tasks, in addition to having their own department's board
// like everyone else. Everyone not listed here is scoped to just their own
// department. Edit this list to change who has full access.
const FULL_ACCESS_DEPARTMENTS = ["HR", "Operations", "IT"];

function hasFullAccess(department) {
  return FULL_ACCESS_DEPARTMENTS.includes(department);
}

function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signUserToken(user) {
  return jwt.sign(
    { sub: user.username, department: user.department, kind: "user" },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

function signAdminToken() {
  return jwt.sign({ kind: "admin" }, JWT_SECRET, { expiresIn: "2h" });
}

function readBearer(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

function authMiddleware(req, res, next) {
  const token = readBearer(req);
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.kind !== "user") {
      return res.status(401).json({ error: "Invalid token" });
    }
    req.user = { username: payload.sub, department: payload.department };
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

function adminMiddleware(req, res, next) {
  const token = readBearer(req);
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.kind !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired admin session" });
  }
}

module.exports = {
  DEPARTMENTS,
  FULL_ACCESS_DEPARTMENTS,
  hasFullAccess,
  hashPassword,
  verifyPassword,
  signUserToken,
  signAdminToken,
  authMiddleware,
  adminMiddleware,
};
