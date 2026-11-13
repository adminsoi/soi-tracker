// Strategy Meeting → Workflows: plans drawn as a flowchart and seen as a
// phased roadmap. One workflow is { phases, nodes, edges }: each node (a
// step, decision, start/end or note) has a position on the canvas, a phase
// and a status; edges are arrows between nodes. The flowchart and the
// roadmap are two views of the same nodes. This file is the rules (shape
// and limits); index.js has the routes; workflows.json holds
// { workflows: [...] }. Leadership only, like the rest of the Strategy
// Meeting. A map only for now: no owners, nothing on Mentions of You.

const { text } = require("./staffforms");

const SHAPES = ["step", "decision", "start", "end", "note"];
const STATUSES = ["todo", "doing", "done", "blocked"];
const MAX = { nodes: 300, edges: 600, phases: 20, workflows: 200 };
const num = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};
const id = (v) => String(v || "").replace(/[^\w-]/g, "").slice(0, 40);

function shape(doc) {
  doc.workflows = Array.isArray(doc.workflows) ? doc.workflows : [];
  return doc;
}

/** A new workflow: three phases and a Start box. */
function newWorkflow(b, by, newId, now) {
  const title = text(b.title, 120);
  if (!title) return { error: "Give the workflow a name" };
  const phases = ["Phase 1", "Phase 2", "Phase 3"].map((name) => ({ id: newId(), name }));
  return {
    workflow: {
      id: newId(), title, notes: "", phases,
      nodes: [{ id: newId(), label: "Start", shape: "start", phase: phases[0].id, status: "todo", x: 80, y: 120, notes: "" }],
      edges: [], createdBy: by, at: now, updatedBy: by, updatedAt: now, archived: false,
    },
  };
}

/**
 * The page sends the whole workflow after each change. Keep only what's
 * allowed: known shapes and statuses, edges between nodes that exist, nodes
 * pointing at phases that exist, and the limits above.
 */
function clean(b) {
  const phases = (Array.isArray(b.phases) ? b.phases : []).slice(0, MAX.phases)
    .map((p) => ({ id: id(p.id), name: text(p.name, 60) || "Phase" })).filter((p) => p.id);
  const phaseIds = new Set(phases.map((p) => p.id));
  const seen = new Set();
  const nodes = (Array.isArray(b.nodes) ? b.nodes : []).slice(0, MAX.nodes).map((n) => ({
    id: id(n.id),
    label: text(n.label, 120),
    shape: SHAPES.includes(n.shape) ? n.shape : "step",
    phase: phaseIds.has(n.phase) ? n.phase : "",
    status: STATUSES.includes(n.status) ? n.status : "todo",
    x: num(n.x, 0, 6000),
    y: num(n.y, 0, 4000),
    notes: String(n.notes || "").trim().slice(0, 1000),
  })).filter((n) => n.id && !seen.has(n.id) && seen.add(n.id));
  const pairs = new Set();
  const edges = (Array.isArray(b.edges) ? b.edges : []).slice(0, MAX.edges).map((e) => ({
    id: id(e.id), from: id(e.from), to: id(e.to), label: text(e.label, 60),
  })).filter((e) => {
    const k = e.from + ">" + e.to;
    if (!e.id || e.from === e.to || !seen.has(e.from) || !seen.has(e.to) || pairs.has(k)) return false;
    pairs.add(k);
    return true;
  });
  return { title: text(b.title, 120), notes: String(b.notes || "").trim().slice(0, 4000), phases, nodes, edges };
}

module.exports = { SHAPES, STATUSES, MAX, shape, newWorkflow, clean };
