import AVFoundation
import CoreImage
import CoreMediaIO

// Captures a cabled iPhone's screen and streams it to the plugin server over a Unix socket.
// shortcut: it serves whoever starts it with a socket, so once camera access is granted any program
// running as this user can watch the cabled phone through it (as it can already take screenshots
// with devicectl). Check the peer's code signature if that has to be closed.
// Args: <socket path>. Wire format to the server: [u8 type][u32 big-endian length][payload]:
// 0 = JPEG frame, 1 = fatal message, 2 = recording finished (empty = ok, else error), 3 = pid.
// From the server: lines "name <device name>", "record <path>", "stop".

signal(SIGPIPE, SIG_IGN)
guard CommandLine.arguments.count > 1 else { exit(1) }
// kept for the life of the process: without it macOS naps a background app and frames slow down
let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "iPhone capture")

let session = AVCaptureSession()
// frames, and everything that touches the recording; each frame's buffers are freed as it ends
let queue = DispatchQueue(label: "capture", autoreleaseFrequency: .workItem)
let sendLock = NSLock(), quitLock = NSLock()
var fd: Int32 = -1
var recordPath: String?
var writer: AVAssetWriter?
var input: AVAssetWriterInput?

@Sendable func send(_ type: UInt8, _ payload: Data = Data()) {
  var message = Data([type]) + withUnsafeBytes(of: UInt32(payload.count).bigEndian) { Data($0) } + payload
  sendLock.lock()
  defer { sendLock.unlock() }
  // a failed write means the server closed the socket; the reader thread notices and quits
  while !message.isEmpty {
    let n = message.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    if n <= 0 { return }
    message = message.dropFirst(n)
  }
}

func finishRecording() {
  guard recordPath != nil else { return }
  recordPath = nil
  guard let w = writer, let i = input else { return send(2, Data("No frame arrived to record".utf8)) }
  (writer, input) = (nil, nil)
  i.markAsFinished()
  let done = DispatchSemaphore(value: 0)
  w.finishWriting { done.signal() }
  done.wait()
  send(2, Data((w.status == .completed ? "" : w.error?.localizedDescription ?? "The recording failed").utf8))
}

// The one way out: stop capturing, close the recording, say why, exit. Later callers wait for exit.
func quit(_ message: String? = nil) -> Never {
  quitLock.lock()
  session.stopRunning()
  queue.sync(execute: finishRecording)
  if let message { send(1, Data(message.utf8)) }
  exit(0)
}

final class Frames: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  let ci = CIContext()
  func captureOutput(_ o: AVCaptureOutput, didOutput sb: CMSampleBuffer, from c: AVCaptureConnection) {
    guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
    let (w, h) = (CVPixelBufferGetWidth(pb), CVPixelBufferGetHeight(pb))
    if let path = recordPath, writer == nil {
      try? FileManager.default.removeItem(atPath: path)
      do {
        let wr = try AVAssetWriter(url: URL(fileURLWithPath: path), fileType: .mp4)
        let inp = AVAssetWriterInput(mediaType: .video, outputSettings: [
          AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
        ])
        inp.expectsMediaDataInRealTime = true
        wr.add(inp)
        guard wr.startWriting() else { throw wr.error ?? CocoaError(.fileWriteUnknown) }
        wr.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sb))
        (writer, input) = (wr, inp)
      } catch {
        recordPath = nil
        send(2, Data(error.localizedDescription.utf8))
      }
    }
    if let inp = input, inp.isReadyForMoreMediaData { inp.append(sb) }
    // a smaller JPEG keeps the stream light; the recording above keeps the full size
    let k = min(1, 1568 / CGFloat(max(w, h)))
    let image = CIImage(cvPixelBuffer: pb).transformed(by: CGAffineTransform(scaleX: k, y: k))
    let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
    if let jpeg = ci.jpegRepresentation(of: image, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, options: [quality: 0.7]) {
      send(0, jpeg)  // blocks while the server is slow; with late frames discarded that drops frames
    }
  }
}

// --- connect, then read the server's commands on a thread ---
let path = Array(CommandLine.arguments[1].utf8CString)
var addr = sockaddr_un()
addr.sun_family = sa_family_t(AF_UNIX)
guard path.count <= MemoryLayout.size(ofValue: addr.sun_path) else { exit(1) }
withUnsafeMutableBytes(of: &addr.sun_path) { path.withUnsafeBytes($0.copyMemory) }
fd = socket(AF_UNIX, SOCK_STREAM, 0)
let connected = withUnsafePointer(to: &addr) {
  $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
}
guard connected == 0 else { exit(1) }

var name = ""
let named = DispatchSemaphore(value: 0)
Thread.detachNewThread {
  var pending = Data()
  var chunk = [UInt8](repeating: 0, count: 4096)
  while true {
    let n = read(fd, &chunk, chunk.count)
    if n <= 0 { quit() }
    pending += chunk[..<n]
    while let end = pending.firstIndex(of: 10) {
      let line = String(decoding: pending[..<end], as: UTF8.self)
      pending = Data(pending[(end + 1)...])
      if line.hasPrefix("name ") { name = String(line.dropFirst(5)); named.signal() }
      else if line.hasPrefix("record ") { let p = String(line.dropFirst(7)); queue.async { recordPath = p } }
      else if line == "stop" { queue.async(execute: finishRecording) }
    }
  }
}
send(3, Data(String(getpid()).utf8))
if named.wait(timeout: .now() + 10) != .success { quit() }

// --- permission, device, capture ---
let asked = DispatchSemaphore(value: 0)
var allowed = false
AVCaptureDevice.requestAccess(for: .video) { allowed = $0; asked.signal() }
asked.wait()
if !allowed { quit("Allow camera access for Simulator Studio Capture in System Settings › Privacy & Security › Camera") }

// the phone's screen is only offered as a capture device after this opt-in
var opt = CMIOObjectPropertyAddress(
  mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
  mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
  mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
var yes: UInt32 = 1
CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &opt, 0, nil, UInt32(MemoryLayout<UInt32>.size), &yes)

var phone: AVCaptureDevice?
for _ in 0..<20 where phone == nil {
  phone = AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: .muxed, position: .unspecified)
    .devices.first { $0.localizedName == name }
  if phone == nil { RunLoop.main.run(until: Date().addingTimeInterval(0.25)) }
}
guard let phone, let source = try? AVCaptureDeviceInput(device: phone) else { quit("Connect the iPhone with a cable and unlock it") }

let output = AVCaptureVideoDataOutput()
output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
output.alwaysDiscardsLateVideoFrames = true
let frames = Frames()
output.setSampleBufferDelegate(frames, queue: queue)
guard session.canAddInput(source), session.canAddOutput(output) else { quit("The iPhone could not be captured") }
session.addInput(source)
session.addOutput(output)
for note in [(AVCaptureSession.runtimeErrorNotification, session as AnyObject), (AVCaptureDevice.wasDisconnectedNotification, phone)] {
  NotificationCenter.default.addObserver(forName: note.0, object: note.1, queue: nil) { _ in quit("The iPhone was disconnected") }
}
session.startRunning()
dispatchMain()
