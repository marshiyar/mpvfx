import { readdirSync, readFileSync, existsSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, relative, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../studio/package.json", import.meta.url));
const ts = require("typescript");

const roots = ["shared", "runtime", "desktop", "src"];
const allowed = {
  shared: new Set(["shared"]),
  runtime: new Set(["runtime", "shared"]),
  desktop: new Set(["desktop", "runtime", "shared"]),
  src: new Set(["src", "shared"]),
};
const nodeModules = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const sourceExtension = /\.[cm]?[jt]sx?$/;
const isTest = (path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
const normalize = (path) => path.replaceAll("\\", "/");

/** Read imports, re-exports, import types, require and literal dynamic imports. */
export function dependencies(source, file = "source.ts") {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const result = [];
  function visit(node) {
    let value;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) value = node.moduleSpecifier;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) value = node.argument.literal;
    else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")
    )) value = node.arguments[0];
    if (value && ts.isStringLiteralLike(value)) result.push(value.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}

/** Pure so boundary rules can be tested without touching a teammate's checkout. */
export function checkDependency(file, specifier) {
  const owner = file.split("/")[0];
  if (!allowed[owner]) return null;
  if (!specifier.startsWith(".")) {
    if (owner === "shared") {
      // Only the export preset adapter uses the browser-safe parser package.
      if (file === "shared/export/exportPolicy.ts" && specifier === "@hyperframes/parsers") return null;
      return `${file}: shared rules cannot depend on ${specifier}`;
    }
    if (owner === "src" && (specifier.startsWith("node:") || nodeModules.has(specifier) || specifier === "electron")) {
      return `${file}: Electron renderer code cannot depend on ${specifier}`;
    }
    if (owner === "runtime" && ["electron", "react", "react-dom", "vite"].includes(specifier)) {
      return `${file}: local runtime must be independent of ${specifier}`;
    }
    // Relative imports are the only supported way to cross local source areas.
    if (/^(?:@\/|~\/|src\/|runtime\/|server\/|desktop\/|shared\/|mpvfx(?:\/|$))/.test(specifier)) {
      return `${file}: use a relative import so the local dependency boundary is explicit (${specifier})`;
    }
    return null;
  }
  const target = normalize(relative("/project", resolve("/project", dirname(file), specifier)));
  const targetOwner = target.split("/")[0];
  if (!allowed[owner].has(targetOwner)) {
    return `${file} -> ${specifier}: ${owner} may depend only on ${[...allowed[owner]].join(", ")}`;
  }
  if (owner === "desktop" && targetOwner === "runtime" && !/^runtime\/(index|environment|projects)(?:\.[jt]s)?$/.test(target)) {
    return `${file} -> ${specifier}: desktop must use a public runtime entry (index, environment, projects)`;
  }
  return null;
}

export function inspectArchitecture(root) {
  const problems = [];
  let files = 0;
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (sourceExtension.test(path) && !isTest(path) && !path.endsWith(".d.ts")) {
        const file = normalize(relative(root, path));
        files++;
        for (const specifier of dependencies(readFileSync(path, "utf8"), file)) {
          const problem = checkDependency(file, specifier);
          if (problem) problems.push(problem);
          if (specifier.startsWith(".")) {
            const target = resolve(dirname(path), specifier);
            const base = /\.[cm]?js$/.test(target) ? target.slice(0, -extname(target).length) : target;
            const candidates = [target, ...[".ts", ".tsx", ".js", ".json", "/index.ts", "/index.tsx"].map((suffix) => base + suffix)];
            if (!candidates.some(existsSync)) problems.push(`${file}: unresolved local dependency ${specifier}`);
          }
        }
      }
    }
  }
  for (const name of roots) {
    const path = resolve(root, name);
    if (!existsSync(path)) problems.push(`Missing owned source area: ${name}/`);
    else visit(path);
  }
  for (const retired of ["src/hooks", "src/utils", "src/components/editor"]) {
    if (existsSync(resolve(root, retired))) problems.push(`${retired}: place editor behavior in its owning feature`);
  }
  for (const entry of readdirSync(root)) {
    if (sourceExtension.test(entry) && !isTest(entry) && !entry.includes("config") && entry !== ".puppeteerrc.cjs") {
      problems.push(`${entry}: runtime source belongs in runtime/, shared/, desktop/, or src/`);
    }
  }
  return { files, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../studio");
  const { files, problems } = inspectArchitecture(root);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else console.log(`Architecture boundaries passed (${files} source files).`);
}
