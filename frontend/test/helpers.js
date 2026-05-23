const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.disabled = false;
    this.href = "";
    this.id = "";
    this.style = {};
    this.textContent = "";
    this.title = "";
    this.type = "";
    this.value = "";
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  remove() {
    this.removed = true;
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "href") this.href = "";
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  async dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) {
      await listener(event);
    }
  }

  select() {
    this.selected = true;
  }

  get classList() {
    return {
      add: (...names) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) classes.add(name);
        this.className = Array.from(classes).join(" ");
      },
    };
  }
}

function createDocument(ids = []) {
  const elements = new Map(ids.map((id) => [id, new Element()]));
  for (const [id, element] of elements) element.id = id;

  return {
    body: new Element("body"),
    createElement: (tagName) => new Element(tagName),
    execCommand: () => true,
    getElementById: (id) => {
      if (!elements.has(id)) {
        const element = new Element();
        element.id = id;
        elements.set(id, element);
      }
      return elements.get(id);
    },
  };
}

function runScript(relativePath, context) {
  const filename = path.resolve(__dirname, "..", relativePath);
  const code = fs.readFileSync(filename, "utf8");
  vm.runInNewContext(code, context, { filename });
}

module.exports = { Element, createDocument, runScript };
