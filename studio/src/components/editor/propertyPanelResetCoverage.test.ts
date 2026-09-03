import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const EDITOR_DIR = path.resolve(process.cwd(), "src/components/editor");

function productionTsxFiles(): string[] {
  return fs
    .readdirSync(EDITOR_DIR)
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .map((name) => path.join(EDITOR_DIR, name));
}

function attributeNames(node: ts.JsxAttributes, source: ts.SourceFile): Set<string> {
  return new Set(
    node.properties
      .filter(ts.isJsxAttribute)
      .map((attribute) => attribute.name.getText(source)),
  );
}

describe("property-panel reset coverage", () => {
  it("requires every shared slider caller to declare its reset behavior", () => {
    const missing: string[] = [];
    for (const file of productionTsxFiles()) {
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isJsxSelfClosingElement(node) &&
          ["FlatSlider", "SliderControl"].includes(node.tagName.getText(source)) &&
          !attributeNames(node.attributes, source).has("onReset")
        ) {
          missing.push(`${path.basename(file)}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(missing).toEqual([]);
  });

  it("requires every native range input in the editor to define double-click reset", () => {
    const missing: string[] = [];
    for (const file of productionTsxFiles()) {
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node) => {
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "input") {
          const attributes = attributeNames(node.attributes, source);
          const type = node.attributes.properties.find(
            (attribute): attribute is ts.JsxAttribute =>
              ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "type",
          )?.initializer;
          const isRange = Boolean(type && ts.isStringLiteral(type) && type.text === "range");
          if (isRange && !attributes.has("onDoubleClick")) {
            missing.push(
              `${path.basename(file)}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}`,
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(missing).toEqual([]);
  });

  it("requires every custom slider-like control in the editor to define double-click reset", () => {
    const missing: string[] = [];
    for (const file of productionTsxFiles()) {
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node) => {
        if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
          const role = node.attributes.properties.find(
            (attribute): attribute is ts.JsxAttribute =>
              ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "role",
          )?.initializer;
          const isSlider = Boolean(role && ts.isStringLiteral(role) && role.text === "slider");
          if (isSlider && !attributeNames(node.attributes, source).has("onDoubleClick")) {
            missing.push(
              `${path.basename(file)}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}`,
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(missing).toEqual([]);
  });
});
