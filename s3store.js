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
} = require("@aws-sdk/client-s3");

const REGION = process.env.AWS_REGION || "us-east-1";
const BUCKET = process.env.S3_BUCKET;
const PREFIX = (process.env.S3_PREFIX || "soi-tracker").replace(/\/+$/, "");

if (!BUCKET) {
  console.error("Missing required env var: S3_BUCKET");
  process.exit(1);
}

// Uses the AWS SDK's default credential chain: an attached EC2/ECS IAM
// role is picked up automatically with no extra config. If you're not
// running on AWS infra with a role attached, set AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY / AWS_REGION as env vars instead.
const s3 = new S3Client({ region: REGION });

function keyFor(name) {
  return `${PREFIX}/${name}.json`;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function readJson(name, fallback) {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: keyFor(name) })
    );
    const text = await streamToString(res.Body);
    return JSON.parse(text);
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (err.name === "NoSuchKey" || status === 404) {
      return fallback;
    }
    throw err;
  }
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
// Small app-wide settings edited from the admin page (Claude project links).
function getSettings() {
  return readJson("settings", {});
}

// In-process queues so concurrent requests to this same container don't
// clobber each other's read-modify-write cycle.
let usersQueue = Promise.resolve();
let tasksQueue = Promise.resolve();
let presetsQueue = Promise.resolve();
let rfqMarksQueue = Promise.resolve();
let settingsQueue = Promise.resolve();

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

function withSettings(mutator) {
  settingsQueue = settingsQueue.then(async () => {
    const settings = await getSettings();
    const result = await mutator(settings);
    await writeJson("settings", settings);
    return result;
  });
  return settingsQueue;
}

module.exports = {
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
};
