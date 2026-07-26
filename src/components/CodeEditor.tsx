"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import type { BeforeMount, OnMount } from "@monaco-editor/react";

import type { Language } from "./api-client";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div aria-live="polite" className="editor-loading">
      <span className="pixel-loader" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <span>Loading editor core…</span>
    </div>
  ),
});

export function CodeEditor({
  language,
  onChange,
  onRun,
  onSubmit,
  readOnly = false,
  value,
}: {
  language: Language;
  onChange: (value: string) => void;
  onRun: () => void;
  onSubmit: () => void;
  readOnly?: boolean;
  value: string;
}) {
  const runRef = useRef(onRun);
  const submitRef = useRef(onSubmit);
  useEffect(() => {
    runRef.current = onRun;
  }, [onRun]);
  useEffect(() => {
    submitRef.current = onSubmit;
  }, [onSubmit]);

  const beforeMount: BeforeMount = (monaco) => {
    monaco.editor.defineTheme("circuit-pit", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6E7F83", fontStyle: "italic" },
        { token: "keyword", foreground: "F4A62A" },
        { token: "string", foreground: "8BD49C" },
        { token: "number", foreground: "35D3C7" },
        { token: "type", foreground: "65A8FF" },
      ],
      colors: {
        "editor.background": "#0D1117",
        "editor.foreground": "#EAF2E8",
        "editorCursor.foreground": "#F4A62A",
        "editor.lineHighlightBackground": "#111B26",
        "editorLineNumber.foreground": "#52616C",
        "editorLineNumber.activeForeground": "#B8C7C7",
        "editor.selectionBackground": "#245A62",
        "editor.inactiveSelectionBackground": "#183B41",
        "editorIndentGuide.background1": "#1F2A35",
        "editorIndentGuide.activeBackground1": "#485765",
        "editorWidget.background": "#111B26",
        "editorWidget.border": "#324150",
        "input.background": "#070B12",
        "input.border": "#324150",
        focusBorder: "#F4A62A",
      },
    });
  };

  const handleMount: OnMount = (editor, monaco) => {
    editor.addAction({
      id: "leetbattle-run-samples",
      label: "Run samples",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => runRef.current(),
    });
    editor.addAction({
      id: "leetbattle-submit",
      label: "Submit solution",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
      ],
      run: () => submitRef.current(),
    });
    editor.focus();
  };

  return (
    <MonacoEditor
      beforeMount={beforeMount}
      height="100%"
      language={language === "PYTHON" ? "python" : "java"}
      onChange={(next) => onChange(next ?? "")}
      onMount={handleMount}
      options={{
        accessibilitySupport: "auto",
        ariaLabel: `${language === "PYTHON" ? "Python" : "Java"} solution editor`,
        automaticLayout: true,
        bracketPairColorization: { enabled: true },
        cursorBlinking: "smooth",
        fontFamily: 'Monaco, Menlo, "Ubuntu Mono", Consolas, monospace',
        fontLigatures: false,
        fontSize: 14,
        lineHeight: 22,
        minimap: { enabled: false },
        padding: { top: 14, bottom: 14 },
        readOnly,
        renderLineHighlight: "line",
        roundedSelection: false,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 4,
        wordWrap: "off",
      }}
      theme="circuit-pit"
      value={value}
    />
  );
}
