package notes

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"strings"

	"github.com/google/uuid"

	"github.com/matthewoden/jasper/backend/internal/markdown"
)

// relocateAttachments carries the attachments a note references from its old
// folder's attachments/ directory into its new folder's, so the note's
// folder-relative reference text still names a real file after the move.
//
// The files move rather than the references being rewritten because a rewrite
// cannot work here: the reference is written folder-relative but *served*
// against the note's current parent, and the serving route takes a bare
// filename, so there is no text that would resolve. A ../old/attachments/x.png
// would also stop rendering in every other markdown tool, which is the
// portability the filesystem-as-source-of-truth invariant exists to protect.
//
// Returns rewritten content only when a destination name was already taken and
// a -N suffix had to be issued; nil means the note on disk is still correct.
// On any error every completed file operation is undone before returning.
func (s *Service) relocateAttachments(
	ctx context.Context,
	id uuid.UUID,
	content []byte,
	oldRelPath, newRelPath string,
) ([]byte, error) {
	oldFolder, newFolder := folderOf(oldRelPath), folderOf(newRelPath)
	if oldFolder == newFolder {
		return nil, nil
	}

	refs := markdown.ExtractAttachmentRefs(content)
	if len(refs) == 0 {
		return nil, nil
	}

	shared := s.attachmentRefsHeldInFolder(ctx, id, oldFolder)

	var undo []func()
	fail := func(err error) ([]byte, error) {
		for i := len(undo) - 1; i >= 0; i-- {
			undo[i]()
		}
		return nil, err
	}

	rewrites := make(map[string]string)
	for _, ref := range refs {
		src := joinRel(oldFolder, ref)
		if _, err := s.files.Stat(src); err != nil {
			// Already dangling before the move; relocating nothing is the
			// honest outcome and the reference is no worse off.
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return fail(fmt.Errorf("relocateAttachments: stat %q: %w", src, err))
		}

		dstDir := joinRel(newFolder, path.Dir(ref))
		if err := s.ensureDir(dstDir); err != nil {
			return fail(err)
		}

		dstRef, err := s.freeAttachmentRef(newFolder, ref)
		if err != nil {
			return fail(err)
		}
		dst := joinRel(newFolder, dstRef)

		if shared[ref] {
			data, readErr := s.files.Read(src)
			if readErr != nil {
				return fail(fmt.Errorf("relocateAttachments: read %q: %w", src, readErr))
			}
			if writeErr := s.files.WriteAtomic(dst, data); writeErr != nil {
				return fail(fmt.Errorf("relocateAttachments: write %q: %w", dst, writeErr))
			}
			undo = append(undo, func() {
				if err := s.files.DeleteFile(dst); err != nil {
					s.log.Warn("relocateAttachments: undo of copy failed (reconciler will heal)",
						"path", dst, "err", err)
				}
			})
		} else {
			if err := s.files.MoveFile(src, dst); err != nil {
				return fail(fmt.Errorf("relocateAttachments: move %q→%q: %w", src, dst, err))
			}
			undo = append(undo, func() {
				if err := s.files.MoveFile(dst, src); err != nil {
					s.log.Warn("relocateAttachments: undo of move failed (reconciler will heal)",
						"from", dst, "to", src, "err", err)
				}
			})
		}

		if dstRef != ref {
			rewrites[ref] = dstRef
		}
	}

	if len(rewrites) == 0 {
		return nil, nil
	}

	rewritten := content
	for from, to := range rewrites {
		rewritten = rewriteAttachmentRef(rewritten, from, to)
	}
	return rewritten, nil
}

// attachmentRefsHeldInFolder returns the attachment references still claimed by
// notes other than exclude that live directly in folder. An attachments/
// directory is shared by every note in its folder, so a file one of them still
// embeds must be copied to the moving note's destination rather than moved out
// from under it.
func (s *Service) attachmentRefsHeldInFolder(
	ctx context.Context,
	exclude uuid.UUID,
	folder string,
) map[string]bool {
	held := make(map[string]bool)

	summaries, err := s.index.List(ctx)
	if err != nil {
		// Without the list we cannot tell shared from exclusive. Treat every
		// reference as shared: a duplicated file is recoverable, a sibling
		// whose image vanished is not.
		s.log.Warn("relocateAttachments: index list failed; copying every attachment instead of moving",
			"folder", folder, "err", err)
		return nil
	}

	for _, sum := range summaries {
		if sum.ID == exclude || folderOf(sum.Path) != folder {
			continue
		}
		data, readErr := s.files.Read(sum.Path)
		if readErr != nil {
			s.log.Warn("relocateAttachments: could not read sibling note; assuming it holds its attachments",
				"path", sum.Path, "err", readErr)
			continue
		}
		for _, ref := range markdown.ExtractAttachmentRefs(data) {
			held[ref] = true
		}
	}

	return held
}

func (s *Service) ensureDir(relPath string) error {
	if _, err := s.files.Stat(relPath); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("relocateAttachments: stat dir %q: %w", relPath, err)
	}
	if err := s.files.CreateDir(relPath); err != nil {
		return fmt.Errorf("relocateAttachments: create dir %q: %w", relPath, err)
	}
	return nil
}

// freeAttachmentRef returns ref, or ref with a -N suffix on its basename when
// the destination folder already holds that name.
func (s *Service) freeAttachmentRef(newFolder, ref string) (string, error) {
	if _, err := s.files.Stat(joinRel(newFolder, ref)); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ref, nil
		}
		return "", fmt.Errorf("relocateAttachments: stat dest %q: %w", ref, err)
	}

	dir, base := path.Dir(ref), path.Base(ref)
	ext := path.Ext(base)
	stem := strings.TrimSuffix(base, ext)

	for i := 1; i < 1000; i++ {
		candidate := path.Join(dir, fmt.Sprintf("%s-%d%s", stem, i, ext))
		if _, err := s.files.Stat(joinRel(newFolder, candidate)); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return candidate, nil
			}
			return "", fmt.Errorf("relocateAttachments: stat dest %q: %w", candidate, err)
		}
	}
	return "", fmt.Errorf("relocateAttachments: no free name for %q in %q", ref, newFolder)
}

// rewriteAttachmentRef swaps a reference inside ( ) delimiters only, so prose
// that happens to contain the same text is left alone.
func rewriteAttachmentRef(content []byte, from, to string) []byte {
	return []byte(strings.ReplaceAll(string(content), "("+from+")", "("+to+")"))
}

func folderOf(relPath string) string {
	d := path.Dir(relPath)
	if d == "." || d == "/" {
		return ""
	}
	return d
}

func joinRel(folder, rest string) string {
	if folder == "" || rest == "." {
		if rest == "." {
			return folder
		}
		return rest
	}
	return folder + "/" + rest
}
