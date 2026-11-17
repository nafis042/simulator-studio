import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { gesture, type Device } from "../shared/contracts";
import { latestWins } from "../shared/latest";
import { splitDevices } from "../shared/select";

// state.ts picks its file from PASEO_HOME at import time: point it at a throwaway folder first
let state: typeof import("./state");
let phone: typeof import("./phone");
before(async () => {
  process.env.PASEO_HOME = mkdtempSync(path.join(os.tmpdir(), "devices-test-"));
  // phone.ts finds the plugin directory through the daemon config
  const plugin = { path: path.join(import.meta.dirname, "..") };
  writeFileSync(path.join(process.env.PASEO_HOME, "config.json"), JSON.stringify({ plugins: { x: plugin } }));
  phone = await import("./phone");
  state = await import("./state");
  await state.loadState();
});

const A = { workspaceId: "a", workspaceName: "Checkout", directory: "/w/app" };
const B = { workspaceId: "b", workspaceName: "Onboarding", directory: "/w/app-worktrees/onboarding" };

test("a held device isn't silently taken by another workspace", async () => {
  await state.addAssignment(A, "ios:00000000-0000-0000-0000-000000000001", false);
  await assert.rejects(
    state.addAssignment(B, "ios:00000000-0000-0000-0000-000000000001", false),
    /In use by Checkout/,
  );
  assert.equal(state.holderOf("ios:00000000-0000-0000-0000-000000000001")?.workspaceId, "a");
  assert.equal(
    await state.addAssignment(B, "ios:00000000-0000-0000-0000-000000000001", true),
    "Taken over from Checkout",
  );
  assert.equal(state.holderOf("ios:00000000-0000-0000-0000-000000000001")?.workspaceId, "b");
  assert.equal(state.assignments().filter((x) => x.workspaceId === "a").length, 0);
});

test("a workspace holds several devices; agents drive one; release frees one", async () => {
  await state.addAssignment(A, "ios:00000000-0000-0000-0000-000000000002", false);
  await state.addAssignment(A, "android:emulator-5554", false);
  await state.addAssignment(A, "ios:00000000-0000-0000-0000-000000000003", false);
  const mine = () =>
    state
      .assignments()
      .filter((x) => x.workspaceId === "a")
      .map((x) => x.deviceId);
  assert.deepEqual(mine(), [
    "ios:00000000-0000-0000-0000-000000000002",
    "android:emulator-5554",
    "ios:00000000-0000-0000-0000-000000000003",
  ]);
  // only devices allowed for agents; the first allowed until agents choose
  assert.equal(state.targetOf("a"), undefined);
  await state.allowAgentTools("ios:00000000-0000-0000-0000-000000000003", true);
  assert.equal(state.targetOf("a")?.deviceId, "ios:00000000-0000-0000-0000-000000000003");
  // allowing one added earlier doesn't move agents off the one they drive
  await state.allowAgentTools("android:emulator-5554", true);
  assert.equal(state.targetOf("a")?.deviceId, "ios:00000000-0000-0000-0000-000000000003");
  await state.setTarget("a", "android:emulator-5554");
  assert.equal(state.targetOf("a")?.deviceId, "android:emulator-5554");
  await state.setTarget("a", "ios:00000000-0000-0000-0000-000000000003");
  assert.equal(state.targetOf("a")?.deviceId, "ios:00000000-0000-0000-0000-000000000003");
  // only the workspace holding it can release it (a panel a poll behind can't take it from another)
  assert.equal(await state.removeAssignment("b", "ios:00000000-0000-0000-0000-000000000003"), false);
  assert.equal(await state.removeAssignment("a", "ios:00000000-0000-0000-0000-000000000003"), true);
  assert.deepEqual(mine(), ["ios:00000000-0000-0000-0000-000000000002", "android:emulator-5554"]);
  assert.equal(state.holderOf("ios:00000000-0000-0000-0000-000000000003"), undefined);
  assert.equal(state.targetOf("a")?.deviceId, "android:emulator-5554");
  // releasing forgets that agents chose it: back again, it doesn't take over from the current one
  await state.addAssignment(A, "ios:00000000-0000-0000-0000-000000000003", false);
  assert.equal(state.targetOf("a")?.deviceId, "android:emulator-5554");
  // so does withdrawing consent
  await state.setTarget("a", "ios:00000000-0000-0000-0000-000000000003");
  await state.allowAgentTools("ios:00000000-0000-0000-0000-000000000003", false);
  await state.allowAgentTools("ios:00000000-0000-0000-0000-000000000003", true);
  assert.equal(state.targetOf("a")?.deviceId, "android:emulator-5554");
  // a device the workspace no longer holds can't become its target
  await state.removeAssignment("a", "ios:00000000-0000-0000-0000-000000000003");
  await state.setTarget("a", "ios:00000000-0000-0000-0000-000000000003");
  await state.addAssignment(A, "ios:00000000-0000-0000-0000-000000000003", false);
  assert.equal(state.targetOf("a")?.deviceId, "android:emulator-5554");
  for (const id of mine()) await state.removeAssignment("a", id);
});

test("agents in a subfolder of a workspace find its device; the deepest workspace wins", async () => {
  await state.addAssignment(
    { workspaceId: "root", workspaceName: "Root", directory: "/w" },
    "ios:00000000-0000-0000-0000-000000000004",
    false,
  );
  assert.equal(state.assignmentFor("/w/app-worktrees/onboarding/src")?.workspaceId, "b");
  assert.equal(state.assignmentFor("/w/other")?.workspaceId, "root");
  assert.equal(state.assignmentFor("/wx"), undefined);
});

test("featured devices: on, held, owned, Android, and newest-iOS iPhones", () => {
  const d = (id: string, name: string, detail: string, extra: Partial<Device> = {}): Device => ({
    id,
    platform: id.startsWith("ios") ? "ios" : "android",
    name,
    detail,
    state: "shutdown",
    kind: "simulator",
    owned: false,
    agentTools: false,
    error: null,
    ...extra,
  });
  const devices = [
    d("ios:old", "iPhone 17", "iOS 26.4"),
    d("ios:new", "iPhone 17", "iOS 26.5"),
    d("ios:ipad", "iPad mini", "iOS 26.5"),
    d("ios:on", "iPad Air", "iOS 26.4", { state: "booted" }),
    d("ios:held", "iPhone Air", "iOS 26.4"),
    d("avd:pixel", "Pixel", "Android emulator", { kind: "avd" }),
  ];
  const { main, rest } = splitDevices(devices, new Set(["ios:held"]));
  assert.deepEqual(main.map((x) => x.id).sort(), ["avd:pixel", "ios:held", "ios:new", "ios:on"]);
  assert.deepEqual(rest.map((x) => x.id).sort(), ["ios:ipad", "ios:old"]);
});

test("typing: US keyboard usages, shift around capitals and symbols", async () => {
  const { keyEvents } = await import("../shared/keyboard");
  assert.deepEqual(keyEvents("a1"), [
    { type: "down", usage: 4 },
    { type: "up", usage: 4 },
    { type: "down", usage: 30 },
    { type: "up", usage: 30 },
  ]);
  assert.deepEqual(
    keyEvents("A?").map((e) => `${e.type}:${e.usage}`),
    ["down:225", "down:4", "up:4", "up:225", "down:225", "down:56", "up:56", "up:225"],
  );
  assert.equal(keyEvents("hi there\r\n").length, 18);
  assert.throws(() => keyEvents("é"), /can't type "é"/);
});

test("agent tools are off until allowed per device, and forgotten with a deleted copy", async () => {
  assert.equal(state.agentToolsAllowed("ios:00000000-0000-0000-0000-000000000005"), false);
  await state.allowAgentTools("ios:00000000-0000-0000-0000-000000000005", true);
  assert.equal(state.agentToolsAllowed("ios:00000000-0000-0000-0000-000000000005"), true);
  await state.allowAgentTools("ios:00000000-0000-0000-0000-000000000005", false);
  assert.equal(state.agentToolsAllowed("ios:00000000-0000-0000-0000-000000000005"), false);
  await state.setOwned("android:emulator-5556", true);
  await state.allowAgentTools("android:emulator-5556", true);
  await state.setOwned("android:emulator-5556", false);
  assert.equal(state.agentToolsAllowed("android:emulator-5556"), false);
});

test("every RPC contract is valid (defineRpc throws on load otherwise)", async () => {
  await assert.doesNotReject(import("../shared/contracts"));
});

test("the picker answers an agent's MCP messages over stdio, in its own workspace", async () => {
  const { spawn } = await import("node:child_process");
  const { servePicker } = await import("./picker");
  const socket = path.join(mkdtempSync(path.join(os.tmpdir(), "picker-")), "picker.sock");
  const used: string[] = [];
  const stop = servePicker(socket, {
    list: async (w) => `devices for ${w.workspaceName}`,
    use: async (w, id) => {
      if (id === "ios:held") throw new Error("In use by Checkout");
      used.push(`${w.workspaceId}:${id}`);
      return "ok";
    },
  });
  const bridge = spawn(process.execPath, [path.join(import.meta.dirname, "picker-bridge.mjs")], {
    env: { PASEO_DEVICES_SOCKET: socket, PASEO_DEVICES_WORKSPACE: JSON.stringify(B) },
  });
  const call = (id: number, name: string, args = {}) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  bridge.stdin.end(
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      call(3, "list_devices"),
      call(4, "use_device", { deviceId: "ios:held" }),
      call(5, "use_device", { deviceId: "ios:00000000-0000-0000-0000-000000000001" }),
    ].join("\n") + "\n",
  );
  let out = "";
  for await (const chunk of bridge.stdout) out += chunk;
  stop();
  const answers = out
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  // the notification gets no answer
  assert.deepEqual(
    answers.map((a) => a.id),
    [1, 2, 3, 4, 5],
  );
  assert.equal(answers[0].result.capabilities.tools !== undefined, true);
  assert.deepEqual(
    answers[1].result.tools.map((t: { name: string }) => t.name),
    ["list_devices", "use_device"],
  );
  assert.equal(answers[2].result.content[0].text, "devices for Onboarding");
  assert.deepEqual(
    [answers[3].result.isError, answers[3].result.content[0].text],
    [true, "In use by Checkout"],
  );
  assert.deepEqual(used, ["b:ios:00000000-0000-0000-0000-000000000001"]);
});

test("latestWins runs once more, not once per call, after a busy send", async () => {
  let runs = 0;
  let release = () => {};
  const run = latestWins(async () => {
    runs++;
    await new Promise<void>((resolve) => (release = resolve));
  });
  const first = run();
  for (let i = 0; i < 4; i++) void run();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await first;
  assert.equal(runs, 2);
});

test("frames() joins split chunks, splits joined ones and drops an oversize message", () => {
  const message = (type: number, text: string) => {
    const header = Buffer.alloc(5);
    header[0] = type;
    header.writeUInt32BE(text.length, 1);
    return Buffer.concat([header, Buffer.from(text)]);
  };
  const [one, two] = [message(0, "abc"), message(1, "de")];
  const first = phone.frames(one.subarray(0, 4));
  assert.equal(first.messages.length, 0);
  const second = phone.frames(Buffer.concat([first.rest, one.subarray(4)]));
  assert.deepEqual(
    second.messages.map((m) => [m.type, m.payload.toString()]),
    [[0, "abc"]],
  );
  const both = phone.frames(Buffer.concat([one, two]));
  assert.deepEqual(
    both.messages.map((m) => m.payload.toString()),
    ["abc", "de"],
  );
  const huge = Buffer.from([0, 0xff, 0xff, 0xff, 0xff, 1]);
  assert.deepEqual(phone.frames(huge), { messages: [], rest: Buffer.alloc(0) });
});

test("gesture: a still finger taps or long-presses, a moved one swipes", () => {
  const a = { x: 0.1, y: 0.2 };
  const b = { x: 0.5, y: 0.2 };
  assert.deepEqual(gesture(a, a, 100, false), { kind: "tap", x: 0.1, y: 0.2, holdMs: 60 });
  assert.deepEqual(gesture(a, a, 9_000, false), { kind: "tap", x: 0.1, y: 0.2, holdMs: 5_000 });
  assert.deepEqual(gesture(a, b, 10, true), { kind: "swipe", from: a, to: b, durationMs: 80 });
});

test("agents get an iPhone only with the signing team, and lose it with the team", async () => {
  const W = { workspaceId: "w", workspaceName: "Phone", directory: "/tmp/w" };
  const phone = "ios:00008101-000A11112222001E";
  await state.addAssignment(W, phone, false);
  await state.allowAgentTools(phone, true);
  assert.equal(state.targetOf("w"), undefined);
  assert.equal(state.agentPhone("w"), false);
  // a new team withdraws phones: the user allows them again under it
  await state.setTeam("ABCDE12345");
  assert.equal(state.agentToolsAllowed(phone), false);
  await state.allowAgentTools(phone, true);
  assert.equal(state.targetOf("w")?.deviceId, phone);
  // agents started without the team never see it
  assert.equal(state.targetOf("w", false), undefined);
  assert.equal(state.agentPhone("w"), true);
  // permission stays with the workspace it was given in: a phone that moves asks again
  const V = { workspaceId: "v", workspaceName: "Other", directory: "/tmp/v" };
  await state.addAssignment(V, phone, true);
  assert.equal(state.agentToolsAllowed(phone), false);
  assert.equal(state.agentPhone("w"), false);
  await state.addAssignment(W, phone, true);
  await state.allowAgentTools(phone, true);
  // agents started with the team read a file of their own; the plain one never names the phone
  const { syncAgentConfigs } = await import("./agents");
  const files = () =>
    readdirSync(path.join(state.STATE_DIR, "agent-device")).filter((f) => f.startsWith("w."));
  await syncAgentConfigs();
  assert.deepEqual(files(), ["w.ABCDE12345.json"]);
  await state.setTeam("");
  assert.equal(state.agentToolsAllowed(phone), false);
  assert.equal(state.agentPhone("w"), false);
  await syncAgentConfigs();
  assert.deepEqual(files(), []);
});
