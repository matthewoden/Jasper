/**
 * Barrel re-exporting the sectioned Settings dialog shell under the name its
 * call sites already import (`SettingsDialog`), so `SettingsMenu.tsx` and
 * `ActivityRibbon.tsx` need no prop-contract changes — only the import path.
 */
export { SettingsDialogShell as SettingsDialog } from "./SettingsDialogShell";
export type { SettingsDialogShellProps as SettingsDialogProps } from "./SettingsDialogShell";
