package api

import (
	"context"
	"path/filepath"

	"github.com/matthewoden/jasper/backend/internal/buildinfo"
	"github.com/matthewoden/jasper/backend/internal/config"
	"github.com/matthewoden/jasper/backend/internal/index"
)

// GetVaultAbout implements GET /api/v1/vault/about. Assembles every
// About-pane fact server-side in one response (D-22): the client never
// walks the tree itself.
//
// Follows GetAdminStatus's shape: gate each subsystem-dependent field
// behind a nil/cast check and degrade to zero rather than 500. A subsystem
// failure is logged via s.log.Error; the response is still 200 unless
// something genuinely unrecoverable happens (there is no such path today).
//
//nolint:revive // generated interface name (capital Id-style is upstream)
func (s *Server) GetVaultAbout(
	ctx context.Context,
	_ GetVaultAboutRequestObject,
) (GetVaultAboutResponseObject, error) {
	out := GetVaultAbout200JSONResponse{
		VaultName:  filepath.Base(s.dataDir),
		Path:       s.dataDir,
		AppVersion: buildinfo.Version,
	}

	if s.index != nil {
		summaries, err := s.index.List(ctx)
		if err != nil {
			s.log.Error("GetVaultAbout: index.List failed", "err", err)
		} else {
			out.NoteCount = len(summaries)
		}

		if idx, ok := s.index.(*index.Indexer); ok && idx != nil {
			tree, err := idx.BuildTree(ctx)
			if err != nil {
				s.log.Error("GetVaultAbout: BuildTree failed", "err", err)
			} else {
				out.FolderCount = countFolders(tree.Root)
			}
		}
	}

	mcpPort := config.Defaults().MCP.Port
	if cfg, err := config.Load(s.dataDir, s.log); err != nil {
		s.log.Error("GetVaultAbout: config.Load failed", "dataDir", s.dataDir, "err", err)
	} else {
		mcpPort = cfg.MCP.Port
	}
	out.McpPort = mcpPort

	if s.mcpACL != nil {
		grants, err := s.mcpACL.List(ctx)
		if err != nil {
			s.log.Error("GetVaultAbout: mcpACL.List failed", "err", err)
		} else {
			out.McpGrantCount = len(grants)
		}
	}

	return out, nil
}

// countFolders recursively counts folder nodes in a tree projection. The
// implicit vault root (tree.Root's own container) is never a node itself,
// so it is not counted — only TreeNode entries whose Folder is non-nil are.
func countFolders(nodes []index.TreeNode) int {
	count := 0
	for _, n := range nodes {
		if n.Folder == nil {
			continue
		}
		count++
		count += countFolders(n.Folder.Children)
	}
	return count
}
