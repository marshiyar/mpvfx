import { parseHTML } from "linkedom";

/** Parse source without browser media objects, and retain every fragment sibling. */
export function parseSourceDocument(source: string): Document {
  const document = parseHTML(source).document;
  const nodes = [...document.childNodes];
  const topElement = (name: string) => nodes.find(
    (node) => node.nodeType === 1 && (node as Element).localName === name,
  ) as Element | undefined;
  const existingRoot = topElement("html");
  const root = existingRoot ?? document.createElement("html");
  if (!existingRoot) {
    root.append(
      topElement("head") ?? document.createElement("head"),
      topElement("body") ?? document.createElement("body"),
    );
    document.append(root);
  }
  // Linkedom preserves siblings outside a full html root. Include them in the
  // comparison surface too, or a trailing node's text change would be missed.
  const head = root.querySelector(":scope > head") ?? document.createElement("head");
  const body = root.querySelector(":scope > body") ?? document.createElement("body");
  if (head.parentNode !== root) root.prepend(head);
  if (body.parentNode !== root) root.append(body);
  const firstBodyNode = body.firstChild;
  const rootIndex = nodes.indexOf(root);
  for (const [index, node] of nodes.entries()) {
    if (node === root || node === head || node === body || node.nodeType === 10) continue;
    if (existingRoot && index < rootIndex) {
      body.insertBefore(node, firstBodyNode);
    } else body.append(node);
  }
  return document;
}
