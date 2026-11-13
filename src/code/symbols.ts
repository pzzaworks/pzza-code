// The symbol outline of the open file, read from the syntax tree of its
// language (functions, classes, methods, interfaces and types, top-level
// constants; headings in Markdown). Languages without a usable tree fall back
// to a line scan for common declaration keywords.
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
// The node type of the trees @codemirror/language hands out.
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolve"]>;

export type SymbolKind = "function" | "method" | "class" | "interface" | "type" | "struct" | "enum" | "namespace" | "impl" | "constant" | "heading";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based line of the symbol's name. */
  line: number;
  /** Nesting under classes, namespaces and the like (heading level for Markdown). */
  depth: number;
}

const MAX_SYMBOLS = 2000;
const MAX_NAME = 120;

// Declaration nodes across the Lezer grammars the editor loads.
const DECLARATIONS: Record<string, SymbolKind> = {
  FunctionDeclaration: "function", FunctionDefinition: "function", FunctionItem: "function", FunctionDecl: "function",
  MethodDeclaration: "method", MethodDecl: "method", ConstructorDeclaration: "method",
  ClassDeclaration: "class", ClassDefinition: "class", ClassSpecifier: "class",
  InterfaceDeclaration: "interface", TraitItem: "interface", TraitDeclaration: "interface",
  TypeAliasDeclaration: "type", TypeItem: "type", TypeSpec: "type",
  StructItem: "struct", StructSpecifier: "struct", UnionItem: "struct", UnionSpecifier: "struct",
  EnumDeclaration: "enum", EnumItem: "enum", EnumSpecifier: "enum",
  NamespaceDeclaration: "namespace", NamespaceDefinition: "namespace", ModItem: "namespace", ModuleDeclaration: "namespace",
  ImplItem: "impl",
  ConstItem: "constant", StaticItem: "constant", ConstSpec: "constant", VariableDeclaration: "constant",
};
// Kinds whose members are listed under them.
const CONTAINERS = new Set<SymbolKind>(["class", "interface", "struct", "enum", "namespace", "impl"]);
// Child nodes that carry a declaration's name.
const NAMES = new Set([
  "VariableDefinition", "TypeDefinition", "PropertyDefinition", "PrivatePropertyDefinition", "VariableName", "BoundIdentifier",
  "TypeIdentifier", "DefName", "FieldName", "Definition", "Name", "Identifier", "FieldIdentifier", "ScopedIdentifier",
  "DestructorName", "OperatorName", "NamespaceIdentifier",
]);
// C and C++ type specifiers only declare something when they have a body.
const NEEDS_BODY: Record<string, string> = { ClassSpecifier: "FieldDeclarationList", StructSpecifier: "FieldDeclarationList", UnionSpecifier: "FieldDeclarationList", EnumSpecifier: "EnumeratorList" };
const TOP_LEVEL = new Set(["Script", "SourceFile", "Program", "Module"]);
const HEADING = /^(?:ATX|Setext)Heading([1-6])$/;

function nameNode(node: SyntaxNode): SyntaxNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (NAMES.has(child.name)) return child;
    // C/C++: the name sits in the declarator (`int Foo::bar()`).
    if (child.name.endsWith("Declarator")) {
      const inner = nameNode(child);
      if (inner) return inner;
    }
  }
  return null;
}

function isTopLevel(node: SyntaxNode): boolean {
  let parent = node.parent;
  // Go wraps specs in a declaration (`const ( ... )`), JS in an export.
  while (parent && (parent.name === "ExportDeclaration" || parent.name === "ConstDecl" || parent.name === "VarDecl")) parent = parent.parent;
  return !!parent && TOP_LEVEL.has(parent.name);
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);

function treeSymbols(state: EditorState): CodeSymbol[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 400) ?? syntaxTree(state);
  const symbols: CodeSymbol[] = [];
  const open: { from: number; to: number; name: string }[] = [];
  const text = (from: number, to: number) => state.doc.sliceString(from, to);
  const add = (name: string, kind: SymbolKind, at: number, depth = open.length) => {
    if (symbols.length < MAX_SYMBOLS && name) symbols.push({ name: clean(name), kind, line: state.doc.lineAt(at).number, depth });
  };
  tree.iterate({
    enter: (ref) => {
      if (symbols.length >= MAX_SYMBOLS) return false;
      const heading = HEADING.exec(ref.name);
      if (heading) {
        add(text(ref.from, ref.to).split("\n")[0].replace(/^\s*#+\s*/, "").replace(/\s+#+\s*$/, ""), "heading", ref.from, Number(heading[1]) - 1);
        return false;
      }
      let kind = DECLARATIONS[ref.name];
      if (!kind) return undefined;
      const node = ref.node;
      const body = NEEDS_BODY[ref.name];
      if (body && !node.getChild(body)) return undefined;
      if (kind === "constant") {
        // Only top-level bindings; a function bound to a name reads as a function.
        if (!isTopLevel(node) || (ref.name === "VariableDeclaration" && !/^const\b/.test(text(ref.from, ref.from + 6)))) return false;
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name !== "VariableDefinition" && child.name !== "BoundIdentifier" && child.name !== "DefName") continue;
          let value = child.nextSibling;
          while (value && (value.name === "Equals" || value.name === "TypeAnnotation")) value = value.nextSibling;
          add(text(child.from, child.to), value && /^(?:ArrowFunction|FunctionExpression)$/.test(value.name) ? "function" : "constant", child.from);
        }
        return false;
      }
      if (kind === "impl") {
        // `impl Trait for Type`: everything before the body names it.
        const list = node.getChild("DeclarationList");
        add(text(ref.from, list?.from ?? ref.to), "impl", ref.from);
      } else {
        const name = nameNode(node);
        if (!name) return undefined;
        if (kind === "function" && open.some((entry) => CONTAINERS.has(DECLARATIONS[entry.name]))) kind = "method";
        add(text(name.from, name.to), kind, name.from);
      }
      // Nothing inside a function body is part of the outline.
      if (kind === "function" || kind === "method") return false;
      if (CONTAINERS.has(kind)) open.push({ from: ref.from, to: ref.to, name: ref.name });
      return undefined;
    },
    leave: (ref) => {
      const top = open[open.length - 1];
      if (top && top.from === ref.from && top.to === ref.to && top.name === ref.name) open.pop();
    },
  });
  return symbols;
}

// Line-scan fallback: common declaration keywords, and Markdown headings
// outside fenced code.
const LINE_PATTERNS: [RegExp, SymbolKind][] = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$.:]+)/, "function"],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/, "class"],
  [/^\s*(?:async\s+)?def\s+([\w?!]+)/, "function"],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/, "function"],
  [/^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/, "function"],
  [/^\s*(?:export\s+)?(?:interface|trait|protocol)\s+(\w+)/, "interface"],
  [/^\s*(?:export\s+)?(?:pub\s+)?(?:struct|record)\s+(\w+)/, "struct"],
  [/^\s*(?:export\s+)?(?:pub\s+)?enum\s+(\w+)/, "enum"],
  [/^\s*(?:export\s+)?type\s+(\w+)/, "type"],
  [/^\s*(?:module|namespace)\s+([\w.:]+)/, "namespace"],
  [/^\s*(?:function\s+)?([\w-]+)\s*\(\)\s*\{/, "function"],
];

export function lineSymbols(text: string, markdown: boolean): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = text.split("\n");
  let fence: string | null = null;
  for (let index = 0; index < lines.length && symbols.length < MAX_SYMBOLS; index++) {
    const line = lines[index];
    if (markdown) {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && (!fence || marker.startsWith(fence))) { fence = fence ? null : marker; continue; }
      if (fence) continue;
      const heading = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
      if (heading) symbols.push({ name: clean(heading[2]), kind: "heading", line: index + 1, depth: heading[1].length - 1 });
      continue;
    }
    for (const [pattern, kind] of LINE_PATTERNS) {
      const name = pattern.exec(line)?.[1];
      if (!name) continue;
      symbols.push({ name: clean(name), kind, line: index + 1, depth: line.length > line.trimStart().length ? 1 : 0 });
      break;
    }
  }
  return symbols;
}

/** The outline of `state`, from its syntax tree when that has any, else a line scan. */
export function extractSymbols(state: EditorState, path: string): CodeSymbol[] {
  const fromTree = treeSymbols(state);
  if (fromTree.length) return fromTree;
  return lineSymbols(state.doc.toString(), /\.(?:md|markdown|mdx)$/i.test(path));
}
