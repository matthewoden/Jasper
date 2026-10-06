// Command compose-check composes Jasper's subgraph with the shell subgraph
// vendored from graphos, through the composer graphos's gateway uses. It is
// its own module so the composer's JS runtime stays out of Jasper's go.mod.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	composition "github.com/wundergraph/cosmo/composition-go"
)

// The same strip graphos's compose applies: composition-go cannot parse
// @link, and Cosmo treats the federation directives as built-in.
var linkDirective = regexp.MustCompile(`(?s)(extend\s+)?schema\s*(@link\s*\([^)]*\)\s*)+(?:\{\s*\})?`)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: compose-check <api/graphql dir>")
		os.Exit(2)
	}
	if err := run(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, "compose-check:", err)
		os.Exit(1)
	}
}

func run(dir string) error {
	jasper, err := readJoined(filepath.Join(dir, "schema.graphqls"))
	if err != nil {
		return err
	}
	shell, err := readJoined(
		filepath.Join(dir, "graphos", "item.graphql"),
		filepath.Join(dir, "graphos", "shell", "stubs.graphql"),
		filepath.Join(dir, "graphos", "shell", "schema.graphql"),
	)
	if err != nil {
		return err
	}
	subs := []*composition.Subgraph{
		{Name: "shell", URL: "http://127.0.0.1:6690/graphql", Schema: shell},
		{Name: "jasper", URL: "http://127.0.0.1:6683/graphql", Schema: linkDirective.ReplaceAllString(jasper, "")},
	}
	fed, err := composition.Federate(subs...)
	if err != nil {
		return fmt.Errorf("jasper does not compose with the shell: %w", err)
	}
	if _, err := composition.BuildRouterConfiguration(subs...); err != nil {
		return fmt.Errorf("router configuration: %w", err)
	}
	for _, want := range []string{
		"item(id: ID!): Item",
		"jasperItem(id: ID!): Item",
		"jasperSearch(q: String!, limit: Int = 20): [Item!]\n",
		"jasperBacklinks(id: ID!): [Backlink!]\n",
		"type Note implements Item",
		"type Workspace implements",
	} {
		if !strings.Contains(fed.SDL, want) {
			return fmt.Errorf("supergraph lacks %q", strings.TrimSpace(want))
		}
	}
	commit, _ := os.ReadFile(filepath.Join(dir, "graphos", "COMMIT"))
	fmt.Printf("composed jasper with the shell from graphos %.12s: supergraph %d bytes\n", commit, len(fed.SDL))
	return nil
}

func readJoined(paths ...string) (string, error) {
	var b strings.Builder
	for _, p := range paths {
		raw, err := os.ReadFile(p)
		if err != nil {
			return "", err
		}
		b.Write(raw)
		b.WriteString("\n")
	}
	return b.String(), nil
}
