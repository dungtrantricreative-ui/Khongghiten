import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs/promises";
import crypto from "node:crypto";
// Cho phần chat
import { GoogleGenerativeAI } from "@google/generative-ai";

// Cho phần upload file
import { GoogleAIFileManager } from "@google/generative-ai/server";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

const upload = multer({ dest: "/tmp" });

const MODEL = "gemini-2.5-flash";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

// Lưu lịch sử theo sessionId: [{ role, parts }, ...]
const sessions = new Map();

function createSession() {
  const id = crypto.randomUUID();
  sessions.set(id, []);
  return id;
}

function trimHistory(history, maxTurns = 40) {
  // Mỗi lượt gồm user+model → 2 entries
  if (history.length > maxTurns * 2) {
    return history.slice(-maxTurns * 2);
  }
  return history;
}

app.post("/api/session", (req, res) => {
  const sessionId = createSession();
  res.json({ sessionId });
});

app.get("/api/history", (req, res) => {
  const { sessionId } = req.query;
  res.json({ history: sessions.get(sessionId) || [] });
});

app.post("/api/reset", (req, res) => {
  const { sessionId } = req.body;
  sessions.set(sessionId, []);
  res.json({ ok: true });
});

app.post("/api/upload", upload.array("files", 10), async (req, res) => {
  try {
    const files = req.files || [];
    const uploaded = [];
    for (const f of files) {
      const result = await fileManager.uploadFile(f.path, {
        mimeType: f.mimetype,
        displayName: f.originalname
      });
      uploaded.push({
        uri: result.file.uri,
        mimeType: result.file.mimeType,
        displayName: result.file.displayName
      });
      // Xóa file tạm sau khi đẩy lên
      fs.unlink(f.path).catch(() => {});
    }
    res.json({ files: uploaded });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload thất bại" });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { sessionId, text, files = [] } = req.body;
    if (!sessionId) return res.status(400).json({ error: "Thiếu sessionId" });
    if (!text && files.length === 0) {
      return res.status(400).json({ error: "Thiếu nội dung" });
    }

    const history = sessions.get(sessionId) || [];
    const model = genAI.getGenerativeModel({ model: MODEL });

    // Xây parts cho lượt user hiện tại
    const userParts = [];
    if (text) userParts.push({ text });
    for (const f of files) {
      userParts.push({
        fileData: { fileUri: f.uri, mimeType: f.mimeType }
      });
    }

    // Khởi tạo chat từ lịch sử (stateless per request)
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(userParts);
    const response = await result.response;
    const output = response.text();

    // Cập nhật lịch sử
    history.push({ role: "user", parts: userParts });
    history.push({ role: "model", parts: [{ text: output }] });
    sessions.set(sessionId, trimHistory(history));

    res.json({ text: output });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Yêu cầu thất bại" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
