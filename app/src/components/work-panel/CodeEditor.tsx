import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { cosmgridCodeTheme, cosmgridSyntax } from "./cm-theme";
import type { FileTab } from "./types";

function languageExtension(language: string) {
  switch (language) {
    case "typescript":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
      return javascript({ jsx: true });
    case "json":
      return json();
    case "markdown":
      return markdown();
    case "python":
      return python();
    case "css":
      return css();
    case "html":
      return html();
    default:
      return [];
  }
}

export function CodeEditor({ tab }: { tab: FileTab }) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastDocRef = useRef("");
  const extensions = useMemo(() => [
    lineNumbers(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    highlightSelectionMatches(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    cosmgridCodeTheme,
    cosmgridSyntax,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    languageExtension(tab.language),
  ], [tab.language]);

  useEffect(() => {
    if (!hostRef.current || viewRef.current) return;
    const state = EditorState.create({ doc: tab.content, extensions });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    lastDocRef.current = tab.content;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions, tab.content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || tab.content === lastDocRef.current) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: tab.content },
    });
    lastDocRef.current = tab.content;
  }, [tab.content]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden" role="application" aria-label={t("chat.workPanel.readOnlyCode")} />;
}
