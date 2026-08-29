# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

These are real labels on the `tracker` MCP server — set them with `create_issue`/`update_issue`'s `labels` field, or `bulk_update_issues`'s `add_labels`/`remove_labels` over a whole queue. `labels` **replaces** the set; the bulk pair changes only the names it lists. Call `list_labels` first and reuse the existing vocabulary — a typo shows up there as a label sitting at a count of one. A label name is lowercase letters and digits joined by single hyphens.

A label is the triage *role* — who the ticket waits on. It is independent of `status`, which is where the work is (`backlog` / `todo` / `in_progress` / `done` / `canceled`). A ticket can be `todo` and `needs-info`; clearing a role when a ticket closes is a courtesy to whoever reads the queue by label. See [`issue-tracker.md`](./issue-tracker.md).

`needs-design` also exists on the server, outside the five canonical roles: UI work whose visual design is not settled. Don't reach for it when a mock already exists.

Edit the right-hand column to match whatever vocabulary you actually use.
