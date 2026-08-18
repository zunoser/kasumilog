import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { collectFixturePage } from "../src/fixture-collector.ts";
import { recoverArchiveState } from "../src/raw.ts";

const run = promisify(execFile);
const fixturePath = resolve("test/fixtures/list-timeline-page.capture.json");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run("git", args, { cwd });
  return result.stdout.trim();
}

async function createArchiveRepository(root: string): Promise<{
  repository: string;
  remote: string;
}> {
  const remote = join(root, "archive.git");
  const repository = join(root, "writer");
  await git(root, "init", "--bare", remote);
  await mkdir(repository);
  await git(repository, "init", "--initial-branch=archive");
  await git(repository, "config", "user.name", "kasumilog test");
  await git(repository, "config", "user.email", "kasumilog@example.invalid");
  await git(repository, "remote", "add", "origin", remote);
  return { repository, remote };
}

test("fixture collection commits raw page and run, verifies remote, and recovers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kasumilog-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repository, remote } = await createArchiveRepository(root);
  const options = {
    fixturePath,
    repository,
    rawRoot: join(repository, "data", "raw"),
    remote: "origin",
    branch: "archive",
  } as const;

  const first = await collectFixturePage(options);
  assert.equal(first.idempotent, false);
  assert.match(first.pageCommit, /^[0-9a-f]{40}$/);
  assert.match(first.runCommit, /^[0-9a-f]{40}$/);
  assert.notEqual(first.pageCommit, first.runCommit);
  assert.equal(await git(repository, "rev-list", "--count", "HEAD"), "2");

  const verifier = join(root, "verifier");
  await git(root, "clone", "--quiet", "--branch", "archive", remote, verifier);
  const recovered = await recoverArchiveState(join(verifier, "data", "raw"));
  assert.equal(recovered.latestCompleteRun?.runId, "fixture-run-1");
  assert.equal(recovered.latestCompleteRun?.pages[0]?.verifiedCommit, first.pageCommit);
  assert.equal(recovered.notBefore, "2026-08-18T00:00:31.000Z");

  const tracked = await git(verifier, "ls-files");
  assert.match(tracked, /data\/raw\/objects\/sha256\//);
  assert.match(tracked, /data\/raw\/fetches\//);
  assert.match(tracked, /data\/raw\/runs\//);
  assert.doesNotMatch(tracked, /normalized|sqlite|state\//);
  const fetchPath = tracked.split("\n").find((path) => path.includes("/fetches/"));
  assert.ok(fetchPath);
  assert.doesNotMatch(await readFile(join(verifier, fetchPath), "utf8"), /fixture-secret/);

  const second = await collectFixturePage(options);
  assert.equal(second.idempotent, true);
  assert.equal(second.pageCommit, first.pageCommit);
  assert.equal(second.runCommit, first.runCommit);
  assert.equal(await git(repository, "rev-list", "--count", "HEAD"), "2");

  const changedFixture = JSON.parse(await readFile(fixturePath, "utf8"));
  changedFixture.run.coverageFrontier.tweetIds = ["different"];
  const changedFixturePath = join(root, "changed-fixture.json");
  changedFixture.capture.response.bodyFile = resolve(
    "test/fixtures/list-timeline-page.body.json",
  );
  await writeFile(changedFixturePath, `${JSON.stringify(changedFixture, null, 2)}\n`);
  await assert.rejects(
    collectFixturePage({ ...options, fixturePath: changedFixturePath }),
    /Immutable file conflict/,
  );
});

test("an unrelated staged file prevents an archive commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kasumilog-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repository } = await createArchiveRepository(root);
  await writeFile(join(repository, "unexpected.txt"), "must not be committed\n");
  await git(repository, "add", "unexpected.txt");

  await assert.rejects(
    collectFixturePage({
      fixturePath,
      repository,
      rawRoot: join(repository, "data", "raw"),
      remote: "origin",
      branch: "archive",
    }),
    /Unexpected staged archive paths: unexpected.txt/,
  );
  assert.equal(await git(repository, "rev-list", "--count", "HEAD").catch(() => "0"), "0");
});

test("non-JSON bytes survive the remote Git round trip", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kasumilog-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { repository, remote } = await createArchiveRepository(root);
  const fixtureDirectory = join(root, "fixture");
  await mkdir(fixtureDirectory);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  fixture.capture.fetchId = "binary-fetch-1";
  fixture.capture.runId = "binary-run-1";
  fixture.capture.response.bodyFile = "body.bin";
  const binaryBody = Uint8Array.from([0xff, 0xfe, 0x00, 0x7b, 0x0a]);
  await writeFile(join(fixtureDirectory, "body.bin"), binaryBody);
  const binaryFixture = join(fixtureDirectory, "capture.json");
  await writeFile(binaryFixture, `${JSON.stringify(fixture, null, 2)}\n`);

  await collectFixturePage({
    fixturePath: binaryFixture,
    repository,
    rawRoot: join(repository, "data", "raw"),
    remote: "origin",
    branch: "archive",
  });
  const verifier = join(root, "verifier-binary");
  await git(root, "clone", "--quiet", "--branch", "archive", remote, verifier);
  const objectPath = (await git(verifier, "ls-files"))
    .split("\n")
    .find((path) => path.includes("/objects/"));
  assert.ok(objectPath);
  assert.deepEqual(await readFile(join(verifier, objectPath)), Buffer.from(binaryBody));
});
