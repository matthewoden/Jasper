// Package graphql is the federation subgraph: Jasper read by id over
// GraphQL, mounted at /graphql on the main listener. The schema lives at
// api/graphql/schema.graphqls; generated code is committed and drift-checked.
package graphql

//go:generate go tool gqlgen generate --config gqlgen.yml
