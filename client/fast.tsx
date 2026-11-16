import type { PluginTheme } from "@getpaseo/plugin";
import { useAgents, useComposers, useRpc, useSubscription } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Pressable, Text, View } from "react-native";
import { inputRpc, recordRpc, streamSub } from "../shared/contracts";
import { latestWins } from "../shared/latest";
import { Button, IconButton } from "./ui";
import { copyImage, mountScreen, pasteImage, type Screen, type Tool } from "./web";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const shapes: [Tool, string, string][] = [
  ["line", "Minus", "Line"],
  ["arrow", "MoveUpRight", "Arrow"],
  ["rect", "Square", "Rectangle"],
  ["ellipse", "Circle", "Ellipse"],
  ["step", "ListOrdered", "Step"],
];
// content, not theme
const colors = [
  ["#D97757", "Clay"],
  ["#FF3B30", "Red"],
  ["#007AFF", "Blue"],
  ["#34C759", "Green"],
  ["#000000", "Black"],
  ["#FFFFFF", "White"],
] as const;
const widths = [
  [2, "Thin"],
  [4, "Medium"],
  [8, "Thick"],
  [14, "Extra thick"],
] as const;

/**
 * The iOS simulator at the stream's frame rate, drawn by client/web.ts, for the desktop app. The
 * stream runs only while the panel is on screen and not annotating, so a hidden panel receives
 * nothing. With `annotating` the picture is frozen for drawing on.
 */
export function FastScreen({
  theme,
  hostId,
  deviceId,
  workspaceId,
  annotating,
  onShape,
  onDone,
}: {
  theme: PluginTheme;
  hostId: string;
  deviceId: string;
  workspaceId: string;
  annotating: boolean;
  onShape(landscape: boolean): void;
  onDone(): void;
}) {
  const input = useRpc(inputRpc);
  const host = useRef<View>(null);
  const screen = useRef<Screen | null>(null);
  const [visible, setVisible] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let at = { x: 0, y: 0 };
    let down = false;
    const send = (phase: "begin" | "move" | "end", x: number, y: number) =>
      input({ deviceId, input: { kind: "touch", phase, x, y } }).then(
        () => setProblem(null),
        (error: unknown) => setProblem(message(error)),
      );
    // moves coalesce, begin and end are never dropped
    const move = latestWins(async () => down && send("move", at.x, at.y));
    screen.current = mountScreen(host.current, {
      touch(phase, x, y) {
        at = { x, y };
        down = phase !== "end";
        if (phase === "move") void move();
        else void send(phase, x, y);
      },
      shape: onShape,
      visible: setVisible,
    });
    return () => {
      screen.current?.destroy();
      screen.current = null;
      onDone(); // a device that turns off leaves annotate mode
    };
  }, []);

  useEffect(() => {
    // nothing to draw on yet
    if (annotating && !screen.current?.ready()) onDone();
    else screen.current?.annotate(annotating);
  }, [annotating]);

  return (
    <View style={{ flex: 1, minHeight: 200 }}>
      <View ref={host} style={{ flex: 1, alignItems: "center", justifyContent: "center" }} />
      {visible && !annotating ? (
        <Feed
          key={attempt}
          deviceId={deviceId}
          screen={screen}
          onProblem={setProblem}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : null}
      {problem ? (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            position: "absolute",
            bottom: 8,
            alignSelf: "center",
            textAlign: "center",
          }}
        >
          {problem}
        </Text>
      ) : null}
      {annotating ? (
        <AnnotateBar
          theme={theme}
          hostId={hostId}
          workspaceId={workspaceId}
          screen={screen}
          onDone={onDone}
        />
      ) : null}
    </View>
  );
}

/** The subscription: mounted only while the picture is being looked at. Resubscribes after a failure. */
function Feed({
  deviceId,
  screen,
  onProblem,
  onRetry,
}: {
  deviceId: string;
  screen: RefObject<Screen | null>;
  onProblem(message: string | null): void;
  onRetry(): void;
}) {
  // shortcut: full-rate stream on remote hosts; add a per-frame client ack if used over a relay
  const sub = useSubscription(streamSub, { deviceId }, (bytes) => screen.current?.frame(bytes));
  useEffect(() => {
    if (sub.status === "live") return onProblem(null);
    if (sub.status !== "closed" && sub.status !== "error") return;
    onProblem(sub.status === "error" ? sub.error.message : "The live view stopped");
    const timer = setTimeout(onRetry, 1_000);
    return () => clearTimeout(timer);
  }, [sub.status]);
  return null;
}

/** A toolbar button; the selected one is ringed. */
function Pick({
  theme,
  label,
  selected,
  onPress,
  children,
}: {
  theme: PluginTheme;
  label: string;
  selected: boolean;
  onPress(): void;
  children: ReactNode;
}) {
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        minWidth: 32,
        minHeight: 32,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        borderWidth: 2,
        borderColor: selected ? c.accent : "transparent",
      }}
    >
      {children}
    </Pressable>
  );
}

/** One pill of tools, menus, Undo, Add to chat and Close while drawing; a separate component so its hooks don't re-render the live view. */
function AnnotateBar({
  theme,
  hostId,
  workspaceId,
  screen,
  onDone,
}: {
  theme: PluginTheme;
  hostId: string;
  workspaceId: string;
  screen: RefObject<Screen | null>;
  onDone(): void;
}) {
  const toast = useToast();
  const c = theme.colors;
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<Tool>("pen");
  const [shape, setShape] = useState(shapes[2]);
  const [color, setColor] = useState<(typeof colors)[number]>(colors[0]);
  const [width, setWidth] = useState<(typeof widths)[number]>(widths[1]);
  const [open, setOpen] = useState<"shape" | "color" | "width" | null>(null);
  useEffect(() => screen.current?.style(tool, color[0], width[0]), [tool, color, width]);
  const composer = useChat(hostId, workspaceId);

  async function addToChat() {
    setBusy(true);
    try {
      const blob = await screen.current?.png();
      let pasted = false;
      try {
        // focus() opens the agent's tab if needed and may take a while to give up
        await composer?.focus();
        pasted = composer !== undefined && pasteImage(blob);
      } catch {}
      if (!pasted) await copyImage(blob);
      toast.show(pasted ? "Added to the chat" : "Copied. Press Cmd+V in the chat.", { variant: "success" });
      onDone();
    } catch (error) {
      toast.error(message(error));
    } finally {
      setBusy(false);
    }
  }

  const act = (f: () => void) => () => (setOpen(null), f());
  const swatch = (hex: string) => (
    <View
      style={{
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: hex,
      }}
    />
  );
  const bar = (h: number) => (
    <View style={{ width: 24, height: h, borderRadius: 2, backgroundColor: c.foreground }} />
  );
  // a button that toggles its menu, which pops up above it; rows are [label, mark, chosen, pick]
  const slot = (
    key: "shape" | "color" | "width",
    label: string,
    selected: boolean,
    face: ReactNode,
    rows: [string, ReactNode, boolean, () => void][],
  ) => (
    <View>
      <Pick
        theme={theme}
        label={label}
        selected={selected}
        onPress={() => setOpen(open === key ? null : key)}
      >
        {face}
      </Pick>
      {open === key ? (
        <View
          style={{
            position: "absolute",
            bottom: "100%",
            left: 0,
            marginBottom: 6,
            zIndex: 10,
            minWidth: 150,
            padding: 4,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c.surface2,
          }}
        >
          {rows.map(([name, mark, chosen, pick]) => (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityLabel={name}
              onPress={act(pick)}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 8 }}
            >
              {mark}
              <Text style={{ flex: 1, color: c.foreground, fontSize: 13 }}>{name}</Text>
              {chosen ? <Icon name="Check" size={14} color={c.foreground} /> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={{ alignItems: "center", paddingTop: 8 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          padding: 4,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c.surface2,
        }}
      >
        <Pick theme={theme} label="Pen" selected={tool === "pen"} onPress={act(() => setTool("pen"))}>
          <Icon name="Pencil" size={18} color={c.foreground} />
        </Pick>
        {slot(
          "shape",
          "Shape",
          tool === shape[0],
          <Icon name={shape[1]} size={18} color={c.foreground} />,
          shapes.map((s) => [
            s[2],
            <Icon name={s[1]} size={18} color={c.foreground} />,
            s === shape,
            () => (setShape(s), setTool(s[0])),
          ]),
        )}
        <Pick theme={theme} label="Text" selected={tool === "text"} onPress={act(() => setTool("text"))}>
          <Icon name="Type" size={18} color={c.foreground} />
        </Pick>
        {slot(
          "color",
          "Colour",
          false,
          swatch(color[0]),
          colors.map((k) => [k[1], swatch(k[0]), k === color, () => setColor(k)]),
        )}
        {slot(
          "width",
          "Thickness",
          false,
          bar(width[0]),
          widths.map((w) => [w[1], bar(w[0]), w === width, () => setWidth(w)]),
        )}
        <IconButton theme={theme} icon="Undo2" label="Undo" onPress={act(() => screen.current?.undo())} />
        <Button
          theme={theme}
          primary
          label="Add to chat"
          disabled={busy}
          onPress={act(() => void addToChat())}
        />
        <IconButton theme={theme} icon="X" label="Close" onPress={act(onDone)} />
      </View>
    </View>
  );
}

/** The focused agent's composer, else the one of the workspace's most recently active agent. */
function useChat(hostId: string, workspaceId: string) {
  const [focused] = useComposers({ focused: true });
  const [recent] = useAgents({
    hosts: [hostId],
    where: (a) => a.workspaceId === workspaceId && !a.background && a.status !== "closed",
    orderBy: ["lastActivityAt", "desc"],
  });
  const [byAgent] = useComposers({ agentId: recent?.id ?? "" });
  return focused ?? byAgent;
}

/**
 * Records the simulator's screen to a video in the workspace's .paseo/recordings; stopping puts the
 * file's path in the chat, for an agent or a video model to look at.
 */
export function RecordButton({
  theme,
  hostId,
  deviceId,
  workspaceId,
}: {
  theme: PluginTheme;
  hostId: string;
  deviceId: string;
  workspaceId: string;
}) {
  const record = useRpc(recordRpc);
  const toast = useToast();
  const composer = useChat(hostId, workspaceId);
  // shortcut: kept in the panel, so closing it mid-recording loses the button's state; the daemon ends the recording after 5 minutes
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const busy = useRef(false);
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [since]);

  async function toggle() {
    if (busy.current) return; // the last press is still starting or stopping
    busy.current = true;
    const on = since === null;
    setSince(on ? Date.now() : null);
    try {
      const { path } = await record({ deviceId, on });
      if (on) return;
      if (composer) {
        // quoted when it has spaces, so an agent reads it as one path
        composer.insertText(path.includes(" ") ? `"${path}" ` : `${path} `);
        await composer.focus().catch(() => {});
        toast.show("Video path added to the chat", { variant: "success" });
      } else {
        await copyText(path);
        toast.show(`Saved ${path} (path copied)`, { variant: "success" });
      }
    } catch (error) {
      setSince(null);
      toast.error(message(error));
    } finally {
      busy.current = false;
    }
  }

  const seconds = since === null ? 0 : Math.max(0, Math.floor((now - since) / 1_000));
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <IconButton
        theme={theme}
        icon={since === null ? "Video" : "CircleStop"}
        label={since === null ? "Record a video" : "Stop recording"}
        onPress={() => void toggle()}
      />
      {since === null ? null : (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </Text>
      )}
    </View>
  );
}
