/**
 * task-doc.ts — fixture strings for taskCheckboxPlugin tests.
 *
 * GFM TaskList parse-probe verified node positions:
 *   - TaskMarker covers exactly 3 chars: "[ ]" or "[x]" or "[X]"
 *   - Space after marker is at TaskMarker.to
 *   - Task text starts at TaskMarker.to + 1
 *   - Task.to = end of line content (no trailing newline)
 *   - Widget replace range: [TaskMarker.from .. TaskMarker.to + 1]
 *   - Strikethrough mark range: [TaskMarker.to + 1 .. Task.to]
 */

/** Single unchecked task: TaskMarker.from = 2, stateChar at pos 3 = ' ' */
export const UNCHECKED_TASK_DOC = "- [ ] task";

/** Single checked task (lowercase x): TaskMarker.from = 2, stateChar at pos 3 = 'x' */
export const CHECKED_LOWER_TASK_DOC = "- [x] task";

/** Single checked task (uppercase X): TaskMarker.from = 2, stateChar at pos 3 = 'X' */
export const CHECKED_UPPER_TASK_DOC = "- [X] task";

/** Asterisk bullet unchecked task: TaskMarker.from = 2 */
export const ASTERISK_TASK_DOC = "* [ ] asterisk task";

/** Plus bullet unchecked task: TaskMarker.from = 2 */
export const PLUS_TASK_DOC = "+ [ ] plus task";

/** Ordered-list unchecked task: TaskMarker.from = 3 */
export const ORDERED_TASK_DOC = "1. [ ] ordered task";

/** Nested task list: parent at line 1, child at line 2 (indented) */
export const NESTED_TASK_DOC = "- [ ] parent\n  - [ ] child";

/** Multi-task doc with parent and checked child */
export const PARENT_CHECKED_CHILD_DOC = "- [x] parent\n  - [ ] child";
