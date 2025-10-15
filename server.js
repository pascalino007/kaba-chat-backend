import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import pkg from "@prisma/client";
import multer from "multer";
import fs from "fs";
import path from "path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "./utils/s3.js";
import dotenv from "dotenv";
dotenv.config();

const { PrismaClient } = pkg;
const prisma = new PrismaClient();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

let clients = {};
const CUSTOMER_SERVICE_ID = 92109474;

// ---------------------------- SOCKET.IO ----------------------------

io.on("connection", (socket) => {
  console.log("✅ Socket connected:", socket.id);

  // Register a user (mobile or admin)
  socket.on("/register", (userId) => {
    clients[userId] = socket;
    console.log(`🆔 User ${userId} registered with socket ${socket.id}`);
  });

  // Fetch chat history between a user and customer service
  socket.on("/getMessages", async ({ userId, otherId }) => {
    try {
      if (!userId || !otherId) {
        socket.emit("error", { error: "Invalid request for chat history" });
        return;
      }

      const history = await prisma.message.findMany({
        where: {
          OR: [
            { senderId: userId, receiverId: otherId },
            { senderId: otherId, receiverId: userId },
          ],
        },
        orderBy: { createdAt: "asc" },
      });

      socket.emit("messages", history);
      console.log(`📜 Sent ${history.length} messages between ${userId} and ${otherId}`);
    } catch (err) {
      console.error("❌ Failed to fetch chat history:", err);
      socket.emit("error", { error: "Could not load chat history" });
    }
  });

  // Handle new message (from user or from customer service)
  socket.on("/message", async (msg) => {
    try {
      const senderId = parseInt(msg.senderId);
      const receiverId = parseInt(msg.receiverId);
      const text = msg.text?.trim();
      const senderName = msg.senderName?.trim() || `User_${senderId}`; // fallback name

      if (!senderId || !receiverId || !text) {
        socket.emit("error", { error: "Invalid message data" });
        return;
      }

      console.log(`📩 Message -> From: ${senderName} (${senderId}), To: ${receiverId}, Text: "${text}"`);

      // Save message in DB
      const savedMessage = await prisma.message.create({
        data: {
          text,
          senderId,
          receiverId,
          senderName,
        },
      });

      // Emit message to both sender and receiver if connected
      if (clients[receiverId]) clients[receiverId].emit("message", savedMessage);
      if (clients[senderId]) clients[senderId].emit("message", savedMessage);

    } catch (err) {
      console.error("❌ Message save error:", err);
      socket.emit("error", { error: "Failed to send message" });
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    for (const [id, s] of Object.entries(clients)) {
      if (s.id === socket.id) {
        delete clients[id];
        console.log(`❌ Client disconnected and removed: ${id}`);
        break;
      }
    }
    console.log("❌ Socket disconnected:", socket.id);
  });
});

// ---------------------------- REST ENDPOINTS ----------------------------

app.get("/users", async (req, res) => {
  try {
    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { senderId: CUSTOMER_SERVICE_ID },
          { receiverId: CUSTOMER_SERVICE_ID },
        ],
      },
      select: { senderId: true, receiverId: true },
    });

    const userIds = new Set();

    for (const msg of messages) {
      if (msg.senderId === CUSTOMER_SERVICE_ID && msg.receiverId !== CUSTOMER_SERVICE_ID) {
        userIds.add(msg.receiverId);
      }
      if (msg.receiverId === CUSTOMER_SERVICE_ID && msg.senderId !== CUSTOMER_SERVICE_ID) {
        userIds.add(msg.senderId);
      }
    }

    res.json(Array.from(userIds));
  } catch (err) {
    console.error("❌ Failed to fetch chat users:", err);
    res.status(500).json({ error: "Failed to fetch chat users" });
  }
});

// ---------------------------- UPLOAD IMAGE ----------------------------

const upload = multer({ dest: "uploads/" });

app.post("/upload-image", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const fileStream = fs.createReadStream(file.path);
    const fileKey = `chat_images/${Date.now()}_${path.basename(file.originalname)}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: fileKey,
        Body: fileStream,
        ContentType: file.mimetype,
      })
    );

    fs.unlinkSync(file.path); // Delete temp file
    const url = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`;
    console.log("✅ Uploaded to S3:", url);

    res.json({ url });
  } catch (err) {
    console.error("❌ Upload failed:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ---------------------------- START SERVER ----------------------------

const PORT = process.env.PORT || 5000;
server.listen(PORT, "148.230.85.247", () =>
  console.log(`🚀 Server running at http://148.230.85.247/:${PORT}`)
);
