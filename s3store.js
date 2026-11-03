// Simple JSON-document storage backed by S3. Good fit for a small internal
// tool with light write traffic. NOTE: writes are only serialized within
// this one running process — if you ever scale this to more than one
// container/replica, two replicas could race on the same S3 object. For a
// single-container deployment (the normal case on a small Portainer host)
// this is safe.

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const REGION = process.env.AWS_REGION || "us-east-1";
const BUCKET = process.env.S3_BUCKET;
const PREFIX = (process.env.S3_PREFIX || "soi-tracker").replace(/\/+$/, "");

if (!BUCKET) {
  console.error("Missing required env var: S3_BUCKET");
  process.exit(1);
}

// Staging: anything not yet saved under PREFIX is read from SEED_PREFIX
// (the live data), and every write goes to PREFIX only. A file deleted on
// staging shows again from the live copy.
const SEED_PREFIX = (process.env.SEED_FROM_PREFIX || "").replace(/\/+$/, "");
if (SEED_PREFIX && SEED_PREFIX === PREFIX) {
  console.error("SEED_FROM_PREFIX must differ from S3_PREFIX");
  process.exit(1);
}

// Uses the AWS SDK's default credential chain: an attached EC2/ECS IAM
// role is picked up automatically with no extra config. If you're not
// running on AWS infra with a role attached, set AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY / AWS_REGION as env vars instead.
const s3 = new S3Client({ region: REGION });

function keyFor(name, prefix = PREFIX) {
  return `${prefix}/${name}.json`;
}

function isMissing(err) {
  return err.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function readJson(name, fallback) {
  for (const prefix of SEED_PREFIX ? [PREFIX, SEED_PREFIX] : [PREFIX]) {
    try {
      const res = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: keyFor(name, prefix) })
      );
      const text = await streamToString(res.Body);
      return JSON.parse(text);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  return fallback;
}

async function writeJson(name, data) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: keyFor(name),
      Body: JSON.stringify(data, null, 2),
      ContentType: "application/json",
    })
  );
}

// Binary files (KB images). Stored under the same prefix, never public.
async function putFile(name, buffer, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/${name}`, Body: buffer, ContentType: contentType }));
}
async function getFile(name) {
  for (const prefix of SEED_PREFIX ? [PREFIX, SEED_PREFIX] : [PREFIX]) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${prefix}/${name}` }));
      const chunks = [];
      for await (const chunk of res.Body) chunks.push(chunk);
      return { body: Buffer.concat(chunks), contentType: res.ContentType || "application/octet-stream" };
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  return null;
}
async function deleteFile(name) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}/${name}` }));
}

function getUsers() {
  return readJson("users", []);
}
function getTasks() {
  return readJson("tasks", []).then((tasks) => {
    console.log(`[${new Date().toISOString()}] GET tasks: returning ${tasks.length} task(s)`);
    return tasks;
  });
}
function getPentagonPresets() {
  return readJson("pentagon_presets", []);
}
// Manager ticks (✓ / ✗) and notes on Pentagon RFQs, keyed by RFQ number.
// Pentagon itself is read-only from here, so these live in the tracker.
function getRfqMarks() {
  return readJson("rfq_marks", {});
}
// Finance tables per company: bank balances, payments, expected receipts.
function getFinance() {
  return readJson("finance", {});
}
// Small app-wide settings edited from the admin page (Claude project links).
function getSettings() {
  return readJson("settings", {});
}
// Quarterly business review: { quarters: { "2026-Q3": { overrides, notes, rejections } } }.
// Customer follow-up index for the Work inbox: per mailbox, the latest
// customer email and the latest reply in each open conversation (who, when,
// subject — never bodies), plus Microsoft's delta links. See mail.js.
// AOG operations board: { cards: [...], customers: { name: { files } } }.
// The US Gov board is the same shape in its own document ("usgov_board").
function getBoard(name = "aog_board") {
  return readJson(name, { cards: [], customers: {} });
}
function getMailIndex() {
  return readJson("mail_followups", {});
}
// Emails → Ignore: { users: { username: { "<mailbox>|<conv>": { at, latest } } } }.
// See replies.js.
function getInboxIgnored() {
  return readJson("inbox_ignored", { users: {} });
}
function getQbr() {
  return readJson("qbr", {});
}
// Performance records: { people: { username: { manual, hidden, entries, files } } }.
function getPerformance() {
  return readJson("performance", {});
}
// Department SOPs: { sops: [...], qa: [...] } (PDFs themselves via putFile).
function getSops() {
  return readJson("sops", {});
}
// Private IT notebook: ticket write-ups and knowledge base articles.
function getItNotebook() {
  return readJson("it_notebook", {});
}
// IT request form responses (imported from Excel or emailed by the flow).
function getItRequests() {
  return readJson("it_requests", []);
}
// Administration's staff forms: { items: [...] } — admin requests, HR issues,
// leave requests, performance comments and reimbursements (receipts via
// putFile under staff_form_files/<id>/). IT tickets stay in it_requests.
function getStaffForms() {
  return readJson("staff_forms", { items: [] });
}
// HR payroll: { entities: { SOI: {...} }, people: { username: {...} },
// adjustments: [...] }. Kept apart from staff_forms because it holds pay.
function getPayroll() {
  return readJson("payroll", {});
}
// People (Leadership only): { people: { username: { id, jobTitle, …,
// files: [...] } } } — documents via putFile under people_files/<id>/.
// Base pay stays in payroll.
function getPeople() {
  return readJson("people", {});
}
// Documents: { folders, files, grants } — each version of a document via
// putFile under documents_files/<file id>/<version id>. See documents.js.
function getDocuments() {
  return readJson("documents", {});
}
// Legal: { members: [usernames], records: { documentId: { expiry, notes,
// owner } } }. The documents are in Documents. See legal.js.
function getLegal() {
  return readJson("legal", {});
}
// Strategy Meeting (Leadership only): { meetings: [{ id, date, title,
// items: [{ topic, owner, …, actions: [...] }] }] }. See strategy.js.
function getStrategy() {
  return readJson("strategy", {});
}
// Improvements (requests for changes to the tracker): { items: [...] } —
// screenshots via putFile under improvement_files/<id>. See improvements.js.
function getImprovements() {
  return readJson("improvements", { items: [] });
}

// In-process queues so concurrent requests to this same container don't
// clobber each other's read-modify-write cycle.
let usersQueue = Promise.resolve();
let tasksQueue = Promise.resolve();
let presetsQueue = Promise.resolve();
let rfqMarksQueue = Promise.resolve();
let settingsQueue = Promise.resolve();
let financeQueue = Promise.resolve();
let itRequestsQueue = Promise.resolve();
let itNotebookQueue = Promise.resolve();
let sopsQueue = Promise.resolve();
let performanceQueue = Promise.resolve();
let qbrQueue = Promise.resolve();
let mailIndexQueue = Promise.resolve();
let inboxIgnoredQueue = Promise.resolve();
let boardQueue = Promise.resolve();
let staffFormsQueue = Promise.resolve();
let payrollQueue = Promise.resolve();
let peopleQueue = Promise.resolve();
let documentsQueue = Promise.resolve();
let legalQueue = Promise.resolve();
let strategyQueue = Promise.resolve();
let improvementsQueue = Promise.resolve();

function withUsers(mutator) {
  usersQueue = usersQueue.then(async () => {
    const users = await getUsers();
    const result = await mutator(users);
    await writeJson("users", users);
    return result;
  });
  return usersQueue;
}

function withTasks(mutator) {
  tasksQueue = tasksQueue.then(async () => {
    const tasks = await getTasks();
    const before = tasks.length;
    const result = await mutator(tasks);
    console.log(
      `[${new Date().toISOString()}] WRITE tasks: ${before} -> ${tasks.length} task(s)`
    );
    await writeJson("tasks", tasks);
    return result;
  });
  return tasksQueue;
}

function withPentagonPresets(mutator) {
  presetsQueue = presetsQueue.then(async () => {
    const presets = await getPentagonPresets();
    const result = await mutator(presets);
    await writeJson("pentagon_presets", presets);
    return result;
  });
  return presetsQueue;
}

function withRfqMarks(mutator) {
  rfqMarksQueue = rfqMarksQueue.then(async () => {
    const marks = await getRfqMarks();
    const result = await mutator(marks);
    await writeJson("rfq_marks", marks);
    return result;
  });
  return rfqMarksQueue;
}

function withFinance(mutator) {
  financeQueue = financeQueue.then(async () => {
    const finance = await getFinance();
    const result = await mutator(finance);
    await writeJson("finance", finance);
    return result;
  });
  return financeQueue;
}

function withSettings(mutator) {
  settingsQueue = settingsQueue.then(async () => {
    const settings = await getSettings();
    const result = await mutator(settings);
    await writeJson("settings", settings);
    return result;
  });
  return settingsQueue;
}

function withItRequests(mutator) {
  itRequestsQueue = itRequestsQueue.then(async () => {
    const list = await getItRequests();
    const result = await mutator(list);
    await writeJson("it_requests", list);
    return result;
  });
  return itRequestsQueue;
}

function withItNotebook(mutator) {
  itNotebookQueue = itNotebookQueue.then(async () => {
    const nb = await getItNotebook();
    const result = await mutator(nb);
    await writeJson("it_notebook", nb);
    return result;
  });
  return itNotebookQueue;
}

function withSops(mutator) {
  sopsQueue = sopsQueue.then(async () => {
    const doc = await getSops();
    const result = await mutator(doc);
    await writeJson("sops", doc);
    return result;
  });
  return sopsQueue;
}

function withPerformance(mutator) {
  performanceQueue = performanceQueue.then(async () => {
    const doc = await getPerformance();
    const result = await mutator(doc);
    await writeJson("performance", doc);
    return result;
  });
  return performanceQueue;
}

function withQbr(mutator) {
  qbrQueue = qbrQueue.then(async () => {
    const doc = await getQbr();
    const result = await mutator(doc);
    await writeJson("qbr", doc);
    return result;
  });
  return qbrQueue;
}

function withMailIndex(mutator) {
  mailIndexQueue = mailIndexQueue.then(async () => {
    const doc = await getMailIndex();
    const result = await mutator(doc);
    await writeJson("mail_followups", doc);
    return result;
  });
  return mailIndexQueue;
}

function withInboxIgnored(mutator) {
  inboxIgnoredQueue = inboxIgnoredQueue.then(async () => {
    const doc = await getInboxIgnored();
    const result = await mutator(doc);
    await writeJson("inbox_ignored", doc);
    return result;
  });
  return inboxIgnoredQueue;
}

function withBoard(mutator, name = "aog_board") {
  boardQueue = boardQueue.then(async () => {
    const doc = await getBoard(name);
    const result = await mutator(doc);
    await writeJson(name, doc);
    return result;
  });
  return boardQueue;
}

function withStaffForms(mutator) {
  staffFormsQueue = staffFormsQueue.then(async () => {
    const doc = await getStaffForms();
    if (!Array.isArray(doc.items)) doc.items = [];
    const result = await mutator(doc);
    await writeJson("staff_forms", doc);
    return result;
  });
  return staffFormsQueue;
}

function withPayroll(mutator) {
  payrollQueue = payrollQueue.then(async () => {
    const doc = await getPayroll();
    const result = await mutator(doc);
    await writeJson("payroll", doc);
    return result;
  });
  return payrollQueue;
}

function withPeople(mutator) {
  peopleQueue = peopleQueue.then(async () => {
    const doc = await getPeople();
    const result = await mutator(doc);
    await writeJson("people", doc);
    return result;
  });
  return peopleQueue;
}

function withDocuments(mutator) {
  documentsQueue = documentsQueue.then(async () => {
    const doc = await getDocuments();
    const result = await mutator(doc);
    await writeJson("documents", doc);
    return result;
  });
  return documentsQueue;
}

function withLegal(mutator) {
  legalQueue = legalQueue.then(async () => {
    const doc = await getLegal();
    const result = await mutator(doc);
    await writeJson("legal", doc);
    return result;
  });
  return legalQueue;
}

function withStrategy(mutator) {
  strategyQueue = strategyQueue.then(async () => {
    const doc = await getStrategy();
    const result = await mutator(doc);
    await writeJson("strategy", doc);
    return result;
  });
  return strategyQueue;
}

function withImprovements(mutator) {
  improvementsQueue = improvementsQueue.then(async () => {
    const doc = await getImprovements();
    const result = await mutator(doc);
    await writeJson("improvements", doc);
    return result;
  });
  return improvementsQueue;
}

module.exports = {
  getImprovements,
  withImprovements,
  getStrategy,
  withStrategy,
  getLegal,
  withLegal,
  getDocuments,
  withDocuments,
  getStaffForms,
  withStaffForms,
  getPayroll,
  withPayroll,
  getPeople,
  withPeople,
  getBoard,
  withBoard,
  getMailIndex,
  withMailIndex,
  getInboxIgnored,
  withInboxIgnored,
  getQbr,
  withQbr,
  getPerformance,
  withPerformance,
  getSops,
  withSops,
  putFile,
  getFile,
  deleteFile,
  getItNotebook,
  withItNotebook,
  getItRequests,
  withItRequests,
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
};
