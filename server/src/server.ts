import "dotenv/config";
import http from "http";
import express from "express";
import { Server } from "socket.io";
import { geminiReply, type Turn } from "./llm/gemini.js";
import type { Major } from "./personas.js";

type Room = { id: string; player: string; aiMajor: Major; endsAt: number; history: Turn[] };

const GAME_MS = 120_000;
const MAX_MSG_LEN = 500;
const MIN_MSG_INTERVAL_MS = 350;

const app = express();

// Permissive CORS for dev. Lock this down in prod with WEB_ORIGIN.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const httpServer = http.createServer(app);

// Socket.IO
const io = new Server(httpServer, {
  path: "/socket.io",
  cors: { origin: true, methods: ["GET", "POST"], credentials: false },
  transports: ["polling", "websocket"],
});

io.engine.on("connection_error", (err: any) => {
  console.log("[engine] connection_error", {
    code: err.code,
    message: err.message,
    origin: err.context?.request?.headers?.origin,
  });
});

app.get("/", (_req, res) => {
  res.type("text").send("human-or-it server is running. Try /health");
});


// Health
app.get("/health", (_req, res) => res.send("ok"));

// ---------- Anti-reveal helpers ----------
const DIRECT_MAJOR_PROBE = new RegExp(
  [
    "what'?s\\s+your\\s+major",
    "your\\s+major",
    "which\\s+major",
    "are\\s+you\\s+(an?\\s+)?(it|is|cs)\\s+student",
    "are\\s+you\\s+(it|is|cs)",
    "do\\s+you\\s+study\\s+(it|is|cs|computer\\s+science|information\\s+systems|information\\s+technology)",
  ].join("|"),
  "i"
);

// Anything like “I am CS/IT/IS”, “my major is …”
const REVEAL_PATTERN = new RegExp(
  [
    "(?:i\\s*am|i'?m|i\\s*study|my\\s+major\\s+is|i\\s*do)\\s+(?:computer\\s*science|cs|information\\s*systems|is|information\\s*technology|it)\\b",
    "\\bi\\s*(?:am|'?m)\\s*(?:an?\\s+)?(it|is|cs)\\s+student\\b",
  ].join("|"),
  "i"
);

const genericDeflections = [
  "Haha nice try — let’s keep it a mystery. What classes are you taking?",
  "I’ll keep that secret 😄 Tell me about your projects instead!",
  "Guessing game later — what topics do you enjoy the most?",
  "Not saying! What’s your favorite course this term?",
];

function deflect(): string {
  return genericDeflections[Math.floor(Math.random() * genericDeflections.length)];
}

function sanitizeReply(reply: string): string {
  if (!reply) return deflect();
  if (REVEAL_PATTERN.test(reply)) return deflect();
  return reply;
}

// ---------- Game state ----------
const rooms = new Map<string, Room>();
const lastMsgAt = new Map<string, number>();

io.on("connection", (sock) => {
  console.log("[io] connected:", sock.id);

  sock.on("join", () => {
    const roomId = `r_${sock.id.slice(0, 6)}`;
    const majors: Major[] = ["IT", "IS", "CS"];
    const aiMajor = majors[Math.floor(Math.random() * majors.length)];
    const endsAt = Date.now() + GAME_MS;

    rooms.set(roomId, { id: roomId, player: sock.id, aiMajor, endsAt, history: [] });
    sock.join(roomId);
    io.to(roomId).emit("start", { room: roomId, endsAt });
  });

  sock.on("msg", async ({ room, text }: { room: string; text: string }) => {
    const now = Date.now();
    const last = lastMsgAt.get(sock.id) ?? 0;
    if (now - last < MIN_MSG_INTERVAL_MS) return;
    lastMsgAt.set(sock.id, now);

    const r = rooms.get(room);
    if (!r || now > r.endsAt) return;

    const clean = String(text ?? "").slice(0, MAX_MSG_LEN).trim();
    if (!clean) return;

    r.history.push({ role: "user", text: clean });

    // If user directly asks about the major, immediately deflect (don’t call LLM)
    if (DIRECT_MAJOR_PROBE.test(clean)) {
      const reply = deflect();
      r.history.push({ role: "model", text: reply });
      io.to(room).emit("msg", { from: "peer", text: reply, ts: Date.now() });
      return;
    }

    // Otherwise call the LLM and then sanitize
    io.to(room).emit("typing", { from: "peer", on: true });

    try {
      let reply = "";
      try {
        reply = await withTimeout(geminiReply(r.aiMajor, r.history, clean), 12000);
      } catch {
        reply = ""; // will fall back below
      }
      if (!reply.trim()) reply = deflect();
      reply = sanitizeReply(reply);

      setTimeout(() => {
        r.history.push({ role: "model", text: reply });
        io.to(room).emit("typing", { from: "peer", on: false });
        io.to(room).emit("msg", { from: "peer", text: reply, ts: Date.now() });
      }, 300 + Math.random() * 600);
    } catch (e) {
      console.error("[io] reply error:", e);
      io.to(room).emit("typing", { from: "peer", on: false });
      io.to(room).emit("msg", { from: "peer", text: "(connection glitch 🥲)", ts: Date.now() });
    }
  });

  sock.on("guess", ({ room, choice }: { room: string; choice: "IT" | "NOT_IT" }) => {
    const r = rooms.get(room);
    if (!r) return;
    const truth = r.aiMajor === "IT" ? "IT" : "NOT_IT";
    const correct = choice === truth;
    io.to(room).emit("reveal", { truth, correct });
    rooms.delete(room);
  });

  sock.on("disconnect", () => {
    for (const [id, r] of rooms) if (r.player === sock.id) rooms.delete(id);
    lastMsgAt.delete(sock.id);
  });
});

function withTimeout<T>(p: Promise<T>, ms = 12000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("llm_timeout")), ms);
    p.then(v => { clearTimeout(id); resolve(v); })
     .catch(e => { clearTimeout(id); reject(e); });
  });
}

const PORT = Number(process.env.PORT || 3001);
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[boot] Game server on :${PORT}`);
});
