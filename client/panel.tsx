import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import { inputRpc, isPhone, teamRpc, type Assignment, type Device } from "../shared/contracts";
import { splitDevices } from "../shared/select";
import { canDuplicate, canTurnOff, canTurnOn, onFirst, useAction, useDeviceRpcs, useDevices } from "./data";
import { FastScreen, RecordButton } from "./fast";
import { LiveScreen } from "./live";
import { Button, Card, DeviceRow, IconButton, StatusLine } from "./ui";
import { desktop } from "./web";

type Workspace = { workspaceId: string; workspaceName: string; directory: string };

export function DevicePanel({ theme, layout, host, workspaceId }: PluginWorkspacePanelProps) {
  const ws = useWorkspace(workspaceId, (w) => ({ name: w.title ?? w.name, directory: w.directory }));
  const devices = useDevices(host.id);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // which way the shown device's last picture faced; a device not seen yet counts as portrait
  const [shape, setShape] = useState<{ deviceId: string; landscape: boolean } | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const c = theme.colors;
  if (!ws || !devices.data) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.surface0 }}>
        {devices.error ? (
          <Text style={{ color: c.statusDanger }}>{String(devices.error)}</Text>
        ) : (
          <ActivityIndicator color={c.foregroundMuted} />
        )}
      </View>
    );
  }
  const workspace: Workspace = { workspaceId, workspaceName: ws.name, directory: ws.directory };
  const { assignments, devices: all, team } = devices.data;
  // this workspace's devices in the order they were added; the panel shows one at a time
  const mine = assignments
    .filter((a) => a.workspaceId === workspaceId)
    .flatMap((a) => all.filter((d) => d.id === a.deviceId));
  const device = mine.find((d) => d.id === selected) ?? mine[0];
  // shortcut: Android and non-desktop clients keep the polling view; move them to streamSub when needed
  const fast = desktop && device?.platform === "ios";
  const phone = device !== undefined && isPhone(device.id);
  const landscape = shape !== null && shape.deviceId === device?.id && shape.landscape;
  const picker = (
    <DevicePicker
      theme={theme}
      hostId={host.id}
      workspace={workspace}
      devices={all}
      assignments={assignments}
      unavailable={[devices.data.ios, devices.data.android].filter((p) => !p.available).map((p) => p.reason)}
      onDone={(deviceId) => {
        setSelected(deviceId);
        setPicking(false);
      }}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0, padding: layout.compact ? 8 : 12, gap: 8 }}>
      {device ? (
        <>
          {mine.length > 1 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {mine.map((d) => (
                <Button
                  key={d.id}
                  theme={theme}
                  // two of one model: the iOS version tells them apart
                  label={
                    d.detail && mine.some((o) => o !== d && o.name === d.name)
                      ? `${d.name} · ${d.detail}`
                      : d.name
                  }
                  primary={d.id === device.id}
                  onPress={() => setSelected(d.id)}
                />
              ))}
            </View>
          ) : null}
          <Toolbar
            theme={theme}
            hostId={host.id}
            device={device}
            workspace={workspace}
            landscape={landscape}
            input={!phone || Boolean(team)}
            onAdd={() => setPicking(true)}
            onAnnotate={fast ? () => setAnnotating(!annotating) : undefined}
          />
          {phone ? <PhoneTouch theme={theme} hostId={host.id} team={team} /> : null}
          {/* agents' runner on an iPhone is signed with the team given for touch */}
          {phone && !team ? null : <AgentTools theme={theme} hostId={host.id} device={device} />}
          {device.state === "booted" ? (
            // keyed: a new device starts with an empty picture, not taps on the old one's
            <>
              {fast ? (
                <FastScreen
                  // remounted when touch is set up: its handlers are made once
                  key={phone ? `${device.id}:${team}` : device.id}
                  touch={phone ? (team ? "whole" : "off") : "live"}
                  theme={theme}
                  hostId={host.id}
                  deviceId={device.id}
                  workspaceId={workspaceId}
                  annotating={annotating}
                  onShape={(wide) => setShape({ deviceId: device.id, landscape: wide })}
                  onDone={() => setAnnotating(false)}
                />
              ) : (
                <LiveScreen
                  key={device.id}
                  theme={theme}
                  deviceId={device.id}
                  onShape={(wide) => setShape({ deviceId: device.id, landscape: wide })}
                />
              )}
              {layout.compact && Platform.OS !== "web" ? (
                <Text style={{ color: c.foregroundMuted, fontSize: 12, textAlign: "center" }}>
                  Swipe sideways with two fingers: one finger moves Paseo's panels.
                </Text>
              ) : null}
            </>
          ) : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 16 }}>
              {canTurnOn(device) ? <BootButton theme={theme} hostId={host.id} device={device} /> : null}
              {phone ? (
                <Text style={{ color: c.foregroundMuted, textAlign: "center" }}>
                  Connect the iPhone to this Mac and unlock it.
                </Text>
              ) : null}
              {device.state === "booting" ? <ActivityIndicator color={c.foregroundMuted} /> : null}
            </View>
          )}
          <Modal title="Add a device to this workspace" open={picking} onOpenChange={setPicking}>
            <Modal.Content>{picker}</Modal.Content>
          </Modal>
        </>
      ) : (
        <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 24 }}>
          <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>
            Pick a device for {ws.name}
          </Text>
          <Text style={{ color: c.foregroundMuted }}>
            It stays with this workspace: other workspaces can't take it without asking. Once you allow agent
            tools on it, agents you start here can drive it too.
          </Text>
          {picker}
        </ScrollView>
      )}
    </View>
  );
}

/** What agent-device installs on a device the first time an agent drives it. */
const installs = (device: Device) =>
  isPhone(device.id)
    ? "agent-device builds its XCTest runner app with Xcode, signs it with your Apple developer team and installs it on the iPhone. On your own phone agents can then do anything agent-device can: open, install or remove any app, read the screen (messages and notifications included), app logs and files, record the screen and change settings. What they read goes to their model provider. Agents already running need a restart to get the phone."
    : device.platform === "ios"
      ? "agent-device builds its XCTest runner app with Xcode on this Mac and installs it on the simulator."
      : `agent-device installs two helper apps it ships with on the ${device.kind === "physical" ? "phone" : "emulator"}: one that reads the screen's layout and one keyboard for typing.`;

/**
 * Whether agents started in this workspace get tools to drive the device. Off until the user allows
 * it here: the first time an agent uses a device, agent-device installs its helpers on it.
 */
function AgentTools({ theme, hostId, device }: { theme: PluginTheme; hostId: string; device: Device }) {
  const { agentTools } = useDeviceRpcs();
  const { busy, perform } = useAction(hostId);
  const [asking, setAsking] = useState(false);
  const c = theme.colors;
  const set = async (allow: boolean) => {
    if (await perform(() => agentTools({ deviceId: device.id, allow }))) setAsking(false);
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <Icon name={device.agentTools ? "Bot" : "BotOff"} size={14} color={c.foregroundMuted} />
      <Text style={{ color: c.foregroundMuted, fontSize: 12, flex: 1, minWidth: 160 }}>
        {device.agentTools
          ? "Agents you start in this workspace can drive this device."
          : "Agents can't drive this device yet."}
      </Text>
      {device.agentTools ? (
        <Button theme={theme} label="Turn off" disabled={busy} onPress={() => void set(false)} />
      ) : (
        <Button theme={theme} icon="Bot" label="Set up agent tools" onPress={() => setAsking(true)} />
      )}
      <Modal
        title="Let agents drive this device?"
        open={asking}
        onOpenChange={(open) => !open && !busy && setAsking(false)}
      >
        <Modal.Content>
          <Text style={{ color: c.foreground, lineHeight: 20 }}>
            Agents you start in this workspace get agent-device tools to read, tap and type on {device.name}.
            The first time one does, {installs(device)} Nothing is downloaded.
          </Text>
          <Text style={{ color: c.foregroundMuted, lineHeight: 20 }}>
            Agents that were started without device tools need a restart to get them. With several devices
            here, agents drive one at a time and switch between those you allowed. Turning this off takes the
            device away from every agent; helpers already installed stay on it.
          </Text>
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Button theme={theme} label="Not now" disabled={busy} onPress={() => setAsking(false)} />
            <Button
              theme={theme}
              primary
              label="Allow agent tools"
              disabled={busy}
              onPress={() => void set(true)}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

/**
 * Touch on a physical iPhone goes through agent-device's test runner, signed with the user's Apple
 * developer team and installed on the phone. Off until they give the team here.
 */
function PhoneTouch({ theme, hostId, team }: { theme: PluginTheme; hostId: string; team: string }) {
  const save = useRpc(teamRpc);
  const { busy, perform } = useAction(hostId);
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState(team);
  const c = theme.colors;
  const valid = /^[A-Z0-9]{10}$/.test(text);
  const set = async (value: string) => {
    if (await perform(() => save({ team: value }))) setAsking(false);
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <Icon name="Pointer" size={14} color={c.foregroundMuted} />
      <Text style={{ color: c.foregroundMuted, fontSize: 12, flex: 1, minWidth: 160 }}>
        {team
          ? "Taps and swipes reach the iPhone after you let go, about a second each."
          : "Watch only: touch isn't set up for iPhones."}
      </Text>
      {team ? (
        <Button theme={theme} label="Turn off" disabled={busy} onPress={() => void set("")} />
      ) : (
        <Button theme={theme} icon="Pointer" label="Set up touch" onPress={() => setAsking(true)} />
      )}
      <Modal
        title="Control the iPhone from here?"
        open={asking}
        onOpenChange={(open) => !open && !busy && setAsking(false)}
      >
        <Modal.Content>
          <Text style={{ color: c.foreground, lineHeight: 20 }}>
            On your first tap, agent-device builds its test runner app with Xcode, signs it with your Apple
            developer team and installs it on the iPhone. That registers an app ID in the team and takes about
            half a minute. Nothing is downloaded.
          </Text>
          <Text style={{ color: c.foregroundMuted, lineHeight: 20 }}>
            The iPhone must be on a cable, unlocked and in portrait, with Developer Mode on. If this Mac asks
            for it, run "sudo DevToolsSecurity -enable" in Terminal once. Turning this off stops touch; the
            runner app stays on the phone.
          </Text>
          <TextInput
            value={text}
            onChangeText={(value) => setText(value.trim().toUpperCase())}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="Team ID, 10 characters (Xcode › Settings › Accounts)"
            placeholderTextColor={c.foregroundMuted}
            style={{
              color: c.foreground,
              backgroundColor: c.surface2,
              borderColor: c.border,
              borderWidth: 1,
              borderRadius: 8,
              padding: 10,
            }}
          />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Button theme={theme} label="Not now" disabled={busy} onPress={() => setAsking(false)} />
            <Button
              theme={theme}
              primary
              label="Allow touch"
              disabled={!valid || busy}
              onPress={() => void set(text)}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function BootButton({ theme, hostId, device }: { theme: PluginTheme; hostId: string; device: Device }) {
  const { power } = useDeviceRpcs();
  const { busy, perform } = useAction(hostId);
  return (
    <Button
      theme={theme}
      primary
      icon="Power"
      label="Turn on"
      disabled={busy}
      onPress={() => void perform(() => power({ deviceId: device.id, action: "boot" }))}
    />
  );
}

function Toolbar({
  theme,
  hostId,
  device,
  workspace,
  landscape,
  input: canInput,
  onAdd,
  onAnnotate,
}: {
  theme: PluginTheme;
  hostId: string;
  device: Device;
  workspace: Workspace;
  // from the last picture, so it is right after a remount too
  landscape: boolean;
  // false for an iPhone without touch set up: nothing here could reach it
  input: boolean;
  onAdd(): void;
  onAnnotate?(): void;
}) {
  const { power, assign } = useDeviceRpcs();
  const input = useRpc(inputRpc);
  const { busy, perform } = useAction(hostId);
  const [typing, setTyping] = useState(false);
  const [more, setMore] = useState(false);
  const [text, setText] = useState("");
  const c = theme.colors;
  const on = device.state === "booted";
  const key = (button: "home" | "back" | "appSwitch") =>
    void perform(
      () => input({ deviceId: device.id, input: { kind: "button", button } }).then(() => ({ message: "" })),
      true,
    );
  const rotate = () =>
    void perform(
      () =>
        input({
          deviceId: device.id,
          input: { kind: "rotate", orientation: landscape ? "portrait" : "landscape" },
        }).then(() => ({ message: "" })),
      true,
    );
  async function sendText() {
    const value = text;
    if (!value) return;
    const ok = await perform(
      () =>
        input({ deviceId: device.id, input: { kind: "text", text: value } }).then(() => ({ message: "" })),
      true,
    );
    if (ok) {
      setText("");
      setTyping(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      {/* the device's own buttons, then More for the rest, on one line: the name gives way */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: c.foreground, fontWeight: "600" }} numberOfLines={1}>
            {device.name}
          </Text>
          <StatusLine theme={theme} device={device} lines={1} />
        </View>
        {on ? (
          <>
            {canInput ? (
              <IconButton theme={theme} icon="House" label="Home" onPress={() => key("home")} />
            ) : null}
            {device.platform === "android" ? (
              <IconButton theme={theme} icon="ArrowLeft" label="Back" onPress={() => key("back")} />
            ) : null}
            {device.platform === "android" ? (
              <IconButton theme={theme} icon="Layers" label="Recent apps" onPress={() => key("appSwitch")} />
            ) : null}
            {isPhone(device.id) ? null : (
              <IconButton theme={theme} icon="RotateCw" label="Rotate" onPress={rotate} />
            )}
            {onAnnotate ? (
              <IconButton theme={theme} icon="Pencil" label="Draw on a screenshot" onPress={onAnnotate} />
            ) : null}
            {onAnnotate ? (
              <RecordButton
                key={device.id} // a recording belongs to one device
                theme={theme}
                hostId={hostId}
                deviceId={device.id}
                workspaceId={workspace.workspaceId}
              />
            ) : null}
            {canInput ? (
              <IconButton theme={theme} icon="Keyboard" label="Type text" onPress={() => setTyping(true)} />
            ) : null}
          </>
        ) : null}
        <IconButton
          theme={theme}
          icon={more ? "ChevronUp" : "Ellipsis"}
          label={more ? "Fewer actions" : "More actions"}
          onPress={() => setMore(!more)}
        />
      </View>
      {more ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button theme={theme} icon="Plus" label="Add device" onPress={onAdd} />
          {canTurnOff(device) ? (
            <Button
              theme={theme}
              icon="PowerOff"
              label="Turn off device"
              disabled={busy}
              onPress={() => void perform(() => power({ deviceId: device.id, action: "shutdown" }))}
            />
          ) : null}
          <Button
            theme={theme}
            icon="Unlink"
            label="Release device"
            disabled={busy}
            onPress={() =>
              void perform(() =>
                assign({ ...workspace, deviceId: device.id, takeOver: false, release: true }),
              )
            }
          />
        </View>
      ) : null}
      <Modal title="Type on the device" open={typing} onOpenChange={setTyping}>
        <Modal.Content>
          <Text style={{ color: c.foregroundMuted }}>Goes to whatever field has focus on the device.</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={() => void sendText()}
            placeholder="Text to type"
            placeholderTextColor={c.foregroundMuted}
            style={{
              color: c.foreground,
              backgroundColor: c.surface2,
              borderColor: c.border,
              borderWidth: 1,
              borderRadius: 8,
              padding: 10,
            }}
          />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Button theme={theme} label="Cancel" onPress={() => setTyping(false)} />
            <Button
              theme={theme}
              primary
              label="Type"
              disabled={!text || busy}
              onPress={() => void sendText()}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function DevicePicker({
  theme,
  hostId,
  workspace,
  devices,
  assignments,
  unavailable,
  onDone,
}: {
  theme: PluginTheme;
  hostId: string;
  workspace: Workspace;
  devices: Device[];
  assignments: Assignment[];
  unavailable: string[];
  onDone(deviceId: string): void;
}) {
  const { assign, create, power } = useDeviceRpcs();
  const { busy, perform } = useAction(hostId);
  const [confirm, setConfirm] = useState<{ device: Device; holder: Assignment } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const c = theme.colors;
  const holderOf = (d: Device) => assignments.find((a) => a.deviceId === d.id);

  async function use(device: Device, takeOver: boolean) {
    const ok = await perform(() => assign({ ...workspace, deviceId: device.id, takeOver, release: false }));
    if (!ok) return;
    if (canTurnOn(device)) await perform(() => power({ deviceId: device.id, action: "boot" }), true);
    setConfirm(null);
    onDone(device.id);
  }
  async function duplicate(device: Device) {
    const created = await perform(() => create({ ...workspace, from: device.id }));
    if (created) onDone(created.deviceId);
  }

  const { main, rest } = splitDevices(devices, new Set(assignments.map((a) => a.deviceId)));
  const shown = showAll ? devices : main;
  const groups: [string, Device[]][] = [
    ["iOS", onFirst(shown.filter((d) => d.platform === "ios"))],
    ["Android", onFirst(shown.filter((d) => d.platform === "android"))],
  ];

  return (
    <View style={{ gap: 12 }}>
      {unavailable.map((reason) => (
        <Text key={reason} style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {reason}
        </Text>
      ))}
      {groups.map(([title, list]) =>
        list.length ? (
          <View key={title} style={{ gap: 6 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{title}</Text>
            <Card theme={theme}>
              {list.map((d, index) => {
                const held = holderOf(d);
                // this workspace's own devices stay listed as sources for New copy
                const own = held?.workspaceId === workspace.workspaceId;
                const holder = own ? undefined : held;
                return (
                  <DeviceRow
                    key={d.id}
                    theme={theme}
                    device={d}
                    first={index === 0}
                    note={own ? "in this workspace" : holder && `in use by ${holder.workspaceName}`}
                    warn={Boolean(holder)}
                  >
                    {canDuplicate(d) ? (
                      <Button
                        theme={theme}
                        icon="Copy"
                        label="New copy"
                        disabled={busy}
                        onPress={() => void duplicate(d)}
                      />
                    ) : null}
                    {own ? null : (
                      <Button
                        theme={theme}
                        primary={!holder}
                        label={holder ? "Take over" : "Use"}
                        disabled={busy}
                        onPress={() => (holder ? setConfirm({ device: d, holder }) : void use(d, false))}
                      />
                    )}
                  </DeviceRow>
                );
              })}
            </Card>
          </View>
        ) : null,
      )}
      {rest.length ? (
        <View style={{ alignItems: "flex-start" }}>
          <Button
            theme={theme}
            label={showAll ? "Show fewer" : `Show all ${devices.length} devices`}
            onPress={() => setShowAll(!showAll)}
          />
        </View>
      ) : null}
      <Modal
        title="Take over this device?"
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <Modal.Content>
          <Text style={{ color: c.foreground, lineHeight: 20 }}>
            {confirm?.device.name} belongs to {confirm?.holder.workspaceName}. Taking it moves it here; agents
            there lose it. "New copy" gives this workspace its own device instead.
          </Text>
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
            <Button theme={theme} label="Cancel" onPress={() => setConfirm(null)} />
            {confirm && canDuplicate(confirm.device) ? (
              <Button theme={theme} label="New copy" onPress={() => void duplicate(confirm.device)} />
            ) : null}
            <Button
              theme={theme}
              danger
              label="Take over"
              disabled={busy}
              onPress={() => confirm && void use(confirm.device, true)}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
