package graphql

import (
	"context"
	"net/http"
	"time"

	"github.com/99designs/gqlgen/graphql"
	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/99designs/gqlgen/graphql/handler/lru"
	"github.com/99designs/gqlgen/graphql/handler/transport"
	coderws "github.com/coder/websocket"
	"github.com/vektah/gqlparser/v2/ast"
	"github.com/vektah/gqlparser/v2/gqlerror"

	"github.com/matthewoden/jasper/backend/internal/graphql/generated"
)

// NewHandler serves the subgraph over POST and graphql-transport-ws. There
// is deliberately no GET transport: a query must not be reachable from a
// cross-site <img> or link. originHosts are the host[:port] values a
// websocket upgrade may carry as its Origin.
func NewHandler(r *Resolver, originHosts []string) http.Handler {
	srv := handler.New(generated.NewExecutableSchema(generated.Config{Resolvers: r}))
	srv.AddTransport(transport.Websocket{
		KeepAlivePingInterval: 10 * time.Second,
		Implementation: transport.CoderWebsocketImplementation{
			AcceptOptions: coderws.AcceptOptions{OriginPatterns: originHosts},
		},
	})
	srv.AddTransport(transport.POST{})
	srv.SetQueryCache(lru.New[*ast.QueryDocument](256))
	srv.Use(serviceSDLOnly{})
	return srv
}

// serviceSDLOnly keeps schema introspection off but lets a router fetch the
// subgraph's SDL through _service, which gqlgen gates on the same switch.
// That SDL is already public in api/graphql.
type serviceSDLOnly struct{}

func (serviceSDLOnly) ExtensionName() string { return "ServiceSDLOnly" }

func (serviceSDLOnly) Validate(graphql.ExecutableSchema) error { return nil }

func (serviceSDLOnly) MutateOperationContext(_ context.Context, opCtx *graphql.OperationContext) *gqlerror.Error {
	opCtx.DisableIntrospection = !onlyServiceSDL(opCtx.Operation)
	return nil
}

func onlyServiceSDL(op *ast.OperationDefinition) bool {
	if op == nil || op.Operation != ast.Query || len(op.SelectionSet) == 0 {
		return false
	}
	for _, sel := range op.SelectionSet {
		f, ok := sel.(*ast.Field)
		if !ok || (f.Name != "_service" && f.Name != "__typename") {
			return false
		}
	}
	return true
}
