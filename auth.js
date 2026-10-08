const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("Missing required env var: JWT_SECRET");
  process.exit(1);
}

const COMPANIES = ["RedSun Aviation", "SOI Aviation", "NanoTech Aviation", "CAS"];

const DEPARTMENTS = [
  "Procurement",
  "Purchasing",
  "IT",
  "HR",
  "Operations",
  "US Government",
  "Warehouse",
  "Administrative",
  "Accounting & Finance",
];

// Tasks created before companies existed have no "company" field. Treat
// those as belonging to SOI Aviation, since that's the only company that
// existed at the time.
const DEFAULT_COMPANY = "SOI Aviation";

function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signUserToken(user) {
  return jwt.sign(
    {
      sub: user.username,
      companies: user.companies,
      departments: user.departments || [],
      fullAccess: !!user.fullAccess,
      manager: !!user.manager,
      pentagonCode: user.pentagonCode || "",
      kind: "user",
    },
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
    req.user = {
      username: payload.sub,
      companies: payload.companies || [],
      departments: payload.departments || [],
      fullAccess: !!payload.fullAccess,
      manager: !!payload.manager,
      pentagonCode: payload.pentagonCode || "",
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

// Managers assign tasks to other people and are the only ones who can change
// a task's status or tick off an RFQ. Full-access accounts are managers too.
function isManager(user) {
  return !!(user && (user.fullAccess || user.manager));
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
};
