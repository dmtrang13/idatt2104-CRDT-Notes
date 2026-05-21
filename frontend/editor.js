class RgaText {
  constructor() {
    this.elements = new Map();
    this.deletes = new Map();
    this.deleteTargets = new Set();
  }

  apply(op) {
    if (op.type === "insert") {
      if (!this.elements.has(op.id)) {
        this.elements.set(op.id, {
          id: op.id,
          previous: op.previous || null,
          value: op.value,
          removed: this.deleteTargets.has(op.id),
        });
      }
    } else if (op.type === "delete") {
      this.deletes.set(op.id, { id: op.id, target: op.target });
      this.deleteTargets.add(op.target);
      const element = this.elements.get(op.target);
      if (element) element.removed = true;
    }
  }

  visibleElements() {
    const children = new Map();
    for (const element of this.elements.values()) {
      const key = element.previous || "ROOT";
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(element);
    }

    for (const siblings of children.values()) {
      siblings.sort((left, right) => compareOpId(right.id, left.id));
    }

    const result = [];
    const walk = (previous) => {
      const siblings = children.get(previous || "ROOT") || [];
      for (const element of siblings) {
        if (!element.removed) result.push(element);
        walk(element.id);
      }
    };
    walk(null);
    return result;
  }

  text() {
    return this.visibleElements()
      .map((element) => element.value)
      .join("");
  }

  idAt(index) {
    return this.visibleElements()[index]?.id || null;
  }

  columns() {
    const rows = ["type,op_id,ref_id,target_id,char,removed"];
    const elements = Array.from(this.elements.values()).sort((a, b) =>
      compareOpId(a.id, b.id)
    );
    for (const element of elements) {
      rows.push(
        `insert,${csvField(element.id)},${csvField(
          element.previous || "ROOT"
        )},,${csvField(element.value)},${element.removed}`
      );
    }
    const deletes = Array.from(this.deletes.values()).sort((a, b) =>
      compareOpId(a.id, b.id)
    );
    for (const deletion of deletes) {
      rows.push(
        `delete,${csvField(deletion.id)},,${csvField(deletion.target)},,true`
      );
    }
    return rows.join("\n");
  }
}

function csvField(value) {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function parseOpId(id) {
  const at = id.indexOf("@");
  return {
    counter: Number(id.slice(0, at)),
    replica: id.slice(at + 1),
  };
}

function compareOpId(left, right) {
  const a = parseOpId(left);
  const b = parseOpId(right);
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.replica.localeCompare(b.replica);
}

const replicaId =
  sessionStorage.getItem("crdt-replica-id") || crypto.randomUUID().slice(0, 8);
sessionStorage.setItem("crdt-replica-id", replicaId);

const urlParams = new URLSearchParams(location.search);
const documentId = urlParams.get("document_id") || urlParams.get("doc") || "default";
const wsPort = urlParams.get("ws_port") || "3001";

let counter = 0;
let localText = "";
let applyingRemote = false;
let batchingLocalOps = false;
const seenOps = new Set();
const pendingOps = new Map();
const rga = new RgaText();

const editor = document.getElementById("editor");
const ops = document.getElementById("ops");
const dot = document.getElementById("dot");
const status = document.getElementById("status");
const replica = document.getElementById("replica");
const counterEl = document.getElementById("counter");
const clientsEl = document.getElementById("clients");

function pendingStorageKey() {
  return `crdt-pending-ops:${documentId}:${replicaId}`;
}

function savePendingOps() {
  localStorage.setItem(
    pendingStorageKey(),
    JSON.stringify(Array.from(pendingOps.values()))
  );
}

function loadPendingOps() {
  try {
    const stored = JSON.parse(localStorage.getItem(pendingStorageKey()) || "[]");
    if (!Array.isArray(stored)) return;
    batchingLocalOps = true;
    for (const op of stored) {
      if (!op || typeof op.id !== "string") continue;
      pendingOps.set(op.id, op);
      applyAndRender(op);
    }
    batchingLocalOps = false;
  } catch {
    localStorage.removeItem(pendingStorageKey());
  }
}

function nextId() {
  counter += 1;
  return `${counter}@${replicaId}`;
}

function observe(id) {
  const parsed = parseOpId(id);
  if (Number.isFinite(parsed.counter)) {
    counter = Math.max(counter, parsed.counter);
  }
}

function applyAndRender(op) {
  if (seenOps.has(op.id)) return;
  seenOps.add(op.id);
  observe(op.id);
  rga.apply(op);
  if (!batchingLocalOps) render();
}

const socket = window.createCrdtSocket({
  documentId,
  wsPort,
  getKnownIds: () => Array.from(seenOps),
  onOpen() {
    dot.classList.add("open");
    status.textContent = "connected";
    flushPendingOps();
  },
  onClose() {
    dot.classList.remove("open");
  },
  onStatus(message) {
    status.textContent = message;
  },
  onSync(message) {
    for (const op of message.ops) applyAndRender(op);
    if (message.clients) clientsEl.textContent = `clients: ${message.clients}`;
  },
  onOp(op) {
    applyAndRender(op);
  },
  onError(message) {
    status.textContent = message;
  },
});

function send(op) {
  applyAndRender(op);
  if (!socket.sendOp(op)) {
    pendingOps.set(op.id, op);
    savePendingOps();
  }
}

function flushPendingOps() {
  if (!socket.isOpen()) return;
  for (const op of pendingOps.values()) socket.sendOp(op);
  pendingOps.clear();
  savePendingOps();
}

function render() {
  const text = rga.text();
  if (editor.value !== text) {
    const caret = editor.selectionStart;
    applyingRemote = true;
    editor.value = text;
    editor.selectionStart = editor.selectionEnd = Math.min(caret, text.length);
    applyingRemote = false;
  }
  localText = text;
  ops.textContent = rga.columns();
  replica.textContent = `document: ${documentId} | replica: ${replicaId}`;
  counterEl.textContent = `lamport: ${counter}`;
}

function lcsMatches(previous, next) {
  const rows = previous.length + 1;
  const cols = next.length + 1;
  const table = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = previous.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      table[i][j] =
        previous[i] === next[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const matches = [];
  let i = 0;
  let j = 0;
  while (i < previous.length && j < next.length) {
    if (previous[i] === next[j]) {
      matches.push({ oldIndex: i, newIndex: j });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return matches;
}

function planTextOperations(previous, next) {
  const visibleBefore = rga.visibleElements();
  const matches = lcsMatches(previous, next);
  const keptOldIndexes = new Set(matches.map((match) => match.oldIndex));
  const oldIndexByNewIndex = new Map(
    matches.map((match) => [match.newIndex, match.oldIndex])
  );
  const planned = [];

  for (let oldIndex = 0; oldIndex < visibleBefore.length; oldIndex++) {
    if (!keptOldIndexes.has(oldIndex)) {
      planned.push({
        type: "delete",
        id: nextId(),
        target: visibleBefore[oldIndex].id,
      });
    }
  }

  let previousId = null;
  for (let newIndex = 0; newIndex < next.length; newIndex++) {
    const keptOldIndex = oldIndexByNewIndex.get(newIndex);
    if (keptOldIndex !== undefined) {
      previousId = visibleBefore[keptOldIndex].id;
      continue;
    }

    const id = nextId();
    planned.push({
      type: "insert",
      id,
      previous: previousId,
      value: next[newIndex],
    });
    previousId = id;
  }
  return planned;
}

function diffAndSend(previous, next, selectionStart) {
  const planned = planTextOperations(previous, next);
  batchingLocalOps = true;
  for (const op of planned) send(op);
  batchingLocalOps = false;
  render();
  editor.selectionStart = editor.selectionEnd = selectionStart;
}

editor.addEventListener("input", () => {
  if (applyingRemote) return;
  diffAndSend(localText, editor.value, editor.selectionStart);
});

document.getElementById("clear").onclick = () => {
  const count = rga.visibleElements().length;
  for (let i = 0; i < count; i++) {
    const target = rga.idAt(0);
    if (target) send({ type: "delete", id: nextId(), target });
  }
};

setInterval(() => {
  if (socket.isOpen() && pendingOps.size > 0) {
    flushPendingOps();
    socket.requestSync();
  }
}, 3000);

loadPendingOps();
socket.connect();
render();
