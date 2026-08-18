import { readFile } from "node:fs/promises";

import { catalog } from "../src/catalog.ts";
import { syncListMembers } from "../src/list-member-sync.ts";
import { createRelayRequestCatalog } from "../src/relay.ts";
import { hasReviewedRelayOverride } from "../src/relay-overrides.ts";

const LIST_ID = "2089423174601670906";
const REQUEST_CATALOG_REVISION = "a4d8b5f92874f593272e3c61427c61754cde6103";
const requestCatalogPath = process.argv[2];
if (!requestCatalogPath) {
  throw new Error("usage: sync-list-members.ts /path/to/requests.ndjson");
}
if (!hasReviewedRelayOverride("ListRemoveMember")) {
  throw new Error("ListRemoveMember requires a reviewed local request override");
}

const requestCatalog = createRelayRequestCatalog(
  await readFile(requestCatalogPath, "utf8"),
  REQUEST_CATALOG_REVISION,
);
const result = await syncListMembers(
  {
    catalog,
    requestCatalog,
    listId: LIST_ID,
    profileName: "account2",
  },
  { onProgress: (message) => console.log(message) },
);
console.log(JSON.stringify(result));
