// Turn TeX / Tectonic output into structured diagnostics: [{ file, line, message, level }].

const FILE_LINE = /^(?:error|warning): (.+?):(\d+): (.+)$/;
const TEX_ERROR = /^! (.+)$/;
const LINE_REF = /^l\.(\d+)/;
const OPEN_FILE = /\(\.?\/?([^\s()]+\.(?:tex|sty|cls|bib|bbl))/g;
const LATEX_WARNING = /^(?:LaTeX|Package \S+) Warning: (.+?)(?: on input line (\d+))?\.?$/;

/**
 * @param {string} stderr   Tectonic's console output
 * @param {string} log      the .log file (may be empty)
 * @param {string} main     main file name, used when TeX doesn't say which file
 * @param {Set<string>} projectFiles  paths that belong to the project (others are system files)
 */
export function parseDiagnostics(stderr, log, main, projectFiles = new Set([main])) {
  const out = [];
  const seen = new Set();
  const push = (d) => {
    // TeX and Tectonic report the same error with and without a trailing period.
    const key = `${d.level}|${d.file}|${d.line}|${d.message.replace(/\.$/, "")}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };

  // 1. Tectonic's own "error: file:line: message" lines.
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    const m = FILE_LINE.exec(line);
    if (m) {
      const file = normalise(m[1]);
      push({ file: projectFiles.has(file) ? file : main, line: Number(m[2]), message: m[3], level: raw.startsWith("warning") ? "warning" : "error" });
    }
  }

  // 2. Classic TeX "! message ... l.<n>" blocks in the log, attributed to the innermost open file.
  const lines = log.split("\n");
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    for (const m of text.matchAll(OPEN_FILE)) stack.push(normalise(m[1]));
    const closes = (text.match(/\)/g) || []).length - (text.match(/\(/g) || []).length;
    const err = TEX_ERROR.exec(text);
    if (err) {
      let lineNo = null;
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const l = LINE_REF.exec(lines[j]);
        if (l) {
          lineNo = Number(l[1]);
          break;
        }
      }
      const current = [...stack].reverse().find((f) => projectFiles.has(f)) ?? main;
      push({ file: current, line: lineNo, message: err[1], level: "error" });
    }
    const warn = LATEX_WARNING.exec(text.trim());
    if (warn) {
      const current = [...stack].reverse().find((f) => projectFiles.has(f)) ?? main;
      push({ file: current, line: warn[2] ? Number(warn[2]) : null, message: warn[1], level: "warning" });
    }
    for (let k = 0; k < closes && stack.length; k++) stack.pop();
  }
  return out;
}

function normalise(path) {
  return path.replace(/^\.\//, "").replace(/^\/.*\/work\//, "");
}
