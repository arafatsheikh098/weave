import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { lintGutter } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.tagName], color: "var(--tok-keyword)", fontWeight: "600" },
  { tag: [t.function(t.variableName), t.macroName, t.atom], color: "var(--tok-command)" },
  { tag: t.comment, color: "var(--tok-comment)", fontStyle: "italic" },
  { tag: [t.string, t.special(t.string)], color: "var(--tok-string)" },
  { tag: [t.number, t.bool], color: "var(--tok-number)" },
  { tag: [t.bracket, t.brace, t.paren, t.squareBracket], color: "var(--tok-bracket)" },
  { tag: t.heading, color: "var(--tok-heading)", fontWeight: "700" },
  { tag: t.heading1, fontSize: "1.25em" },
  { tag: t.heading2, fontSize: "1.12em" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.link, color: "var(--accent-ink)", textDecoration: "underline" },
  { tag: t.monospace, color: "var(--tok-string)" },
  { tag: t.meta, color: "var(--tok-comment)" },
]);

const ENVIRONMENTS = [
  "document", "abstract", "itemize", "enumerate", "description", "equation", "equation*", "align", "align*",
  "figure", "table", "tabular", "center", "frame", "block", "theorem", "proof", "lemma", "verbatim", "lstlisting",
  "minipage", "columns", "column", "thebibliography", "quote",
];
const COMMANDS: [string, string][] = [
  ["section{}", "Section"], ["subsection{}", "Subsection"], ["subsubsection{}", "Subsubsection"], ["paragraph{}", "Paragraph"],
  ["textbf{}", "Bold"], ["textit{}", "Italic"], ["emph{}", "Emphasis"], ["underline{}", "Underline"], ["texttt{}", "Monospace"],
  ["cite{}", "Citation"], ["ref{}", "Reference"], ["eqref{}", "Equation reference"], ["label{}", "Label"],
  ["includegraphics[width=\\linewidth]{}", "Image"], ["caption{}", "Caption"], ["footnote{}", "Footnote"],
  ["frac{}{}", "Fraction"], ["sqrt{}", "Square root"], ["sum_{}^{}", "Sum"], ["int_{}^{}", "Integral"],
  ["usepackage{}", "Package"], ["documentclass{}", "Document class"], ["title{}", "Title"], ["author{}", "Author"],
  ["maketitle", "Title block"], ["tableofcontents", "Table of contents"], ["item ", "List item"], ["hline", "Table rule"],
  ["url{}", "URL"], ["href{}{}", "Link"], ["newpage", "New page"], ["bibliography{}", "Bibliography"],
  ["alpha", "α"], ["beta", "β"], ["gamma", "γ"], ["delta", "δ"], ["lambda", "λ"], ["mu", "μ"], ["pi", "π"], ["sigma", "σ"],
  ["theta", "θ"], ["infty", "∞"], ["leq", "≤"], ["geq", "≥"], ["neq", "≠"], ["cdot", "·"], ["times", "×"], ["rightarrow", "→"],
];

function latexCompletions(ctx: CompletionContext): CompletionResult | null {
  const begin = ctx.matchBefore(/\\begin\{[\w*]*/);
  if (begin) {
    return {
      from: begin.from + 7,
      options: ENVIRONMENTS.map((env) => ({
        label: env,
        type: "type",
        detail: "environment",
        apply: (view, _c, from, to) => {
          const insert = `${env}}\n  \n\\end{${env}}`;
          view.dispatch({ changes: { from, to: Math.min(to + (view.state.sliceDoc(to, to + 1) === "}" ? 1 : 0), view.state.doc.length), insert }, selection: { anchor: from + env.length + 4 } });
        },
      })),
    };
  }
  const cmd = ctx.matchBefore(/\\[a-zA-Z]*/);
  if (!cmd || (cmd.from === cmd.to && !ctx.explicit)) return null;
  return {
    from: cmd.from + 1,
    options: [
      { label: "begin{}", detail: "Environment", type: "keyword", apply: "begin{" },
      ...COMMANDS.map(([snippet, detail]) => ({
        label: snippet.replace(/[{[].*$/, ""),
        detail,
        type: "function",
        apply: (view: EditorView, _c: unknown, from: number, to: number) => {
          const brace = snippet.indexOf("{");
          view.dispatch({
            changes: { from, to, insert: snippet },
            selection: { anchor: from + (brace >= 0 ? snippet.indexOf("{}") + 1 || brace + 1 : snippet.length) },
          });
        },
      })),
    ],
    validFor: /^[a-zA-Z]*$/,
  };
}

export function languageFor(path: string): Extension {
  if (/\.(md|markdown)$/i.test(path)) return markdown();
  if (/\.(tex|sty|cls|bib|bbl)$/i.test(path)) return [StreamLanguage.define(stex), autocompletion({ override: [latexCompletions] })];
  return [];
}

export const readOnlyCompartment = new Compartment();

export function baseExtensions(): Extension {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(highlight),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    lintGutter(),
    EditorView.lineWrapping,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...completionKeymap, indentWithTab]),
  ];
}
