import "dotenv/config";
import http from "http";
import express from "express";
import { Server } from "socket.io";
import { geminiReply } from "./llm/gemini.js";
const GAME_MS = 120_000;
const MAX_MSG_LEN = 500;
const MIN_MSG_INTERVAL_MS = 350;
const app = express();
// permissive CORS for dev
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS")
        return res.sendStatus(200);
    next();
});
const httpServer = http.createServer(app);
// Socket.IO
const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: true, methods: ["GET", "POST"], credentials: false },
    transports: ["polling", "websocket"],
});
io.engine.on("connection_error", (err) => {
    console.log("[engine] connection_error", {
        code: err.code,
        message: err.message,
        origin: err.context?.request?.headers?.origin,
    });
});
// health
app.get("/health", (_req, res) => res.send("ok"));
// ---- helpers ----
const pickMajor = () => ["IT", "IS", "CS"][Math.floor(Math.random() * 3)];
function pickFallback(major) {
    const fallback = {
        IT: [
            "Just finished setting up a small lab VM. What are you working on?",
            "Was tweaking a subnet on our course project lol.",
            "We had a quick lab on Linux services today. You?"
        ],
        IS: [
            "Sketching a BPMN flow for a small case study.",
            "Looking at a dashboard mockup—trying to pick the right KPIs.",
            "Reading about data governance terms. Fun stuff 😅"
        ],
        CS: [
            "Debugging a small algorithm from class.",
            "Practicing some LeetCode before bed.",
            "Working on a graph problem. What about you?"
        ],
    };
    const arr = fallback[major];
    return arr[Math.floor(Math.random() * arr.length)];
}
function withTimeout(p, ms = 12000) {
    return new Promise((resolve, reject) => {
        const id = setTimeout(() => reject(new Error("llm_timeout")), ms);
        p.then((v) => { clearTimeout(id); resolve(v); })
            .catch((e) => { clearTimeout(id); reject(e); });
    });
}
// ---- state ----
const rooms = new Map();
const lastMsgAt = new Map();
io.on("connection", (sock) => {
    console.log("[io] connected:", sock.id);
    sock.on("join", () => {
        const roomId = `r_${sock.id.slice(0, 6)}`;
        const aiMajor = pickMajor();
        const endsAt = Date.now() + GAME_MS;
        rooms.set(roomId, { id: roomId, player: sock.id, aiMajor, endsAt, history: [] });
        sock.join(roomId);
        io.to(roomId).emit("start", { room: roomId, endsAt });
        console.log("[io] start", { roomId, aiMajor });
    });
    sock.on("msg", async ({ room, text }) => {
        const now = Date.now();
        const last = lastMsgAt.get(sock.id) ?? 0;
        if (now - last < MIN_MSG_INTERVAL_MS)
            return;
        lastMsgAt.set(sock.id, now);
        const r = rooms.get(room);
        if (!r || now > r.endsAt)
            return;
        const clean = String(text ?? "").slice(0, MAX_MSG_LEN).trim();
        if (!clean)
            return;
        r.history.push({ role: "user", text: clean });
        // show typing while we call the model
        io.to(room).emit("typing", { from: "peer", on: true });
        try {
            let reply = "";
            try {
                reply = await withTimeout(geminiReply(r.aiMajor, r.history, clean), 12000);
            }
            catch (_) {
                // timeout or API error → fallback
                reply = pickFallback(r.aiMajor);
            }
            if (!reply || !reply.trim())
                reply = pickFallback(r.aiMajor);
            // tiny human-ish delay
            setTimeout(() => {
                r.history.push({ role: "model", text: reply });
                io.to(room).emit("typing", { from: "peer", on: false });
                io.to(room).emit("msg", { from: "peer", text: reply, ts: Date.now() });
            }, 350 + Math.random() * 650);
        }
        catch (e) {
            console.error("[io] reply error:", e);
            io.to(room).emit("typing", { from: "peer", on: false });
            io.to(room).emit("msg", { from: "peer", text: "(connection glitch 🥲)", ts: Date.now() });
        }
    });
    sock.on("guess", ({ room, choice }) => {
        const r = rooms.get(room);
        if (!r)
            return;
        const truth = r.aiMajor === "IT" ? "IT" : "NOT_IT";
        const correct = choice === truth;
        io.to(room).emit("reveal", { truth, correct });
        rooms.delete(room);
        console.log("[io] reveal", { room, truth, correct });
    });
    sock.on("disconnect", () => {
        for (const [id, r] of rooms)
            if (r.player === sock.id)
                rooms.delete(id);
        lastMsgAt.delete(sock.id);
        console.log("[io] disconnected:", sock.id);
    });
});
const PORT = Number(process.env.PORT || 3001);
httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[boot] Game server on :${PORT}`);
});
