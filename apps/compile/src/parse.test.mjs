import { describe, expect, it } from "vitest";
import { parseDiagnostics } from "./parse.mjs";

describe("parseDiagnostics", () => {
  it("reads Tectonic's file:line errors", () => {
    const stderr = "note: Running TeX ...\nerror: main.tex:12: Undefined control sequence\nerror: halted on potentially-recoverable error as specified\n";
    expect(parseDiagnostics(stderr, "", "main.tex")).toEqual([
      { file: "main.tex", line: 12, message: "Undefined control sequence", level: "error" },
    ]);
  });

  it("attributes classic TeX errors to the innermost project file", () => {
    const log = [
      "(./main.tex (/usr/share/texmf/article.cls)",
      "(./chapters/intro.tex",
      "! Missing $ inserted.",
      "<inserted text>",
      "l.7 The value x_1",
      ")",
      "LaTeX Warning: Reference `fig:a' on page 1 undefined on input line 20.",
      ")",
    ].join("\n");
    const files = new Set(["main.tex", "chapters/intro.tex"]);
    expect(parseDiagnostics("", log, "main.tex", files)).toEqual([
      { file: "chapters/intro.tex", line: 7, message: "Missing $ inserted.", level: "error" },
      { file: "main.tex", line: 20, message: "Reference `fig:a' on page 1 undefined", level: "warning" },
    ]);
  });
});
