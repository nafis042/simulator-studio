import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { LONG_PRESS_MS, type Device } from "../shared/contracts";
import { run, sleep } from "./exec";
import { NODE, NODE_ENV, PLUGIN_DIR, dependencyFile } from "./paths";
import { STATE_DIR } from "./state";

// A physical iPhone/iPad over a cable. The screen comes from a small helper app (phone-capture.swift)
// that sends JPEG frames over a Unix socket in an owner-only temp folder; touch goes through
// agent-device, which installs its runner app on the phone and takes about a second per action.

const AGENT_DEVICE = dependencyFile("agent-device", "bin/agent-device.mjs");
const SOURCE = path.join(PLUGIN_DIR, "server", "phone-capture.swift");
const APP = path.join(STATE_DIR, "PhoneCapture.app");
const MAX_MESSAGE = 32 * 1024 * 1024;

type Listed = Omit<Device, "owned" | "agentTools" | "error">;
interface CoreDevice {
  hardwareProperties: { udid: string; reality: string; deviceType: string; marketingName: string };
  deviceProperties: { name: string };
  connectionProperties: { tunnelState: string; transportType: string };
}

const phones = new Map<string, { name: string; wired: boolean }>();
let listed = { at: 0, list: [] as Listed[] };

// shortcut: devicectl marks these JSON keys deprecated; move to its `properties` when they go
export async function listPhones(): Promise<Listed[]> {
  try {
    const json = await run("xcrun", ["devicectl", "list", "devices", "--timeout", "6", "--json-output", "-"]);
    const { devices } = (JSON.parse(json) as { result: { devices: CoreDevice[] } }).result;
    const list = devices
      .filter(
        (d) =>
          // an entry without these (a new devicectl) is skipped, not fatal to the list
          d.hardwareProperties?.reality === "physical" &&
          /^(iPhone|iPad)$/.test(d.hardwareProperties.deviceType) &&
          d.connectionProperties &&
          d.deviceProperties,
      )
      .map((d): Listed => {
        const { udid, marketingName } = d.hardwareProperties;
        const wired = d.connectionProperties.transportType === "wired";
        const on = d.connectionProperties.tunnelState === "connected";
        phones.set(udid, { name: d.deviceProperties.name, wired });
        // no "iOS x.y" here: shared/select.ts reads versions from simulators' detail
        return {
          id: `ios:${udid}`,
          platform: "ios",
          name: d.deviceProperties.name,
          detail: on ? `${marketingName} · ${wired ? "USB" : "Wi-Fi"}` : marketingName,
          state: on ? "booted" : "shutdown",
          kind: "physical",
        };
      });
    listed = { at: Date.now(), list };
  } catch (error) {
    // a slow or failing devicectl keeps the last list for a while
    if (Date.now() - listed.at > 30_000) throw error;
  }
  return listed.list;
}

// --- the capture helper app: built on first use, again when its source changes ---

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.nafis042.simulator-studio.capture</string>
<key>CFBundleName</key><string>Simulator Studio Capture</string>
<key>CFBundleExecutable</key><string>capture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSCameraUsageDescription</key><string>Simulator Studio shows the screen of your cabled iPhone.</string>
</dict></plist>
`;

let building: Promise<string> | undefined;
const captureApp = () => (building ??= build().finally(() => (building = undefined)));

async function build(): Promise<string> {
  try {
    const stamp = createHash("sha256")
      .update(await readFile(SOURCE))
      .update(PLIST)
      .digest("hex");
    const bin = path.join(APP, "Contents", "MacOS");
    const built = await readFile(`${APP}.stamp`, "utf8").catch(() => "");
    if (built === stamp && existsSync(path.join(bin, "capture"))) return APP;
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(APP, "Contents", "Info.plist"), PLIST);
    await run("xcrun", ["swiftc", "-O", SOURCE, "-o", `${bin}/capture.tmp`], 300_000);
    await rename(`${bin}/capture.tmp`, `${bin}/capture`);
    // shortcut: an ad-hoc signature changes with each build, so macOS asks for camera access again
    // after a plugin update; sign with a stable identity if that annoys
    await run("codesign", ["-s", "-", "--force", APP]);
    await writeFile(`${APP}.stamp`, stamp);
    return APP;
  } catch (error) {
    throw new Error(
      `The iPhone view needs Xcode (xcode-select --install) to build its capture helper: ${(error as Error).message}`,
    );
  }
}

// --- wire format: [u8 type][u32 big-endian length][payload]; 0 frame, 1 fatal text, 2 recording done, 3 pid ---

export function frames(buffer: Buffer): { messages: { type: number; payload: Buffer }[]; rest: Buffer } {
  const messages: { type: number; payload: Buffer }[] = [];
  let at = 0;
  while (buffer.length - at >= 5) {
    const length = buffer.readUInt32BE(at + 1);
    // garbage: the stream can't be told apart from here on, so drop it all
    if (length > MAX_MESSAGE) return { messages, rest: Buffer.alloc(0) };
    if (buffer.length - at - 5 < length) break;
    messages.push({ type: buffer[at], payload: buffer.subarray(at + 5, at + 5 + length) });
    at += 5 + length;
  }
  return { messages, rest: buffer.subarray(at) };
}

// --- capture sessions: one helper per phone, alive while a panel watches or a recording runs ---

interface Session {
  udid: string;
  dir: string;
  server: net.Server;
  conn?: net.Socket;
  pid?: number;
  frame?: Buffer;
  seq: number;
  closed: boolean;
  // panels to tell about a new frame or the end; a watched session isn't closed
  watchers: Set<() => void>;
  // the 5 minute cap of the recording in progress, and the temp file it goes to
  recording?: NodeJS.Timeout;
  file: string;
  takes: number;
  kept: boolean;
  idle?: NodeJS.Timeout;
}

const sessions = new Map<string, Promise<Session>>();
const failed = new Map<string, { error: Error; at: number }>();
// a finished recording's temp mp4 (or why it failed) until its caller collects it
const finished = new Map<string, string | Error>();
let stopped = false;

const remember = (udid: string, error: Error) => failed.set(udid, { error, at: Date.now() });

// closes the session 5 s after the last panel and recording are gone
function arm(s: Session): void {
  clearTimeout(s.idle);
  if (!s.watchers.size && !s.recording) s.idle = setTimeout(() => void close(s), 5_000);
}

function endRecording(s: Session, result: string | Error): void {
  if (!s.recording) return;
  clearTimeout(s.recording);
  s.recording = undefined;
  s.kept = typeof result === "string";
  finished.set(s.udid, result);
  arm(s);
}

function onMessage(s: Session, { type, payload }: { type: number; payload: Buffer }): void {
  if (type === 0) {
    s.frame = payload;
    s.seq++;
    s.watchers.forEach((watcher) => watcher());
  } else if (type === 1) {
    remember(s.udid, new Error(payload.toString()));
    void close(s);
  } else if (type === 2) endRecording(s, payload.length ? new Error(payload.toString()) : s.file);
  else if (type === 3 && Number.isInteger(Number(payload)) && Number(payload) > 1) s.pid = Number(payload);
}

async function start(udid: string): Promise<Session> {
  const phone = phones.get(udid);
  if (stopped) throw new Error("The plugin is stopping");
  if (!phone) throw new Error("The iPhone isn't listed: refresh the device list");
  // shortcut: cable only; a Wi-Fi phone has no capture device. Poll devicectl screenshots if a slow view is wanted
  if (!phone.wired) throw new Error("Connect the iPhone with a cable for the live view");
  const app = await captureApp();
  if (stopped) throw new Error("The plugin is stopping");
  // mkdtemp makes the folder owner-only (0700); only this user can reach the socket in it
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-phone-"));
  const sock = path.join(dir, "p.sock");
  const s: Session = {
    udid,
    dir,
    server: net.createServer(),
    seq: 0,
    closed: false,
    watchers: new Set(),
    file: "",
    takes: 0,
    kept: false,
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The iPhone capture helper didn't start")), 20_000);
      s.server.once("error", reject);
      // exactly one connection, then no more
      s.server.once("connection", (conn) => {
        clearTimeout(timer);
        s.server.close();
        s.conn = conn;
        let pending: Buffer = Buffer.alloc(0);
        conn.on("data", (chunk) => {
          const parsed = frames(Buffer.concat([pending, chunk]));
          pending = parsed.rest;
          parsed.messages.forEach((message) => onMessage(s, message));
        });
        conn.on("close", () => void close(s));
        conn.on("error", () => {});
        // shortcut: the helper matches the phone by name (its capture id isn't the UDID), so two
        // phones with one name are ambiguous. A newline would start a second command.
        conn.write(`name ${phone.name.replace(/[\r\n]/g, " ")}\n`);
        resolve();
      });
      // -n: a new instance each time, -g: in the background
      s.server.listen(sock, () => run("open", ["-n", "-g", "-a", app, "--args", sock]).catch(reject));
    });
  } catch (error) {
    void close(s);
    throw error;
  }
  arm(s);
  return s;
}

function session(udid: string): Promise<Session> {
  const bad = failed.get(udid);
  if (bad && Date.now() - bad.at < 10_000) return Promise.reject(bad.error);
  let existing = sessions.get(udid);
  if (!existing) {
    existing = start(udid);
    sessions.set(udid, existing);
    existing.catch((error: Error) => {
      sessions.delete(udid);
      remember(udid, error);
    });
  }
  return existing;
}

async function close(s: Session): Promise<void> {
  if (s.closed) return;
  s.closed = true;
  clearTimeout(s.idle);
  endRecording(s, new Error("The recording was cut off"));
  s.watchers.forEach((watcher) => watcher());
  s.conn?.end();
  s.server.close();
  // the helper quits when its socket closes; this is the backstop
  const { pid, conn } = s;
  if (pid)
    setTimeout(() => {
      // only one that is still connected: an exited helper's pid may be another process by now
      if (conn && !conn.closed)
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
    }, 5_000).unref();
  // a finished recording's file stays 10 minutes for its caller to collect
  // shortcut: a daemon killed in that time leaves the video in the temp folder until macOS clears it
  const clean = () => rmSync(s.dir, { recursive: true, force: true });
  if (s.kept) setTimeout(clean, 600_000).unref();
  else clean();
  void sessions.get(s.udid)?.then(
    (current) => current === s && sessions.delete(s.udid),
    () => {},
  );
  const team = teams.get(s.udid);
  teams.delete(s.udid);
  if (team) await agent(s.udid, team, "close", [], 10_000).catch(() => {});
}

export async function stopPhones(): Promise<void> {
  stopped = true;
  await Promise.all([...sessions.values()].map((pending) => pending.then(close, () => {})));
}

/** Reports the newest frame and the end to onChange until the signal aborts or the session closes. */
export async function phoneWatch(
  udid: string,
  signal: AbortSignal,
  onChange: (state: { image?: Buffer; seq: number; rotate: 0 | 1; closed: boolean }) => void,
): Promise<void> {
  const s = await session(udid);
  if (signal.aborted || s.closed) return;
  let end = () => {};
  const report = () => {
    // shortcut: always upright; a landscape app arrives however the phone sends it, revisit after a test
    onChange({ image: s.frame, seq: s.seq, rotate: 0, closed: s.closed });
    if (s.closed) end();
  };
  s.watchers.add(report);
  arm(s);
  await new Promise<void>((resolve) => {
    end = resolve;
    signal.addEventListener("abort", resolve, { once: true });
    report();
  });
  s.watchers.delete(report);
  arm(s);
}

// --- recording: the helper writes an mp4 in the session's temp folder; the caller moves it ---

export async function phoneRecord(udid: string): Promise<void> {
  const s = await session(udid);
  if (s.recording) return;
  // a file of its own: the last take may still be on its way into the workspace
  s.file = path.join(s.dir, `r${++s.takes}.mp4`);
  s.conn?.write(`record ${s.file}\n`);
  // shortcut: 5 minutes at most, so a forgotten recording can't fill the disk; raise it if needed
  const cap = setTimeout(() => {
    s.conn?.write("stop\n");
    // a helper that never answers mustn't keep the session (and the capture) alive
    setTimeout(
      () => s.recording === cap && endRecording(s, new Error("The recording didn't finish")),
      15_000,
    ).unref();
  }, 300_000);
  s.recording = cap;
  arm(s);
}

export async function phoneStopRecording(udid: string): Promise<string> {
  const s = await sessions.get(udid)?.catch(() => undefined);
  if (!s?.recording && !finished.has(udid)) throw new Error("No recording is running");
  const take = s?.recording;
  if (take) s.conn?.write("stop\n");
  // while this take runs: a new one started meanwhile isn't this call's to end
  for (let i = 0; i < 150 && take && s.recording === take; i++) await sleep(100);
  if (s && take && s.recording === take) endRecording(s, new Error("The recording didn't finish"));
  const result = finished.get(udid);
  finished.delete(udid);
  if (typeof result !== "string") throw result ?? new Error("The recording was cut off");
  return result;
}

// --- touch: agent-device on the phone, one action at a time ---

const teams = new Map<string, string>();
const busy = new Set<string>();
const screens = new Map<string, { at: number; w: number; h: number }>();
const devicectl = async <T>(udid: string, what: string) =>
  (
    JSON.parse(
      await run("xcrun", ["devicectl", "device", "info", what, "--device", udid, "--json-output", "-"]),
    ) as { result: T }
  ).result;

/** Runs one agent-device command; failures carry its JSON error text (signing, developer mode ...). */
function agent(udid: string, team: string, command: string, args: string[] = [], timeoutMs = 120_000) {
  if (!/^[A-Z0-9]{10}$/.test(team)) return Promise.reject(new Error("Invalid Apple Team ID"));
  // own state dir per team: its background process is always started with that team
  const env = {
    ...process.env,
    ...NODE_ENV,
    AGENT_DEVICE_STATE_DIR: path.join(STATE_DIR, `agent-device-${team}`),
    AGENT_DEVICE_IOS_TEAM_ID: team,
    AGENT_DEVICE_IOS_BUNDLE_ID: `com.simulatorstudio.runner.${team.toLowerCase()}`,
  };
  // flags first, then `--`: typed text can't be read as a flag
  const target = ["--udid", udid, "--session", `panel-${udid}`];
  const argv = [AGENT_DEVICE, "--platform", "ios", ...target, "--json", "--", command, ...args];
  return new Promise<void>((resolve, reject) =>
    execFile(
      NODE,
      argv,
      { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let reply: { success?: boolean; error?: { code?: string; message?: string; hint?: string } } = {};
        try {
          reply = JSON.parse(stdout) ?? {};
        } catch {
          // not JSON: fall back to stderr below
        }
        if (!error && reply.success !== false) return resolve();
        const text = [
          reply.error?.message ?? (stderr || error?.message || "agent-device failed").trim(),
          reply.error?.hint,
        ];
        reject(Object.assign(new Error(text.filter(Boolean).join(" ")), { code: reply.error?.code }));
      },
    ),
  );
}

// the lock state is cached 10 s; a failed action clears it
async function screen(udid: string): Promise<Size> {
  let known = screens.get(udid);
  if (!known || Date.now() - known.at > 10_000) {
    const [lock, displays] = await Promise.all([
      devicectl<{ passcodeRequired: boolean }>(udid, "lockState"),
      devicectl<{ displays: { backlightState: string; nativeSize: number[]; pointScale: number }[] }>(
        udid,
        "displays",
      ),
    ]);
    const display = displays.displays[0];
    if (lock.passcodeRequired || /off/i.test(display.backlightState)) throw new Error("Unlock the iPhone");
    known = {
      at: Date.now(),
      w: display.nativeSize[0] / display.pointScale,
      h: display.nativeSize[1] / display.pointScale,
    };
    screens.set(udid, known);
  }
  return known;
}

// reads the size from the JPEG's start-of-frame marker
function isWide(jpeg: Buffer): boolean {
  for (let i = 2; i + 9 < jpeg.length && jpeg[i] === 0xff; i += 2 + jpeg.readUInt16BE(i + 2))
    if (jpeg[i + 1] >= 0xc0 && jpeg[i + 1] <= 0xc3)
      return jpeg.readUInt16BE(i + 7) > jpeg.readUInt16BE(i + 5);
  return false;
}

// shortcut: portrait only; an agent's session holding the phone can make this fail with DEVICE_IN_USE
async function act(udid: string, team: string, command: string, args: (size: Size) => string[]) {
  if (busy.has(udid)) throw new Error("Still sending the last touch");
  busy.add(udid);
  try {
    const size = await screen(udid);
    const frame = (await sessions.get(udid)?.catch(() => undefined))?.frame;
    if (frame && isWide(frame)) throw new Error("Touch works in portrait only");
    teams.set(udid, team);
    const send = () => agent(udid, team, command, args(size));
    await send().catch(async (error: Error & { code?: string }) => {
      if (error.code !== "SESSION_NOT_FOUND") throw error;
      await agent(udid, team, "open");
      await send();
    });
  } catch (error) {
    screens.delete(udid);
    throw error;
  } finally {
    busy.delete(udid);
  }
}

type Size = { w: number; h: number };
type Point = { x: number; y: number };
const pts = (p: Point, { w, h }: Size) => [String(Math.round(p.x * w)), String(Math.round(p.y * h))];

export const phoneTap = (udid: string, team: string, x: number, y: number, holdMs: number) =>
  act(udid, team, holdMs >= LONG_PRESS_MS ? "longpress" : "press", (size) => [
    ...pts({ x, y }, size),
    ...(holdMs >= LONG_PRESS_MS ? [String(Math.round(holdMs))] : []),
  ]);

export const phoneSwipe = (udid: string, team: string, from: Point, to: Point, durationMs: number) =>
  act(udid, team, "gesture", (size) => [
    "pan",
    ...pts(from, size),
    ...pts({ x: to.x - from.x, y: to.y - from.y }, size),
    String(Math.round(durationMs)),
  ]);

export const phoneText = (udid: string, team: string, text: string) => act(udid, team, "type", () => [text]);
export const phoneHome = (udid: string, team: string) => act(udid, team, "home", () => []);
