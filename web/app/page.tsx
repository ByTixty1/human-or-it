"use client";
import { useEffect, useState } from "react";
import { io, Socket } from "socket.io-client";

type Msg = { from: "me" | "peer"; text: string; ts: number };

export default function Page() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<string | null>(null);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<"lobby" | "chat" | "reveal">("lobby");
  const [reveal, setReveal] = useState<{ truth: "IT" | "NOT_IT"; correct: boolean } | null>(null);
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001";
    const s = io(url, {
      path: "/socket.io",
      transports: ["polling"],       // keep polling in dev; switch to ['websocket','polling'] later
      upgrade: false,
      withCredentials: false,
      reconnectionAttempts: 5,
      reconnectionDelay: 600,
      timeout: 10000,
      forceNew: true
    });

    setSocket(s);
    s.on("connect", () => { console.log("[client] connected", s.id); setConnected(true); });
    s.on("disconnect", () => { console.log("[client] disconnected"); setConnected(false); });
    s.on("connect_error", (err) => console.error("[client] connect_error:", err.message));
    s.on("error", (e) => console.error("[client] error:", e));

    s.on("start", ({ room, endsAt }) => {
      setRoom(room); setEndsAt(endsAt); setMsgs([]); setPhase("chat");
    });
    s.on("msg", (m: { from: "peer"; text: string; ts: number }) =>
      setMsgs((p) => [...p, { from: "peer", text: m.text, ts: m.ts }])
    );
    s.on("typing", ({ on }) => setTyping(!!on));
    s.on("reveal", (r) => { setReveal(r); setPhase("reveal"); });

    return () => { s.disconnect(); };
  }, []);

  const now = useNow(200);
  const msLeft = endsAt ? Math.max(0, endsAt - now) : 0;

  const send = () => {
    if (!socket || !room || !input.trim()) return;
    const text = input.trim();
    setMsgs((p) => [...p, { from: "me", text, ts: Date.now() }]);
    socket.emit("msg", { room, text });
    setInput("");
  };

  const join = () => { if (socket) socket.emit("join"); };
  const guess = (choice: "IT" | "NOT_IT") =>
    room && socket?.emit("guess", { room, choice });

  return (
    <main className="mx-auto max-w-2xl p-6 space-y-6 text-white">
      <h1 className="text-2xl font-bold">
        Am I talking to an <span className="underline">IT</span> student?
      </h1>

      {phase === "lobby" && (
        <div className="space-y-4">
          <p className="text-sm text-white/60">
            {connected ? "Connected ✓" : "Connecting…"} Chat 120s with a student (IT/IS/CS). Then guess if they’re IT or not.
          </p>
          <button
            onClick={join}
            disabled={!connected}
            className="px-4 py-2 rounded-xl border border-white/30 hover:bg-white/10 disabled:opacity-50"
          >
            Start
          </button>
        </div>
      )}

      {phase === "chat" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-white/70">
            <span className="text-sm">Room: {room}</span>
            <span className="text-sm font-semibold">Time left: {formatMs(msLeft)}</span>
          </div>

          <div className="h-72 overflow-y-auto rounded-2xl border border-white/10 p-3 space-y-2 bg-zinc-900">
            {msgs.map((m, i) => (
              <div key={i} className={m.from === "me" ? "text-right" : "text-left"}>
                <span
                  className={
                    m.from === "me"
                      ? "inline-block bg-white text-black px-3 py-2 rounded-2xl"
                      : "inline-block bg-zinc-800 text-white px-3 py-2 rounded-2xl"
                  }
                >
                  {m.text}
                </span>
              </div>
            ))}
            {typing && (
              <div className="text-left">
                <span className="inline-flex items-center gap-1 bg-zinc-800 text-white/80 px-3 py-2 rounded-2xl">
                  <Dot /><Dot className="animation-delay-150" /><Dot className="animation-delay-300" />
                </span>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <input
              className="flex-1 rounded-xl border border-white/20 bg-zinc-900 px-3 py-2 text-white placeholder-white/40 outline-none focus:border-white/40"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your message…"
              onKeyDown={(e) => e.key === "Enter" && send()}
            />
            <button
              onClick={send}
              className="px-4 py-2 rounded-xl border border-white/30 hover:bg-white/10"
            >
              Send
            </button>
          </div>

          <div className="flex gap-2 justify-end">
            <button
              onClick={() => guess("IT")}
              className="px-4 py-2 rounded-xl border border-white/30"
            >
              Guess: IT
            </button>
            <button
              onClick={() => guess("NOT_IT")}
              className="px-4 py-2 rounded-xl border border-white/30"
            >
              Guess: NOT IT
            </button>
          </div>
        </div>
      )}

      {phase === "reveal" && reveal && (
        <div className="space-y-3">
          <div className="rounded-2xl border border-white/10 p-4">
            <p className="text-lg">
              Truth: <b>{reveal.truth}</b>
            </p>
            <p className={reveal.correct ? "text-green-400" : "text-red-400"}>
              {reveal.correct ? "You nailed it 🎯" : "Not this time 😅"}
            </p>
          </div>
          <button
            onClick={() => location.reload()}
            className="px-4 py-2 rounded-xl border border-white/30"
          >
            Play again
          </button>
        </div>
      )}
    </main>
  );
}

function useNow(intervalMs = 1000) {
  const [t, setT] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return t;
}

function formatMs(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function Dot({ className = "" }: { className?: string }) {
  return <span className={`w-1.5 h-1.5 rounded-full bg-white/80 inline-block animate-pulse ${className}`} />;
}
