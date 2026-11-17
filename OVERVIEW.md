Simulator Studio shows an iOS simulator inside Paseo at the simulator's own frame rate, about 60
frames a second, with touch that follows the pointer. You can draw on a screenshot or record the
screen and hand either to an agent without leaving the workspace. It is built on the
[Devices](https://github.com/ZedObaia/paseo-plugins/tree/main/plugins/devices) plugin by Zeyad Obaia
and keeps everything that plugin does.

## What it adds

These work in the Paseo desktop app on a Mac, for iOS simulators.

- **Fast live view.** The picture is pushed to the panel as the simulator draws it. It pauses while
  the panel is hidden or the window is in the background.
- **Live touch.** Pressing, dragging and releasing reach the simulator as they happen, so scrolling
  follows the pointer.
- **Draw on a screenshot.** The pencil button freezes the picture. Draw with a pen, line, arrow,
  rectangle, ellipse, numbered step or text, in six colours and four thicknesses. **Add to chat**
  pastes the picture with your drawing into an agent's message box as an image. When no agent is in
  reach it is copied for you to paste.
- **Record the screen.** The camera button records with Xcode's own recorder into the workspace's
  `.paseo/recordings` folder and puts the video's path in the chat. The folder is added to the
  repository's local exclude file, so videos stay out of git and your `.gitignore` is untouched.
  Recordings stop by themselves after 5 minutes.

- **A real iPhone or iPad on a cable.** It appears in the device list next to the simulators, with
  the same fast view, pencil and record button. Touch is optional and slower: after you give your
  Apple developer Team ID in the panel, taps, long presses, swipes, typed text and Home reach the
  phone when you let go, about a second each, in portrait. Once touch is set up you can also let agents in the phone's workspace drive it, like a simulator.

Android devices, and Paseo on a phone or in a browser, use the slower live view described below.

## Use it instead of Devices

Simulator Studio and Devices give agents the same device tools, so run one of them. Turn Devices
off before turning this on. Simulator Studio keeps its own list of which workspace holds which
device, so pick your devices again after switching.

## Everything from Devices

It puts iOS simulators and Android emulators inside Paseo, as many per workspace as you
need, with a live view you can tap, swipe and type into from desktop or phone, and tools your
agents use to drive the same devices.

Open **Device** with the phone button in a workspace's header, which shows the device's name, or
how many it has, from the Explorer's + menu beside Files and Changes, or with Command Center,
"Open device", and pick a device. It opens next to the agent, so you can watch both. On a phone or a
narrow window it opens as a workspace tab, and on a phone the header button is the way to it. The
workspace's own + menu opens it as a tab anywhere. In Paseo's phone app a one-finger swipe sideways
moves Paseo's own panels, so swipe sideways on the device with two fingers.

To test on several platforms or screen sizes, add more devices from the panel's **Add device**; they
all run at once and the panel switches between them, one live view at a time. A device stays with
its workspace: another workspace sees it as in use and has to take it over explicitly, or press
**New copy** to get its own simulator (same model and iOS version) or another instance of the same
emulator, so parallel workspaces each test on their own. A device that leaves the host, like an
unplugged phone, stays with its workspace as a missing device until it returns or you release it.

Agents can drive a workspace's devices with
[agent-device](https://github.com/callstack/agent-device) tools: accessibility snapshots, taps,
typing, app launches and screenshots. Agent tools are off until you allow them on a device from its
panel, which first explains what agent-device will install there. Agents started in the workspace
after that get the tools, and they only reach that workspace's devices you allowed, one at a time:
they switch between them with a picker tool. When a device is released, taken over or deleted, their
device tools stop reaching it and move to another of the workspace's devices you allowed, if there
is one; an emulator that is off can't be driven until it is turned on. Agents can also add a device
themselves, but only one you allowed agents on that no other workspace holds: it joins the
workspace, as if you had added it in the panel, and a simulator or emulator that is off is turned
on.

The **Devices** screen lists every simulator and emulator on the host, which workspace holds it,
and turns them on or off. Devices made with New copy can be deleted there. An emulator copy runs
read-only, so it keeps nothing once it stops. When a workspace is archived, its devices are released
and copies made for it are turned off; a simulator copy keeps its data until you delete it.

## Requirements

- Paseo 0.16.0-beta.2 or newer, on the host and in the app.
- iOS: a Mac with Apple silicon and Xcode. The live view uses
  [serve-sim](https://github.com/EvanBacon/serve-sim), which needs Simulator.app (the plugin keeps
  it running hidden) and, when Paseo runs as the desktop app, Node.js 20 or newer in PATH.
- A real iPhone or iPad: paired with this Mac, on a cable, unlocked, with the Paseo desktop app.
  The first view compiles a small capture helper with Xcode's Swift compiler and macOS asks once (and again after an update that changes the helper)
  to let "Simulator Studio Capture" use the camera, which is how macOS offers a cabled phone's
  screen. Touch also needs Developer Mode on the phone, an Apple developer team, and developer
  mode for Apple's tools on the Mac (`sudo DevToolsSecurity -enable`).
- Android: the Android SDK (adb, and the emulator package for AVDs). USB devices work too, at
  about one frame a second, and can't be turned on or off from here.
- Agent tools run on the daemon's Node.js, which needs to be 22.12 or newer; the desktop app's
  built-in runtime is.

## Security, data and installs

Emulators started here run headless, with their control port bound to localhost and protected by
a token. The iOS live view runs serve-sim in a helper process that listens only on a Unix socket in
a folder only your user can open. It has no network port, so web pages and other machines can't
reach it. The helper stops about 30 seconds after the last panel showing a simulator closes, and
when the plugin stops. Agents reach the plugin's picker through a small helper over another such
Unix socket: it lists the devices you allowed agents on, switches the agent's workspace between
its own, and gives a free one to it, nothing else.

Frames and input travel between the host and your Paseo apps. An image you add to a chat goes to that agent's model provider like any other image you paste. A recording stays on the host; an agent that reads the video sends what it reads to its model provider. The recorder only writes inside the folder Paseo lists for the workspace, and refuses a recordings folder that is a symbolic link. What agents read through the device
tools, including screenshots and screen text, is sent to the agent's model provider like any other
tool result. So are the names and states of the devices you allowed agents on, and which workspace
holds each, when an agent lists them.

A cabled iPhone's screen is read by a separate helper app the plugin builds from its own source
on first use and keeps in Paseo's plugin data folder. It sends pictures to the plugin over a Unix
socket in a folder only your user can open, runs only while a panel shows the phone or a recording
you started is running, and stops a few seconds after. Its camera permission belongs to that
helper: once you allow it, other programs running as your user could start it to watch the cabled
phone too, as they can already take screenshots of it with Xcode's tools. A recording is written
by the helper to a temporary folder and moved into the workspace by the plugin. Everything shown on
the phone, notifications included, is in what you draw on or record. Touch on an iPhone is off
until you save a Team ID: on the first tap agent-device builds its XCTest runner with Xcode, signs
it with that team (which registers an app ID there) and installs it on the phone. Agents get the phone only if you also allow agent tools on it, and then only agents started in the workspace holding it are given the plugin's tools for it. On your own phone they can do anything agent-device can: open, install or remove any app, read the screen (messages and notifications included), app logs and files, record the screen and change settings. What they read goes to their model provider. Clearing or changing the Team ID takes every iPhone away from agents, and an unused control session on the phone ends after 30 minutes. This steers the tools the plugin hands out; it is not a wall around the phone: an agent that can run commands on your Mac can use Xcode's own tools on any paired device, with or without this plugin.

The first time an agent drives a device, agent-device installs its helpers on it: an XCTest runner
app it builds locally with Xcode for iOS, and two helper apps it ships with for Android (one reads
the screen's layout, one is a keyboard for typing). This only happens on a device you allowed agent
tools on; turning them off doesn't remove helpers already installed. Nothing is downloaded while
the plugin runs.
