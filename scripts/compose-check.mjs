// Composes Jasper's subgraph with the stub subgraphs under api/graphql/stubs
// using Apollo's composition library, the way a gateway would. Run through
// `make compose-check`, which installs the library into a scratch directory
// outside the repo; it is not part of the frontend's dependency set.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.join(process.env.COMPOSE_NODE_MODULES, "/"));
const { composeServices } = require("@apollo/composition");
const { parse } = require("graphql");

const root = process.argv[2];
const services = [
  { name: "jasper", typeDefs: parse(readFileSync(path.join(root, "schema.graphqls"), "utf8")) },
];
for (const f of readdirSync(path.join(root, "stubs")).sort()) {
  if (!f.endsWith(".graphqls")) continue;
  services.push({ name: f.replace(/\.graphqls$/, ""), typeDefs: parse(readFileSync(path.join(root, "stubs", f), "utf8")) });
}

const result = composeServices(services);
if (result.errors) {
  console.error(`composition FAILED with ${services.map((s) => s.name).join(", ")}:`);
  for (const e of result.errors) console.error(" - " + e.message);
  process.exit(1);
}
const sdl = result.supergraphSdl;
const implementers = (sdl.match(/implements Item/g) ?? []).length;
console.log(`composed ${services.map((s) => s.name).join(", ")}: supergraph ${sdl.length} bytes, ${implementers} Item implementers`);
if (implementers < 4) {
  console.error("expected Note, Blob, ForeignRef, WorkItem and Task to implement Item in the supergraph");
  process.exit(1);
}
