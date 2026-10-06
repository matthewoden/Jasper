package graphql_test

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/vektah/gqlparser/v2/ast"
	"github.com/vektah/gqlparser/v2/formatter"
	"github.com/vektah/gqlparser/v2/parser"
)

// Every subgraph declares graphos's shared Item contract verbatim; a
// definition that differs, even in its description, stops the supergraph
// composing or drifts its documentation.
func TestSharedContractMatchesGraphos(t *testing.T) {
	apiDir := filepath.Join("..", "..", "..", "api", "graphql")
	shared := parseSDL(t, filepath.Join(apiDir, "graphos", "item.graphql"))
	jasper := parseSDL(t, filepath.Join(apiDir, "schema.graphqls"))

	for _, want := range shared.Definitions {
		got := jasper.Definitions.ForName(want.Name)
		if got == nil {
			t.Errorf("schema.graphqls lacks %s", want.Name)
			continue
		}
		if g, w := formatDef(got), formatDef(want); g != w {
			t.Errorf("%s differs from graphos:\n--- jasper\n%s--- graphos\n%s", want.Name, g, w)
		}
	}
}

func parseSDL(t *testing.T, path string) *ast.SchemaDocument {
	t.Helper()
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := parser.ParseSchema(&ast.Source{Name: path, Input: string(src)})
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return doc
}

func formatDef(def *ast.Definition) string {
	var buf bytes.Buffer
	formatter.NewFormatter(&buf).FormatSchemaDocument(&ast.SchemaDocument{Definitions: ast.DefinitionList{def}})
	return buf.String()
}
