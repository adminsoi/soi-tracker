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
  "Business Development",
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

// A short fingerprint of the password hash, so changing a password ends
// every sign-in made with the old one.
function passwordStamp(user) {
  return require("crypto").createHash("sha256").update(String(user.passwordHash || "")).digest("base64url").slice(0, 12);
}

// remember: "Remember me" — 30 days instead of 12 hours.
function signUserToken(user, remember) {
  return jwt.sign(
    {
      sub: user.username,
      companies: user.companies,
      departments: user.departments || [],
      fullAccess: !!user.fullAccess,
      manager: !!user.manager,
      leadership: !!user.leadership,
      pentagonCode: user.pentagonCode || "",
      pv: passwordStamp(user),
      rm: !!remember,
      kind: "user",
    },
    JWT_SECRET,
    { expiresIn: remember ? "30d" : "12h" }
  );
}

function signAdminToken() {
  return jwt.sign({ kind: "admin" }, JWT_SECRET, { expiresIn: "2h" });
}

function readBearer(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

// index.js plugs in a check against the saved logins (see setUserCheck):
// it returns the login's current access, or null when the login was
// deleted or its password changed.
let userCheck = null;
function setUserCheck(fn) { userCheck = fn; }

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
      leadership: !!payload.leadership,
      pentagonCode: payload.pentagonCode || "",
    };
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
  if (!userCheck) return next();
  const payload = jwt.decode(token);
  Promise.resolve(userCheck(payload)).then((fresh) => {
    if (!fresh) return res.status(401).json({ error: "Please sign in again" });
    Object.assign(req.user, fresh);
    next();
  }, (err) => {
    // Can't read the saved logins right now: go by the token rather than
    // signing everyone out.
    console.error("Sign-in check skipped:", err.message);
    next();
  });
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
  passwordStamp,
  setUserCheck,
  authMiddleware,
  adminMiddleware,
  isManager,
};
