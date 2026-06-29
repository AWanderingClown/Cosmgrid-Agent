import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export const cosmgridCodeTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "rgba(0, 0, 0, 0.22)",
    color: "var(--foreground)",
    fontSize: "12px",
  },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  ".cm-content": {
    padding: "12px 0",
  },
  ".cm-line": {
    padding: "0 12px",
  },
  ".cm-gutters": {
    backgroundColor: "rgba(0, 0, 0, 0.28)",
    color: "rgba(255,255,255,0.32)",
    borderRight: "1px solid rgba(255,255,255,0.06)",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(96, 165, 250, 0.06)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "rgba(96, 165, 250, 0.08)",
  },
  "&.cm-focused": {
    outline: "none",
  },
}, { dark: true });

const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#c084fc" },
  { tag: [t.string, t.special(t.string)], color: "#86efac" },
  { tag: t.number, color: "#fbbf24" },
  { tag: t.comment, color: "#71717a", fontStyle: "italic" },
  { tag: t.function(t.variableName), color: "#60a5fa" },
  { tag: t.typeName, color: "#22d3ee" },
  { tag: t.variableName, color: "#e4e4e7" },
]);

export const cosmgridSyntax = syntaxHighlighting(highlightStyle);
