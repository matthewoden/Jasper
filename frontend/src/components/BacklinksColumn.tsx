/**
 * Phase 1 placeholder for the future backlinks column. Renders nothing visible
 * — its purpose is to anchor the third grid track at width 0 (per UI-SPEC
 * §Layout Contract) so Phase 6 can fill the column without restructuring
 * App.tsx's grid template.
 */
export function BacklinksColumn() {
  return <aside aria-hidden="true" style={{ width: 0 }} />;
}
