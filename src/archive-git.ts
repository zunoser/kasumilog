import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  assertRawFetchMatchesRun,
  readRawCapture,
  validateRawRunManifest,
  type RawFetchManifest,
  type RawRunManifest,
} from "./raw.ts";

export interface ArchiveGitTarget {
  readonly repository: string;
  readonly rawRoot: string;
  readonly remote: string;
  readonly branch: string;
}

export interface ArchiveCommitResult {
  readonly commit: string;
  readonly changed: boolean;
}

const COMMIT = /^[0-9a-f]{40}$/;
const ALLOWED_RAW_PATH = /^data\/raw\/(objects|fetches|runs)\//;

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) accept(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new Error(`git ${args[0]} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

function assertTarget(target: ArchiveGitTarget): string {
  const repository = resolve(target.repository);
  const rawRoot = resolve(target.rawRoot);
  if (rawRoot !== join(repository, "data", "raw")) {
    throw new Error("Archive raw root must be <repository>/data/raw");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(target.branch) || target.branch.startsWith("-")) {
    throw new Error(`Invalid archive branch: ${target.branch}`);
  }
  if (!target.remote || target.remote.startsWith("-")) {
    throw new Error(`Invalid archive remote: ${target.remote}`);
  }
  return repository;
}

function repositoryPath(repository: string, path: string): string {
  const result = relative(repository, resolve(path)).split(sep).join("/");
  if (!ALLOWED_RAW_PATH.test(result)) {
    throw new Error(`Path is outside the raw archive allowlist: ${result}`);
  }
  return result;
}

async function currentBranch(repository: string): Promise<string> {
  return runGit(repository, ["branch", "--show-current"]);
}

export async function preflightArchiveTarget(target: ArchiveGitTarget): Promise<void> {
  const repository = assertTarget(target);
  if ((await currentBranch(repository)) !== target.branch) {
    throw new Error(`Archive worktree must be on branch ${target.branch}`);
  }
  await runGit(repository, ["remote", "get-url", target.remote]);
  const staged = await runGit(repository, ["diff", "--cached", "--name-only"]);
  if (staged) throw new Error(`Archive worktree has staged changes: ${staged}`);
  const rawChanges = await runGit(repository, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    "data/raw",
  ]);
  if (rawChanges) throw new Error("Archive raw directory has uncommitted changes");

  const remoteRef = await runGit(repository, [
    "ls-remote",
    "--heads",
    target.remote,
    `refs/heads/${target.branch}`,
  ]);
  if (!remoteRef) return;
  const localHead = await runGit(repository, ["rev-parse", "HEAD"]);
  const remoteHead = remoteRef.split(/\s+/)[0];
  if (localHead !== remoteHead) {
    throw new Error("Archive worktree HEAD does not match the remote archive branch");
  }
}

export async function commitAndPushArchivePaths(
  target: ArchiveGitTarget,
  paths: readonly string[],
  message: string,
): Promise<ArchiveCommitResult> {
  const repository = assertTarget(target);
  if ((await currentBranch(repository)) !== target.branch) {
    throw new Error(`Archive worktree must be on branch ${target.branch}`);
  }
  const relativePaths = [...new Set(paths.map((path) => repositoryPath(repository, path)))];
  if (relativePaths.length === 0) throw new Error("No archive paths to commit");

  await runGit(repository, ["add", "--", ...relativePaths]);
  const staged = (await runGit(repository, ["diff", "--cached", "--name-only", "-z"]))
    .split("\0")
    .filter(Boolean);
  const expected = new Set(relativePaths);
  const unexpected = staged.filter((path) => !expected.has(path) || !ALLOWED_RAW_PATH.test(path));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected staged archive paths: ${unexpected.join(", ")}`);
  }

  const changed = staged.length > 0;
  if (changed) {
    await runGit(repository, ["commit", "--no-gpg-sign", "-m", message]);
  }
  const commit = await runGit(repository, ["rev-parse", "HEAD"]);
  if (!COMMIT.test(commit)) throw new Error("Git did not return a commit SHA");
  await runGit(repository, ["push", target.remote, `HEAD:refs/heads/${target.branch}`]);
  return { commit, changed };
}

async function cloneRemote(target: ArchiveGitTarget): Promise<{ path: string; commit: string }> {
  const repository = assertTarget(target);
  const remoteUrl = await runGit(repository, ["remote", "get-url", target.remote]);
  const parent = await mkdtemp(join(tmpdir(), "kasumilog-verify-"));
  const path = join(parent, "archive");
  try {
    await runGit(parent, [
      "clone",
      "--quiet",
      "--single-branch",
      "--branch",
      target.branch,
      remoteUrl,
      path,
    ]);
    const commit = await runGit(path, ["rev-parse", "HEAD"]);
    return { path, commit };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyRemoteRawPage(
  target: ArchiveGitTarget,
  expectedCommit: string,
  fetchManifestPath: string,
): Promise<RawFetchManifest> {
  const repository = assertTarget(target);
  const manifestRelativePath = repositoryPath(repository, fetchManifestPath);
  const clone = await cloneRemote(target);
  try {
    if (clone.commit !== expectedCommit) {
      throw new Error("Remote archive head does not match the pushed page commit");
    }
    const manifest = JSON.parse(
      await readFile(join(clone.path, manifestRelativePath), "utf8"),
    ) as RawFetchManifest;
    await readRawCapture(join(clone.path, "data", "raw"), manifest);
    return manifest;
  } finally {
    await rm(dirname(clone.path), { recursive: true, force: true });
  }
}

export async function verifyRemoteRawRun(
  target: ArchiveGitTarget,
  expectedCommit: string,
  runManifestPath: string,
): Promise<RawRunManifest> {
  const repository = assertTarget(target);
  const manifestRelativePath = repositoryPath(repository, runManifestPath);
  const clone = await cloneRemote(target);
  try {
    if (clone.commit !== expectedCommit) {
      throw new Error("Remote archive head does not match the pushed run commit");
    }
    const manifest = validateRawRunManifest(
      JSON.parse(await readFile(join(clone.path, manifestRelativePath), "utf8")),
    );
    for (const page of manifest.pages) {
      await runGit(clone.path, [
        "merge-base",
        "--is-ancestor",
        page.verifiedCommit,
        clone.commit,
      ]);
      const fetchFiles = (await runGit(clone.path, [
        "ls-tree",
        "-r",
        "--name-only",
        page.verifiedCommit,
        "--",
        "data/raw/fetches",
      ]))
        .split("\n")
        .filter((path) => path.endsWith(`/${page.fetchId}.json`));
      if (fetchFiles.length !== 1) {
        throw new Error(`Remote run must contain one fetch ${page.fetchId}`);
      }
      await runGit(clone.path, ["checkout", "--quiet", "--detach", page.verifiedCommit]);
      const fetch = JSON.parse(
        await readFile(join(clone.path, fetchFiles[0]), "utf8"),
      ) as RawFetchManifest;
      assertRawFetchMatchesRun(fetch, manifest, page);
      await readRawCapture(join(clone.path, "data", "raw"), fetch);
    }
    return manifest;
  } finally {
    await rm(dirname(clone.path), { recursive: true, force: true });
  }
}
