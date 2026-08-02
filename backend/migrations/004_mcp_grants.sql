-- 004_mcp_grants.sql
-- Folder-scoped MCP write ACL with a two-tier model.
-- Tier 1 = create + update (default); Tier 2 = create + update + move + delete.
-- Grant resolution is recursive: writes at path P succeed if any ancestor
-- folder has a grant. Backend resolves via prefix walk in
-- internal/mcp/acl.go.
--
-- Filesystem is the source of truth (DATA-01); this table is part of
-- the derived index, NOT a primary record. Wiping it is recoverable
-- via wizard re-grant. Per STRICT mode + CHECK constraint, malformed
-- writes are caught at the DB layer (defense-in-depth alongside
-- app-layer validation).

CREATE TABLE mcp_write_grants (
    id           INTEGER PRIMARY KEY,
    folder_path  TEXT    NOT NULL UNIQUE,                     -- canonical NFC+lowercase rel path under notes/ (DATA-11)
    level        INTEGER NOT NULL CHECK (level IN (1, 2)),    -- two-tier model
    granted_at   INTEGER NOT NULL,                            -- UNIX seconds
    granted_via  TEXT    NOT NULL DEFAULT 'tree-menu'         -- 'wizard' | 'tree-context-menu' | 'tree-dropdown-menu'
) STRICT;

CREATE INDEX idx_mcp_grants_folder ON mcp_write_grants(folder_path);
