import assert from "node:assert/strict";
import test from "node:test";

import { catalog } from "../src/catalog.ts";
import {
  createPostMetadata,
  validateCatalog,
  type Account,
  type Catalog,
} from "../src/model.ts";

const addedAccounts = [
  ["@gov_online", "461064204"],
  ["@JMA_kishou", "2923658012"],
  ["@FDMA_JAPAN", "137272821"],
  ["@JCG_koho", "2916368839"],
  ["@NTA_Japan", "236682791"],
  ["@MOJ_IMMI", "3720424033"],
  ["@jpo_NIPPON", "281874178"],
  ["@jftc", "2455900080"],
  ["@PPC_JPN", "1401738180202622982"],
  ["@gensiryokukisei", "719219671"],
] as const;

test("catalog references are internally consistent", () => {
  assert.doesNotThrow(() => validateCatalog(catalog));
  assert.equal(catalog.accounts.length, 29);

  for (const [handle, twitterId] of addedAccounts) {
    const account = catalog.accounts.find((candidate) => candidate.handle === handle);
    assert.equal(account?.twitterId, twitterId);
    assert.equal(account?.status, "active");
    assert.equal(account?.verifiedAt, "2026-08-17");
  }

  const takaichi = catalog.accounts.find(
    (candidate) => candidate.handle === "@takaichi_sanae",
  );
  assert.equal(takaichi?.twitterId, "218434058");
  assert.deepEqual(takaichi?.subjects, [
    {
      relation: "publisher",
      subject: { kind: "person", id: "sanae_takaichi" },
    },
    {
      relation: "personal",
      subject: { kind: "person", id: "sanae_takaichi" },
    },
  ]);
});

test("an institutional kantei post remains administration", () => {
  assert.deepEqual(
    createPostMetadata(catalog, {
      publisher: "twitter:412940784",
      publishedAt: "2026-08-17T12:00:00+09:00",
    }),
    {
      publisher: "twitter:412940784",
      originalPublisher: undefined,
      publishedAt: "2026-08-17T12:00:00+09:00",
      organization: "cabinet_secretariat",
      person: undefined,
      role: undefined,
      government: "japan",
      domain: "administration",
      classifiedBy: "account",
    },
  );
});

test("prime-minister attribution resolves the incumbent at publication time", () => {
  const ishibaPost = createPostMetadata(catalog, {
    publisher: "twitter:412940784",
    publishedAt: "2025-10-20T12:00:00+09:00",
    role: "prime_minister",
  });
  const takaichiPost = createPostMetadata(catalog, {
    publisher: "twitter:412940784",
    publishedAt: "2025-10-21T12:00:00+09:00",
    role: "prime_minister",
  });

  assert.equal(ishibaPost.person, "shigeru_ishiba");
  assert.equal(takaichiPost.person, "sanae_takaichi");
  assert.equal(takaichiPost.domain, "politics");
  assert.equal(takaichiPost.classifiedBy, "role");
});

test("manual classification and original publisher are preserved", () => {
  assert.deepEqual(
    createPostMetadata(catalog, {
      publisher: "twitter:412940784",
      originalPublisher: "twitter:303730149",
      publishedAt: "2026-08-17T12:00:00+09:00",
      domain: "politics",
    }),
    {
      publisher: "twitter:412940784",
      originalPublisher: "twitter:303730149",
      publishedAt: "2026-08-17T12:00:00+09:00",
      organization: "cabinet_secretariat",
      person: undefined,
      role: undefined,
      government: "japan",
      domain: "politics",
      classifiedBy: "manual",
    },
  );
});

test("personal accounts require an explicit domain", () => {
  const personalAccount: Account = {
    id: "twitter:1",
    network: "twitter",
    twitterId: "1",
    handle: "@example_person",
    displayName: "Example person",
    subjects: [
      {
        relation: "publisher",
        subject: { kind: "person", id: "sanae_takaichi" },
      },
      {
        relation: "personal",
        subject: { kind: "person", id: "sanae_takaichi" },
      },
    ],
    status: "active",
    verifiedAt: "2026-08-17",
  };
  const fixture: Catalog = {
    ...catalog,
    accounts: [...catalog.accounts, personalAccount],
  };

  assert.doesNotThrow(() => validateCatalog(fixture));
  assert.throws(
    () =>
      createPostMetadata(fixture, {
        publisher: personalAccount.id,
        publishedAt: "2026-08-17T12:00:00+09:00",
      }),
    /manual domain/,
  );
  assert.equal(
    createPostMetadata(fixture, {
      publisher: personalAccount.id,
      publishedAt: "2026-08-17T12:00:00+09:00",
      domain: "politics",
    }).classifiedBy,
    "manual",
  );
});

test("invalid references and overlapping role assignments are rejected", () => {
  assert.throws(
    () =>
      createPostMetadata(catalog, {
        publisher: "twitter:412940784",
        originalPublisher: "twitter:missing",
        publishedAt: "2026-08-17T12:00:00+09:00",
      }),
    /Unknown account/,
  );

  const fixture: Catalog = {
    ...catalog,
    roleAssignments: [
      ...catalog.roleAssignments,
      {
        person: "shigeru_ishiba",
        role: "prime_minister",
        validFrom: "2026-01-01T00:00:00+09:00",
      },
    ],
  };
  assert.throws(() => validateCatalog(fixture), /Overlapping role assignments/);
});
