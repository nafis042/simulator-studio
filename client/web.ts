import { Platform } from "react-native";
import { latestWins } from "../shared/latest";

// The only file with DOM globals (the tsconfig has no DOM lib), typed loosely on purpose.
declare const document: any;
declare const navigator: any;
declare const ResizeObserver: any;
declare const createImageBitmap: any;
declare const Blob: any;
declare const File: any;
declare const DataTransfer: any;
declare const ClipboardEvent: any;
declare const ClipboardItem: any;

type Phase = "begin" | "move" | "end";
type Point = { x: number; y: number };
export type Tool = "pen" | "line" | "arrow" | "rect" | "ellipse" | "step" | "text";
type Shape = { tool: Tool; color: string; width: number; points: Point[]; text?: string };
export type Screen = {
  frame(bytes: Uint8Array): void;
  ready(): boolean;
  annotate(on: boolean): void;
  style(tool: Tool, color: string, width: number): void;
  undo(): void;
  png(): Promise<unknown>;
  destroy(): void;
};

/** The Paseo desktop app (Electron): the only client that gets the fast live view. */
export const desktop = Platform.OS === "web" && /Electron/.test(navigator.userAgent);

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Draws the stream into canvases inside `host` (the DOM node behind a React Native Web View with no
 * children): newest frame wins, one decode at a time. Pointer events become touches, or pen strokes
 * while annotating (the picture then stays frozen). Null anywhere but the desktop app.
 */
export function mountScreen(
  host: unknown,
  on: {
    touch(phase: Phase, x: number, y: number): void;
    shape(landscape: boolean): void;
    visible(v: boolean): void;
  },
): Screen | null {
  if (!desktop) return null;
  const parent = host as any;
  const wrapper = document.createElement("div");
  const view = document.createElement("canvas");
  const ink = document.createElement("canvas");
  Object.assign(wrapper.style, {
    position: "relative",
    borderRadius: "18px",
    overflow: "hidden",
    background: "black",
    touchAction: "none",
  });
  for (const canvas of [view, ink]) {
    Object.assign(canvas.style, { position: "absolute", left: 0, top: 0, width: "100%", height: "100%" });
    wrapper.append(canvas);
  }
  parent.append(wrapper);

  let latest: Uint8Array | undefined;
  let drawn = false;
  let frozen = false;
  let shapes: Shape[] = [];
  let pen = { tool: "pen" as Tool, color: "", width: 4 }; // the selection, set by style()
  let pointer: number | null = null; // the pointer that is down
  let at: Point = { x: 0, y: 0 };

  // the picture, as big as fits the host
  const fit = () => {
    if (!drawn) return;
    const scale = Math.min(parent.clientWidth / view.width, parent.clientHeight / view.height);
    wrapper.style.width = `${Math.floor(view.width * scale)}px`;
    wrapper.style.height = `${Math.floor(view.height * scale)}px`;
  };
  const lift = () => {
    if (pointer === null) return;
    pointer = null;
    if (!frozen) on.touch("end", at.x, at.y); // a pen stroke never began a touch
  };
  const look = () => {
    const visible = parent.clientWidth > 0 && parent.clientHeight > 0 && !document.hidden;
    if (!visible) lift();
    on.visible(visible);
  };
  const observer = new ResizeObserver(() => (fit(), look()));
  observer.observe(parent);
  document.addEventListener("visibilitychange", look);

  const decode = latestWins(async () => {
    const bytes = latest;
    if (frozen || !bytes) return;
    const bitmap = await createImageBitmap(new Blob([bytes.subarray(1)], { type: "image/jpeg" }));
    try {
      if (frozen) return;
      const turned = bytes[0] === 1;
      const w = turned ? bitmap.height : bitmap.width;
      const h = turned ? bitmap.width : bitmap.height;
      drawn = true; // before fit(), which waits for the first picture
      if (view.width !== w || view.height !== h) {
        view.width = ink.width = w;
        view.height = ink.height = h;
        on.shape(w > h);
        fit();
      }
      const c = view.getContext("2d");
      // the portrait picture turned 90 degrees clockwise: (x, y) -> (w - y, x)
      c.setTransform(...(turned ? [0, 1, -1, 0, w, 0] : [1, 0, 0, 1, 0, 0]));
      c.drawImage(bitmap, 0, 0);
    } finally {
      bitmap.close();
    }
  });
  const redraw = () => {
    const c = ink.getContext("2d");
    const k = ink.width / wrapper.clientWidth;
    c.clearRect(0, 0, ink.width, ink.height);
    c.lineCap = c.lineJoin = "round";
    for (const { tool, color, width, points, text } of shapes) {
      const pts = points.map((p) => ({ x: p.x * ink.width, y: p.y * ink.height }));
      const a = pts[0];
      const b = pts[pts.length - 1];
      c.strokeStyle = c.fillStyle = color;
      c.lineWidth = width * k;
      c.beginPath();
      if (tool === "rect") c.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      else if (tool === "ellipse")
        c.ellipse(
          (a.x + b.x) / 2,
          (a.y + b.y) / 2,
          Math.abs(b.x - a.x) / 2,
          Math.abs(b.y - a.y) / 2,
          0,
          0,
          2 * Math.PI,
        );
      else if (tool === "step") c.arc(a.x, a.y, (8 + 2 * width) * k, 0, 2 * Math.PI);
      else if (tool !== "text") {
        c.moveTo(a.x, a.y);
        for (const p of pts) c.lineTo(p.x, p.y);
        const t = Math.atan2(b.y - a.y, b.x - a.x);
        if (tool === "arrow")
          for (const d of [-0.5, 0.5]) {
            c.moveTo(b.x, b.y);
            c.lineTo(
              b.x - (8 + 2 * width) * k * Math.cos(t + d),
              b.y - (8 + 2 * width) * k * Math.sin(t + d),
            );
          }
      }
      if (tool === "step") c.fill();
      else if (tool !== "text") c.stroke();
      if (!text) continue;
      const step = tool === "step";
      c.fillStyle = step ? (color === "#FFFFFF" ? "#000000" : "#FFFFFF") : color;
      c.font = `${step ? (8 + 2 * width) * k : (10 + 3 * width) * k}px sans-serif`;
      c.textAlign = step ? "center" : "left";
      c.textBaseline = step ? "middle" : "top";
      c.fillText(text, a.x, a.y);
    }
  };
  // a text field at `a` in the shape's colour and size; Enter or blur commits it, Escape cancels
  const type = (a: Point) => {
    const { color, width } = pen;
    const input = document.createElement("input");
    Object.assign(input.style, {
      position: "absolute",
      left: `${a.x * 100}%`,
      top: `${a.y * 100}%`,
      width: `${(1 - a.x) * 100}%`,
      font: `${10 + 3 * width}px sans-serif`,
      lineHeight: 1,
      color,
      background: "transparent",
      border: 0,
      outline: "none",
      padding: 0,
    });
    const end = (ok: boolean) => {
      input.onblur = null; // remove() blurs
      input.remove();
      if (ok && input.value) (shapes.push({ ...pen, points: [a], text: input.value }), redraw());
    };
    input.onpointerdown = (e: any) => e.stopPropagation();
    input.onblur = () => end(true);
    // returns nothing: a `false` return from an on* handler cancels the keystroke
    input.onkeydown = (e: any) => void (e.key === "Enter" ? end(true) : e.key === "Escape" && end(false));
    wrapper.append(input);
    setTimeout(() => input.focus()); // after the click's own focus change
  };

  const pos = (e: any): Point => ({
    x: clamp(e.offsetX / wrapper.clientWidth),
    y: clamp(e.offsetY / wrapper.clientHeight),
  });
  // button is only meaningful on pointerdown (it is -1 on move)
  wrapper.addEventListener("pointerdown", (e: any) => {
    if (pointer !== null || !e.isPrimary || e.button !== 0) return;
    pointer = e.pointerId;
    wrapper.setPointerCapture(e.pointerId);
    at = pos(e);
    if (!frozen) on.touch("begin", at.x, at.y);
    else if (pen.tool === "text") (type(at), (pointer = null));
    else {
      const text =
        pen.tool === "step" ? String(shapes.filter((s) => s.tool === "step").length + 1) : undefined;
      shapes.push({ ...pen, points: pen.tool === "pen" ? [at] : [at, at], text });
      redraw();
    }
  });
  wrapper.addEventListener("pointermove", (e: any) => {
    if (e.pointerId !== pointer) return;
    at = pos(e);
    if (!frozen) on.touch("move", at.x, at.y);
    else {
      const { tool, points } = shapes[shapes.length - 1];
      if (tool === "pen") points.push(at);
      else points[1] = at;
      redraw();
    }
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    wrapper.addEventListener(type, (e: any) => {
      if (e.pointerId !== pointer) return;
      if (frozen) pointer = null;
      else lift();
    });

  return {
    frame(bytes) {
      latest = bytes;
      void decode().catch(() => {}); // a frame that won't decode is skipped
    },
    ready: () => drawn,
    annotate(annotating) {
      if (annotating) lift(); // while still live, so the touch is ended
      frozen = annotating;
      if (annotating) return;
      wrapper.querySelector("input")?.blur(); // commits a text being typed, cleared below
      shapes = [];
      redraw();
      void decode().catch(() => {});
    },
    style: (tool, color, width) => void (pen = { tool, color, width }),
    undo() {
      shapes.pop();
      redraw();
    },
    png: () => {
      const scale = Math.min(1, 1568 / Math.max(view.width, view.height));
      const out = document.createElement("canvas");
      out.width = Math.round(view.width * scale);
      out.height = Math.round(view.height * scale);
      const c = out.getContext("2d");
      for (const layer of [view, ink]) c.drawImage(layer, 0, 0, out.width, out.height);
      return new Promise((resolve) => out.toBlob(resolve, "image/png"));
    },
    destroy() {
      lift();
      observer.disconnect();
      document.removeEventListener("visibilitychange", look);
      wrapper.remove();
    },
  };
}

/** Pastes the picture into whatever has focus, as a pasted image file; false if nothing took it. */
export function pasteImage(blob: unknown): boolean {
  const clipboardData = new DataTransfer();
  // Paseo's paste handler skips files without a type
  clipboardData.items.add(new File([blob], "simulator.png", { type: "image/png" }));
  const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
  document.activeElement?.dispatchEvent(event);
  return event.defaultPrevented;
}

export const copyImage = (blob: unknown): Promise<void> =>
  navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
