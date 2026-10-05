package graphql

import (
	"net/http"
	"time"

	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/99designs/gqlgen/graphql/handler/extension"
	"github.com/99designs/gqlgen/graphql/handler/lru"
	"github.com/99designs/gqlgen/graphql/handler/transport"
	coderws "github.com/coder/websocket"
	"github.com/vektah/gqlparser/v2/ast"

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
	srv.Use(extension.Introspection{})
	return srv
}
