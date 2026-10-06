-- 010_refs.sql — every reference a note makes, resolved.
--
-- One row per occurrence. target_ref is the universal form: a foreign ref
-- as written (ado:workitem/12345), jasper:note/<id> for a title link that
-- resolves, jasper:title/<title> for one that does not, jasper:blob/<id>
-- for an embed by id. Backlinks for any target, native or foreign, are a
-- lookup on idx_refs_target.
--
-- backlinks keeps the title-link rows the linked-mentions panel reads, with
-- their excerpts; both tables are filled from one walk in one transaction.
CREATE TABLE refs (
    id         INTEGER PRIMARY KEY,
    source_id  TEXT    NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    target_ref TEXT    NOT NULL,
    display    TEXT    NOT NULL DEFAULT '',
    position   INTEGER NOT NULL DEFAULT -1,
    embed      INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX idx_refs_target ON refs(target_ref);
CREATE INDEX idx_refs_source ON refs(source_id);
