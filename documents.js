// Documents (ROADMAP.md Phase 6): a file manager for SOI's S3, with one
// labelled space per company and department, plus the Operations and US Gov
// board files' attachments. This file is the rules — who sees a space, who
// may change it, what an edit grant covers, and the folder tree. index.js has
// the routes; the list is stored in S3 as documents.json and each version of
// a document under documents_files/<file id>/<version id>.
//
// Read-only by default. "Request edit" raises an IT ticket; IT (or a
// full-access login) grants edit access to that folder and everything under
// it, for 30 days unless they pick another end date or none. Full-access
// logins can edit every space they see. Edit = add files and folders, upload
// a new version (old versions kept), rename, move within the space, archive.
// Nothing is ever deleted from S3 here; IT can restore an archived item.
//
// Board spaces are read-only views of board_files/ and usgov_board_files/:
// documents are added on the board's case file, never here.
//
// HR's employment files (people_files/), staff form receipts, payroll and
// performance files are never listed here — they stay on their own pages.
//
// Every check runs on the server. The page shows documents view-only with no
// download link, but that only discourages copying: a screenshot or a
// determined person can still take a copy.

const { text } = require("./staffforms");

const DAY = 24 * 60 * 60 * 1000;
const GRANT_DAYS = 30;
const MAX_GRANT_DAYS = 366;

// Shown in the browser (PDF, pictures, plain text). Word, Excel, PowerPoint
// and email files can't be shown without downloading them or sending them to
// an outside viewer, so they're listed with no preview.
const PREVIEW_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/csv"];
const canPreview = (type) => PREVIEW_TYPES.includes(type);

const top = (u) => !!(u.fullAccess || u.leadership);
const inDept = (u, d) => !!(u.fullAccess || (u.departments || []).includes(d));
// IT (and full access) handle edit requests and grants.
const grantsAdmin = (u) => !!(u.fullAccess || (u.departments || []).includes("IT"));

const BOARD_SPACES = {
  "board:ops": { board: "ops", label: "Operations board files" },
  "board:usgov": { board: "usgov", label: "US Gov board files" },
};
const deptSpaceId = (company, dept) => `dept:${company}|${dept}`;
function parseSpace(id) {
  const s = String(id || "");
  if (BOARD_SPACES[s]) return Object.assign({ id: s, kind: "board" }, BOARD_SPACES[s]);
  const m = s.match(/^dept:([^|]+)\|(.+)$/);
  return m ? { id: s, kind: "dept", company: m[1], dept: m[2] } : null;
}

/**
 * The spaces this login sees. Department spaces: one per company on the login
 * and department on the login (every department for full access and
 * Leadership). Board spaces follow the boards' own rules (canSeeBoard).
 */
function spacesFor(u, { companies, departments, canSeeBoard }) {
  const out = [];
  for (const company of companies.filter((c) => (u.companies || []).includes(c))) {
    for (const dept of departments) if (top(u) || inDept(u, dept)) out.push({ id: deptSpaceId(company, dept), kind: "dept", company, dept, label: dept });
  }
  for (const [id, b] of Object.entries(BOARD_SPACES)) if (canSeeBoard(u, b.board)) out.push({ id, kind: "board", board: b.board, label: b.label });
  return out;
}

function shape(doc) {
  for (const k of ["folders", "files", "grants"]) doc[k] = Array.isArray(doc[k]) ? doc[k] : [];
  return doc;
}
function cleanName(v) {
  return text(v, 160).replace(/[\\/\r\n"]+/g, "_");
}
const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// The folder and the folders above it, nearest first ("" is the space root).
function chain(doc, folderId) {
  const out = [];
  const seen = new Set();
  let id = folderId || "";
  while (id && !seen.has(id)) {
    seen.add(id);
    const f = doc.folders.find((x) => x.id === id);
    if (!f) break;
    out.push(f);
    id = f.parent || "";
  }
  return out;
}
// A live (not archived) folder in this space, or the root.
function folderIn(doc, space, folderId) {
  if (!folderId) return { id: "", name: "", space };
  const f = doc.folders.find((x) => x.id === folderId && x.space === space);
  if (!f || chain(doc, f.id).some((x) => x.archived)) return null;
  return f;
}
function pathLabel(doc, space, folderId) {
  const sp = parseSpace(space);
  const head = sp ? (sp.kind === "dept" ? [sp.company, sp.dept] : [sp.label]) : [space];
  return head.concat(chain(doc, folderId).reverse().map((f) => f.name)).join(" › ");
}

// A grant is live until its end date (end of that day, server time) and
// while not revoked. It covers its folder and everything under it.
const grantLive = (g, now) => !g.revokedAt && (!g.until || g.until > now);
function liveGrant(doc, u, space, folderId, now = Date.now()) {
  const ids = new Set([""].concat(chain(doc, folderId).map((f) => f.id)));
  return doc.grants.filter((g) => grantLive(g, now) && g.space === space && String(g.user).toLowerCase() === String(u.username).toLowerCase() && ids.has(g.folder || ""))
    .sort((a, b) => (b.until || Infinity) - (a.until || Infinity))[0] || null;
}
/** May this login change this folder of this (department) space? Board spaces: never. */
function mayEdit(doc, u, space, folderId, seen) {
  const sp = parseSpace(space);
  if (!sp || sp.kind !== "dept" || !seen) return false;
  return !!(u.fullAccess || liveGrant(doc, u, space, folderId));
}

/** End date for a grant: a "YYYY-MM-DD" (end of that day) or "" for none; default 30 days. */
function grantUntil(v, now = Date.now()) {
  if (v === "" || v === null) return { until: null };
  if (v === undefined) return { until: now + GRANT_DAYS * DAY };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return { error: "Pick an end date or no expiry" };
  const until = Date.parse(v + "T23:59:59");
  if (!(until > now)) return { error: "The end date has passed" };
  if (until > now + MAX_GRANT_DAYS * DAY) return { error: "Pick an end date within a year, or no expiry" };
  return { until };
}

/** Would moving folder f under parent put it inside itself? */
function wouldLoop(doc, f, parent) {
  return !!parent && chain(doc, parent).some((x) => x.id === f.id);
}

module.exports = {
  GRANT_DAYS, PREVIEW_TYPES, BOARD_SPACES,
  canPreview, grantsAdmin, parseSpace, deptSpaceId, spacesFor, shape, cleanName, sameName,
  chain, folderIn, pathLabel, grantLive, liveGrant, mayEdit, grantUntil, wouldLoop,
};
