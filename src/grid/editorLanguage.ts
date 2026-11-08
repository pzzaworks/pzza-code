import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { langs, loadLanguage } from "@uiw/codemirror-extensions-langs";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { http } from "@codemirror/legacy-modes/mode/http";
import { troff } from "@codemirror/legacy-modes/mode/troff";
import { ebnf } from "@codemirror/legacy-modes/mode/ebnf";

type LangKey = keyof typeof langs;

// Modes that codemirror-extensions-langs does not register under any key.
const EXTRA_MODES = {
  dockerfile: () => StreamLanguage.define(dockerFile),
  nginx: () => StreamLanguage.define(nginx),
  http: () => StreamLanguage.define(http),
  troff: () => StreamLanguage.define(troff),
  ebnf: () => StreamLanguage.define(ebnf),
} as const;
type ExtraKey = keyof typeof EXTRA_MODES;
export type EditorLanguageKey = LangKey | ExtraKey;

// Whole file names (lowercased) that say more than their extension, or have none.
const FILE_NAMES: Record<string, EditorLanguageKey> = {
  dockerfile: "dockerfile", containerfile: "dockerfile",
  makefile: "sh", gnumakefile: "sh", justfile: "sh", procfile: "sh",
  "cmakelists.txt": "cmake",
  gemfile: "rb", rakefile: "rb", podfile: "rb", vagrantfile: "rb", brewfile: "rb", fastfile: "rb", guardfile: "rb",
  jenkinsfile: "groovy",
  "cargo.lock": "toml", "yarn.lock": "yaml", "gemfile.lock": "text", pipfile: "toml", "poetry.lock": "toml", "uv.lock": "toml",
  "nginx.conf": "nginx",
  build: "BUILD", "build.bazel": "BUILD", workspace: "BUILD", "workspace.bazel": "BUILD", "module.bazel": "BUILD",
  ".gitignore": "sh", ".dockerignore": "sh", ".npmignore": "sh", ".prettierignore": "sh", ".eslintignore": "sh", ".gitattributes": "sh", ".gitmodules": "ini",
  ".bashrc": "sh", ".bash_profile": "sh", ".bash_aliases": "sh", ".zshrc": "sh", ".zprofile": "sh", ".zshenv": "sh", ".profile": "sh", ".envrc": "sh", ".inputrc": "sh",
  ".editorconfig": "ini", ".gitconfig": "ini", ".npmrc": "ini", ".yarnrc": "yaml", ".pylintrc": "ini", ".flake8": "ini",
  ".babelrc": "json", ".eslintrc": "json", ".prettierrc": "json", ".swcrc": "json", ".jshintrc": "json",
  ".vimrc": "sh", ".tmux.conf": "sh",
};

// Extensions (lowercased) that are not langs keys themselves, mapped to one that is.
const EXTENSIONS: Record<string, EditorLanguageKey> = {
  zsh: "sh", fish: "sh", bashrc: "sh", zshrc: "sh", command: "sh", tool: "sh", ebuild: "sh", mk: "sh", mak: "sh", just: "sh",
  env: "properties", envrc: "sh", dotenv: "properties",
  jsonc: "json", json5: "json", geojson: "json", topojson: "json", webmanifest: "json", har: "json", ipynb: "json", code_workspace: "json", babelrc: "json",
  mdx: "md", rmd: "md", mdown: "md", markdn: "md",
  yml: "yaml", cff: "yaml",
  htm: "html", xhtml: "html", astro: "html", ejs: "html", erb: "html", njk: "jinja2", twig: "jinja2", mustache: "hbs",
  plist: "xml", xaml: "xml", csproj: "xml", fsproj: "xml", vbproj: "xml", props: "xml", targets: "xml", xib: "xml", storyboard: "xml",
  resx: "xml", xlf: "xml", xliff: "xml", rss: "xml", atom: "xml", wsdl: "xml", kml: "xml", gpx: "xml", svg: "xml",
  conf: "ini", cnf: "ini", desktop: "ini", service: "ini", timer: "ini", socket: "ini", mount: "ini", reg: "ini", inf: "ini", gitconfig: "ini", editorconfig: "ini",
  pyi: "py", pyw: "py", rpy: "py", gyp: "py", bzl: "bzl", star: "bzl",
  rake: "rb", gemspec: "rb", ru: "rb", podspec: "rb", thor: "rb", jbuilder: "rb",
  h: "c", hh: "cpp", inl: "cpp", ipp: "cpp", tpp: "cpp", cu: "cpp", cuh: "cpp", metal: "cpp", ino: "ino",
  mjs: "js", cjs: "js", es6: "js", jsm: "js",
  mts: "ts", cts: "ts",
  sty: "tex", cls: "tex", bib: "tex", dtx: "tex", ins: "tex",
  sol: "solidity",
  psql: "sql", pgsql: "sql", mysql: "sql", ddl: "sql", dml: "sql", hql: "sql",
  gradle: "gradle", gvy: "groovy", gy: "groovy", groovy: "groovy",
  sc: "scala", sbt: "scala",
  hrl: "erl", escript: "erl",
  http: "http", rest: "http",
  dockerfile: "dockerfile", containerfile: "dockerfile",
  nginxconf: "nginx",
  man: "troff", roff: "troff", "1": "troff", "2": "troff", "3": "troff", "5": "troff", "7": "troff", "8": "troff",
  ebnf: "ebnf", bnf: "ebnf",
  lock: "json",
  bats: "sh", ksh: "ksh", csh: "sh", tcsh: "sh",
  cljs: "cljs", edn: "edn",
  ps1xml: "xml", psd1: "psd1", psm1: "psm1",
  vbs: "vbs", bas: "vb", frm: "vb",
  f03: "f95", f08: "f95", for: "for", ftn: "f90",
  lpr: "pas", dpr: "pas",
  hx: "hx", hxml: "hxml",
  lhs: "hs", hsc: "hs",
  fsx: "fs", fsi: "fs", ml: "ml", mli: "mli",
  txt: "text", text: "text", log: "text",
};

const hasLangKey = (key: string): key is LangKey => Object.prototype.hasOwnProperty.call(langs, key);
const isExtraKey = (key: string): key is ExtraKey => Object.prototype.hasOwnProperty.call(EXTRA_MODES, key);

// The highlighting language for a file path, by file name first, then by
// extension (raw when the library knows it, otherwise through the alias table).
// "Dockerfile.dev", "app.dockerfile" and "nginx.conf" style names resolve too.
export function editorLanguageKey(path: string): EditorLanguageKey | null {
  const name = (path.replace(/\/+$/, "").split("/").pop() ?? "").toLowerCase();
  if (!name) return null;
  const named = FILE_NAMES[name];
  if (named) return named;
  if (/^(docker|container)file[.-]/.test(name)) return "dockerfile";
  if (/^\.env(\..+)?$/.test(name)) return "properties";
  if (/^(makefile|gnumakefile)[.-]/.test(name)) return "sh";
  if (/\.(nginx|nginx\.conf)$/.test(name) || /^nginx[.-].*\.conf$/.test(name)) return "nginx";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 && !name.startsWith(".")) return null;
  const ext = name.slice(dot + 1);
  const alias = EXTENSIONS[ext];
  if (alias) return alias;
  if (hasLangKey(ext)) return ext;
  return null;
}

export function editorLanguage(path: string): Extension | null {
  const key = editorLanguageKey(path);
  if (!key) return null;
  if (isExtraKey(key)) return EXTRA_MODES[key]();
  return loadLanguage(key);
}
