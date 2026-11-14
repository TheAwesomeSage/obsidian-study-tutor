// Assembles the SymPy runtime that ships inside the plugin, in vendor/pyodide/:
//
//   - the Pyodide core (Python 3.12 compiled to WebAssembly) from the pinned `pyodide` npm package
//   - the two pure-Python wheels SymPy needs, sympy and mpmath, from the Pyodide CDN for that same
//     version, each checked against the SHA-256 in Pyodide's own lock file
//   - bundle.json, listing every file with its SHA-256, which the plugin reads to load the bundle
//
// Files already present with the right hash are kept, so this runs offline once it has run once.
// The production build copies the folder into release/study-tutor/pyodide/.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const from = path.resolve("node_modules/pyodide");
const out = path.resolve("vendor/pyodide");
const CORE = ["pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
const PACKAGES = ["mpmath", "sympy"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

if (!fs.existsSync(path.join(from, "pyodide-lock.json"))) throw new Error("node_modules/pyodide is missing: run npm install first.");
const lock = JSON.parse(fs.readFileSync(path.join(from, "pyodide-lock.json"), "utf8"));
const version = lock.info?.version;
if (!version) throw new Error("pyodide-lock.json has no version.");
fs.mkdirSync(out, { recursive: true });

const files = {};
for (const name of CORE) {
  const data = fs.readFileSync(path.join(from, name));
  const target = path.join(out, name);
  if (!fs.existsSync(target) || sha256(fs.readFileSync(target)) !== sha256(data)) fs.writeFileSync(target, data);
  files[name] = sha256(data);
}

for (const pkg of PACKAGES) {
  const entry = lock.packages?.[pkg];
  if (!entry?.file_name || !entry?.sha256) throw new Error(`${pkg} is not in Pyodide ${version}'s lock file.`);
  const target = path.join(out, entry.file_name);
  if (!(fs.existsSync(target) && sha256(fs.readFileSync(target)) === entry.sha256)) {
    const url = `https://cdn.jsdelivr.net/pyodide/v${version}/full/${entry.file_name}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download ${url}: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    const got = sha256(data);
    if (got !== entry.sha256) throw new Error(`${entry.file_name}: SHA-256 ${got} does not match the lock file's ${entry.sha256}.`);
    fs.writeFileSync(target, data);
    console.log(`downloaded ${entry.file_name} (${mb(data.length)}), SHA-256 matches Pyodide's lock file`);
  }
  files[entry.file_name] = entry.sha256;
}

// Nothing else belongs in the folder: a stale wheel from another version would ship otherwise.
for (const f of fs.readdirSync(out)) if (f !== "bundle.json" && f !== "NOTICE.md" && !(f in files)) fs.rmSync(path.join(out, f));

const bundle = { pyodide: version, python: lock.info.python, packages: Object.fromEntries(PACKAGES.map((p) => [p, lock.packages[p].version])), files };
fs.writeFileSync(path.join(out, "bundle.json"), JSON.stringify(bundle, null, 2) + "\n");
// Where the redistributed files come from and under which licences (the wheels carry their own licence texts).
fs.writeFileSync(
  path.join(out, "NOTICE.md"),
  `# Bundled runtime\n\nThese files are redistributed unmodified so that Study Tutor can run SymPy offline.\n\n` +
    `- Pyodide ${version} (pyodide.js, pyodide.asm.js, pyodide.asm.wasm, pyodide-lock.json): https://github.com/pyodide/pyodide, Mozilla Public License 2.0 (the npm package's metadata says Apache-2.0).\n` +
    `- The Python ${lock.info.python} standard library (python_stdlib.zip), as built by Pyodide: https://www.python.org, Python Software Foundation License.\n` +
    `- SymPy ${bundle.packages.sympy} (${lock.packages.sympy.file_name}): https://www.sympy.org, BSD licence; its text is inside the wheel.\n` +
    `- mpmath ${bundle.packages.mpmath} (${lock.packages.mpmath.file_name}): https://mpmath.org, BSD licence; its text is inside the wheel.\n`,
);
const total = Object.keys(files).reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0);
console.log(`vendor/pyodide: Pyodide ${version} (Python ${lock.info.python}), sympy ${bundle.packages.sympy}, mpmath ${bundle.packages.mpmath}; ${Object.keys(files).length} files, ${mb(total)}`);
