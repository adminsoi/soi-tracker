// The Pentagon-backed lists on each department tab, in one place. The server
// uses this to decide who may run which query and to turn rows into board
// cards; the browser loads it from /api/pentagon-views to build the sub-tabs
// and tables. Add a view here once its query exists in Pentagon/Transmute.
//
// `fields` names the exact Pentagon column for each piece of the layout.
// Anything not named (or missing from the data) falls back to a best guess
// by name — see FIELD_GUESSES. `tasks: true` puts every row on that
// department's board as a card.

const PENTAGON_VIEWS = {
  Procurement: [
    {
      id: "rfqs", label: "RFQs", docLabel: "RFQ", queryName: "dashboards.rfq", layout: "doc", tasks: true,
      fields: { key: "RFQ_NO", part: "PN", party: "ACCOUNT_NAME", partyLabel: "Customer", person: "OURCONTACT", due: "DUE_DATE", notes: "NOTES", entered: "ENTER_DATE" },
    },
    {
      id: "quotes", label: "Quotes", docLabel: "Quote", queryName: "dashboards.quotes", layout: "doc", tasks: true,
      fields: { key: "QUOTE_NO", part: "PN", party: "ACCOUNT_NAME", partyLabel: "Customer", person: "OURCONTACT", due: "DUE_DATE", notes: "NOTES", entered: "ENTER_DATE" },
    },
  ],
  Purchasing: [
    {
      id: "sales_orders", label: "Sales Orders", docLabel: "SO", queryName: "dashboards.so", layout: "doc", tasks: true,
      fields: { key: "SO_NO", part: "PN", party: "ACCOUNT_NAME", partyLabel: "Customer", person: "OURCONTACT", due: "DUE_DATE", notes: "NOTES", entered: "ENTER_DATE" },
    },
    {
      id: "purchase_orders", label: "Purchase Orders", docLabel: "PO", queryName: "dashboards.po", layout: "doc", tasks: true,
      fields: { key: "PO_NO", part: "PN", party: "ACCOUNT_NAME", partyLabel: "Vendor", person: "OURCONTACT", due: "DUE_DATE", notes: "NOTES", entered: "ENTER_DATE" },
    },
  ],
  "Accounting & Finance": [
    { id: "invoices", label: "Invoices", docLabel: "Invoice", queryName: "dashboards.invoice_search", layout: "raw" },
  ],
};

// [exact names to try first, substrings to try after], per layout field.
const FIELD_GUESSES = {
  key: [["RFQ_NO", "QUOTE_NO", "QT_NO", "PO_NO", "SO_NO", "DOC_NO", "RFQ_NUMBER", "DOC_NUMBER"], ["_NO", "NUMBER"]],
  part: [["PN", "PART_NUMBER", "PART_NO", "PARTNO"], ["PART"]],
  party: [["ACCOUNT_NAME", "CUSTOMER", "CUSTOMER_NAME", "VENDOR", "VENDOR_NAME", "COMPANY_NAME"], ["ACCOUNT_NAME", "CUSTOMER", "VENDOR", "COMPANY"]],
  person: [["OURCONTACT", "BUYER", "SALESPERSON", "ENTERED_BY"], ["OURCONTACT", "BUYER", "SALES", "ENTERED_BY"]],
  due: [["DUE_DATE", "DATE_DUE", "REQUIRED_DATE"], ["DUE"]],
  notes: [["NOTES", "REMARKS", "COMMENTS"], ["NOTE", "REMARK", "COMMENT"]],
  entered: [["ENTER_DATE", "DOC_DATE"], ["DATE"]],
};

function allViews() {
  return Object.entries(PENTAGON_VIEWS).flatMap(([department, views]) =>
    views.map((v) => ({ ...v, department }))
  );
}

function viewById(id) {
  return allViews().find((v) => v.id === id) || null;
}

function viewByQuery(queryName) {
  return allViews().find((v) => v.queryName === queryName) || null;
}

/** Which Pentagon column holds `name` for this view, or null. */
function resolveField(view, row, name) {
  if (!row) return null;
  const keys = Object.keys(row);
  const named = view.fields && view.fields[name];
  if (named && keys.includes(named)) return named;
  const [exact, subs] = FIELD_GUESSES[name];
  for (const k of exact) if (keys.includes(k)) return k;
  for (const k of keys) {
    for (const s of subs) if (k.toUpperCase().includes(s)) return k;
  }
  return null;
}

/** RFQ marks keep their original plain key; other views are prefixed. */
function markKey(viewId, docNo) {
  return viewId === "rfqs" ? docNo : `${viewId}:${docNo}`;
}

/** Pentagon responses put records in `rows`, sometimes under result_sets[0]. */
function resultRows(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.rows)) return data.rows;
  if (data && Array.isArray(data.result_sets) && data.result_sets[0] && Array.isArray(data.result_sets[0].rows)) {
    return data.result_sets[0].rows;
  }
  return [];
}

module.exports = {
  PENTAGON_VIEWS,
  FIELD_GUESSES,
  allViews,
  viewById,
  viewByQuery,
  resolveField,
  markKey,
  resultRows,
};
