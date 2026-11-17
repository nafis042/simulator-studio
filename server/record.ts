import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { run } from "./exec";
import { phoneRecord, phoneStopRecording } from "./phone";

const DIR = ".paseo/recordings";
// shortcut: a recording nobody stops ends after 5 minutes, so it can't fill the disk; make it a setting if longer ones are needed
const MAX_MS = 5 * 60_000;

interface Recording {
  file: string;
  // resolves once simctl captures, rejects if it never did
  started: Promise<ChildProcess>;
}
// shortcut: no unit test (the recorder is spawned here, not injected); checked by a scripted run against a simulator. Inject spawn to test it.
// shortcut: a daemon killed outright leaves simctl recording without the 5 minute cap; detach and track the pid if that matters
const running = new Map<string, Recording>();
// a recording that ended by itself (the 5 minutes): Stop still hands over its video
const finished = new Map<string, string>();

/** Local time as 2026-11-16-14-03-27, for a file name. */
const stamp = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, "-");

/** Keeps the videos out of git without touching the tracked .gitignore; does nothing outside a repository. */
async function ignore(directory: string): Promise<void> {
  const relative = await run("git", ["-C", directory, "rev-parse", "--git-path", "info/exclude"]);
  const exclude = path.resolve(directory, relative.trim());
  if ((await lstat(exclude).catch(() => null))?.isSymbolicLink()) return;
  const listed = await readFile(exclude, "utf8").catch(() => "");
  // any depth: the workspace may be a folder inside the repository
  if (!listed.includes(DIR)) await appendFile(exclude, `\n**/${DIR}/\n`);
}

const fileFor = (workspace: string, udid: string) =>
  // the end of the id: a phone's starts with the same digits as every other phone's
  path.join(workspace, DIR, `sim-${stamp()}-${udid.slice(-4)}.mp4`);

/** Makes the workspace's recordings folder, kept out of git. */
async function prepare(workspace: string): Promise<void> {
  // a repository can ship .paseo as a symlink: never create or write anything through it
  // shortcut: checked, then used; a process already running as the user could swap one in between. Open the folder by descriptor if that ever matters.
  for (const part of [".paseo", DIR])
    if ((await lstat(path.join(workspace, part)).catch(() => null))?.isSymbolicLink())
      throw new Error("The recordings folder points outside the workspace");
  await mkdir(path.join(workspace, DIR), { recursive: true });
  await ignore(workspace).catch(() => {});
}

async function begin(udid: string, entry: Recording, workspace: string): Promise<ChildProcess> {
  await prepare(workspace);
  // no --force: a file that somehow exists is an error, not overwritten
  const child = spawn("xcrun", ["simctl", "io", udid, "recordVideo", "--codec", "h264", entry.file], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let live = false;
  const timer = setTimeout(() => halt(child), MAX_MS);
  // simctl says "Recording started" on stderr once it captures; ending before that is a failure
  return new Promise<ChildProcess>((resolve, reject) => {
    const failed = (error: Error) => {
      clearTimeout(timer);
      if (running.get(udid) === entry) running.delete(udid);
      reject(error);
    };
    child.stderr.on(
      "data",
      (chunk: Buffer) => (stderr += chunk).includes("Recording started") && ((live = true), resolve(child)),
    );
    child.once("error", failed);
    child.once("exit", () => {
      if (live && running.get(udid) === entry) finished.set(udid, entry.file);
      failed(new Error(stderr.trim().split("\n").pop() || "Recording didn't start"));
    });
  });
}

/**
 * Records the simulator's screen into `<directory>/.paseo/recordings`, with Apple's own recorder.
 * While it already records (or is starting), this waits for that one instead of starting another.
 */
export function startRecording(udid: string, directory: string): Promise<unknown> {
  const existing = running.get(udid);
  if (existing) return existing.started;
  finished.delete(udid);
  const entry = { file: fileFor(directory, udid) } as Recording;
  // registered before the first await, so a second start can't slip in
  running.set(udid, entry);
  entry.started = begin(udid, entry, directory);
  // a start that failed before the recorder ran (mkdir, a symlink) frees the slot too
  entry.started.catch(() => running.get(udid) === entry && running.delete(udid));
  return entry.started;
}

/** Asks the recorder to finish its file; one that ignores that for 10 s is killed, so it can't hold the daemon. */
function halt(child: ChildProcess): Promise<unknown> {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGINT");
  const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
  return exited.finally(() => clearTimeout(force));
}

/** Stops the recording and returns the video's path once simctl has written it. */
export async function stopRecording(udid: string): Promise<string> {
  const entry = running.get(udid);
  const done = finished.get(udid);
  finished.delete(udid);
  if (!entry) {
    if (done) return done;
    throw new Error("Not recording");
  }
  const child = await entry.started;
  if (child.exitCode === null) await halt(child);
  finished.delete(udid);
  return entry.file;
}

// A cabled iPhone is recorded by its capture helper, into the helper's own temp folder: a separate
// app, it has no access to the workspace and never learns its path. The video is moved here on stop.
const phones = new Map<string, { workspace: string; file: string }>();

export async function startPhoneRecording(udid: string, workspace: string): Promise<void> {
  const known = phones.has(udid);
  // registered before the first await, so a second start can't slip in. One left by a recording
  // that hit the 5 minutes and was never stopped is replaced: this take belongs to this workspace.
  phones.set(udid, { workspace, file: fileFor(workspace, udid) });
  try {
    await prepare(workspace);
    await phoneRecord(udid);
  } catch (error) {
    if (!known) phones.delete(udid);
    throw error;
  }
}

export async function stopPhoneRecording(udid: string): Promise<string> {
  const entry = phones.get(udid);
  if (!entry) throw new Error("Not recording");
  phones.delete(udid);
  const temp = await phoneStopRecording(udid);
  // checked again: the folder could have been swapped for a symlink while recording
  await prepare(entry.workspace);
  // never over a file that somehow exists
  await copyFile(temp, entry.file, constants.COPYFILE_EXCL);
  await rm(temp, { force: true });
  return entry.file;
}

export const stopAllRecordings = () =>
  Promise.allSettled([
    ...[...running.keys()].map((udid) => stopRecording(udid)),
    ...[...phones.keys()].map((udid) => stopPhoneRecording(udid)),
  ]);
