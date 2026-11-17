import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

const platformSchema = z.enum(["ios", "android"]);

/**
 * "ios:<udid>" or "android:<adb serial>" (an AVD that isn't running is "avd:<name>"). The part
 * after the prefix goes to simctl, adb and serve-sim as an argument, so it can't start with "-".
 */
export const deviceId = z.string().regex(/^(ios|android|avd):[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);

/** A physical iPhone or iPad: an iOS id that isn't a simulator's UUID. */
export const isPhone = (id: string) =>
  id.startsWith("ios:") && !/^[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}$/i.test(id.slice(4));

type Point = { x: number; y: number };
/** What a finger that went down at `from` and lifted at `to` after heldMs asks of the device. */
export const gesture = (from: Point, to: Point, heldMs: number, moved: boolean) =>
  moved
    ? { kind: "swipe" as const, from, to, durationMs: Math.min(5_000, Math.max(80, heldMs)) }
    : { kind: "tap" as const, ...from, holdMs: heldMs >= LONG_PRESS_MS ? Math.min(heldMs, 5_000) : 60 };

/** A touch held this long is a long press, on both platforms. */
export const LONG_PRESS_MS = 450;

const device = z.object({
  id: deviceId,
  platform: platformSchema,
  name: z.string(),
  // iOS runtime ("iOS 26.5") or the AVD an emulator runs
  detail: z.string(),
  state: z.enum(["booted", "booting", "shutdown"]),
  kind: z.enum(["simulator", "emulator", "avd", "physical"]),
  // created by this plugin for a workspace: offered for deletion
  owned: z.boolean(),
  // agents may drive it: allowed by the user, since agent-device installs helpers on it first
  agentTools: z.boolean(),
  // why the last boot failed, until the next attempt
  error: z.string().nullable(),
});
export type Device = z.infer<typeof device>;

const assignment = z.object({
  workspaceId: z.string(),
  workspaceName: z.string(),
  directory: z.string(),
  deviceId,
});
export type Assignment = z.infer<typeof assignment>;

export const listRpc = defineRpc({
  name: "devices.list",
  input: z.object({}),
  output: z.object({
    ios: z.object({ available: z.boolean(), reason: z.string() }),
    android: z.object({ available: z.boolean(), reason: z.string() }),
    devices: z.array(device),
    assignments: z.array(assignment),
    // "" until the user set up touch for physical iPhones
    team: z.string(),
  }),
});

/**
 * The Apple developer team that signs the touch runner for physical iPhones; "" turns panel touch
 * off. Saving one is the user's consent to install that runner app on their phone.
 */
export const teamRpc = defineRpc({
  name: "devices.team",
  input: z.object({ team: z.string().regex(/^([A-Z0-9]{10})?$/) }),
  output: z.object({ message: z.string() }),
});

const workspace = z.object({
  workspaceId: z.string().min(1),
  workspaceName: z.string(),
  directory: z.string().min(1),
});

/**
 * Adds a device to a workspace's devices, or with release takes it away from the workspace.
 * Refuses a device another workspace holds unless takeOver.
 */
export const assignRpc = defineRpc({
  name: "devices.assign",
  input: workspace.extend({
    deviceId,
    takeOver: z.boolean().default(false),
    release: z.boolean().default(false),
  }),
  output: z.object({ message: z.string() }),
});

/** A fresh device for one workspace: a new simulator like `from`, or another instance of an AVD. */
export const createRpc = defineRpc({
  name: "devices.create",
  input: workspace.extend({ from: deviceId }),
  output: z.object({ deviceId, message: z.string() }),
});

/**
 * Lets agents drive a device, or stops that. The first time an agent uses a device, agent-device
 * installs its helpers on it, so the user allows it explicitly.
 */
export const agentToolsRpc = defineRpc({
  name: "devices.agent-tools",
  input: z.object({ deviceId, allow: z.boolean() }),
  output: z.object({ message: z.string() }),
});

export const powerRpc = defineRpc({
  name: "devices.power",
  input: z.object({ deviceId, action: z.enum(["boot", "shutdown", "delete"]) }),
  output: z.object({ deviceId, message: z.string() }),
});

export const frameRpc = defineRpc({
  name: "devices.frame",
  input: z.object({
    deviceId,
    maxWidth: z.number().int().min(120).max(1600),
    since: z.number().int().default(-1),
  }),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("frame"),
      seq: z.number().int(),
      jpeg: z.string(),
      width: z.number(),
      height: z.number(),
    }),
    // nothing newer than `since`
    z.object({ status: z.literal("same"), seq: z.number().int() }),
    z.object({ status: z.literal("unavailable"), reason: z.string() }),
  ]),
});

const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

/** The iOS live view: every event is [rotate: 0 | 1][JPEG bytes]; 1 means turn the picture 90 degrees clockwise. */
export const streamSub = defineSubscription({
  name: "devices.stream",
  input: z.object({ deviceId }),
  event: z.instanceof(Uint8Array),
});

/** Starts (on) or stops recording an iOS simulator's or cabled iPhone's screen into its workspace's `.paseo/recordings`; stopping returns the video's path. */
export const recordRpc = defineRpc({
  name: "devices.record",
  input: z.object({ deviceId, on: z.boolean() }),
  output: z.object({ path: z.string() }),
});

export const inputRpc = defineRpc({
  name: "devices.input",
  input: z.object({
    deviceId,
    input: z.discriminatedUnion("kind", [
      point.extend({ kind: z.literal("tap"), holdMs: z.number().int().min(0).max(5000).default(60) }),
      z.object({
        kind: z.literal("swipe"),
        from: point,
        to: point,
        durationMs: z.number().int().min(50).max(5000),
      }),
      point.extend({ kind: z.literal("touch"), phase: z.enum(["begin", "move", "end"]) }),
      z.object({ kind: z.literal("text"), text: z.string().min(1).max(2000) }),
      z.object({
        kind: z.literal("button"),
        button: z.enum(["home", "back", "lock", "volumeUp", "volumeDown", "appSwitch"]),
      }),
      z.object({ kind: z.literal("rotate"), orientation: z.enum(["portrait", "landscape"]) }),
    ]),
  }),
  output: z.object({ ok: z.literal(true) }),
});
