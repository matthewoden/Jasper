import { BacklinksColumn } from "./components/BacklinksColumn";
import { EditorPane } from "./components/EditorPane";
import { Sidebar } from "./components/Sidebar";

/**
 * Phase 1 app shell. Three-column CSS grid locked by 01-UI-SPEC.md
 * §"Layout Contract":  260px (sidebar) | 1fr (editor) | 0 (backlinks slot).
 *
 * The third column track is reserved at width 0 so Phase 6 can populate
 * backlinks without restructuring this file. Sidebar stays a static row in
 * Phase 1; Phase 3 swaps in react-arborist behind the same column.
 */
export default function App() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "260px 1fr 0",
        minHeight: "100vh",
      }}
    >
      <Sidebar />
      <EditorPane />
      <BacklinksColumn />
    </div>
  );
}
