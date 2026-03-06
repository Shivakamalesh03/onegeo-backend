
require('dotenv').config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

/* ---------------- AI HELPERS (ENV DRIVEN) ---------------- */

async function askAI(systemPrompt, userPrompt) {
  // If you want to use OpenRouter
  if (process.env.OPENROUTER_KEY) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-3.5-turbo", 
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ]
        })
      });
      const data = await response.json();
      return data.choices[0].message.content;
    } catch (error) {
      console.error("OpenRouter Error:", error.message);
    }
  }

  // Fallback to Ollama if OpenRouter fails or isn't used
  try {
    const response = await fetch(`${process.env.OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3',
        messages: [{ role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }],
        stream: false
      })
    });
    const data = await response.json();
    return data.message.content;
  } catch (error) {
    console.error("Ollama Error:", error.message);
    return "AI service currently unavailable.";
  }
}

/* ---------------- S3 & MONGODB CONFIG ---------------- */

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

mongoose.connect(process.env.MONGO_URI);

const WellSchema = new mongoose.Schema({
  fileName: String, 
  s3Key: String, 
  curves: [String], 
  aiAnalysis: String, 
  uploadedAt: { type: Date, default: Date.now }
});
const Well = mongoose.model("Well", WellSchema);

const LogChunkSchema = new mongoose.Schema({
  wellId: { type: mongoose.Schema.Types.ObjectId, ref: "Well" },
  startDepth: Number, 
  endDepth: Number, 
  rows: [Object]
});
const LogChunk = mongoose.model("LogChunk", LogChunkSchema);

/* ---------------- API ROUTES ---------------- */

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });

    const rawContent = fs.readFileSync(req.file.path, "utf8");
    
    const aiSummary = await askAI(
      "You are a Petrophysicist.",
      `Summarize this LAS header: Well/Field, Depth Range, and Curves.\n\n${rawContent.substring(0, 5000)}`
    );

    await s3.send(new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: req.file.originalname,
      Body: fs.createReadStream(req.file.path)
    }));

    const lines = rawContent.split("\n");
    let curves = [], data = [], curveSection = false, asciiStart = false;

    for (let line of lines) {
      line = line.trim();
      if (line.toUpperCase().startsWith("~C")) { curveSection = true; asciiStart = false; continue; }
      if (line.toUpperCase().startsWith("~A")) { asciiStart = true; curveSection = false; continue; }
      if (curveSection && line !== "" && !line.startsWith("#")) {
        const c = line.split(".")[0].trim();
        if (c && !curves.includes(c)) curves.push(c);
      }
      if (asciiStart && line !== "" && !line.startsWith("#")) {
        const values = line.split(/\s+/).map(Number);
        if (values.length >= curves.length) data.push(values.slice(0, curves.length));
      }
    }

    const parsedData = data.map(row => {
      let obj = {};
      curves.forEach((c, i) => obj[c] = row[i]);
      return obj;
    });

    const well = await Well.create({ 
      fileName: req.file.originalname, 
      s3Key: req.file.originalname, 
      curves, 
      aiAnalysis: aiSummary 
    });

    const CHUNK_SIZE = 1000;
    for (let i = 0; i < parsedData.length; i += CHUNK_SIZE) {
      const chunk = parsedData.slice(i, i + CHUNK_SIZE);
      await LogChunk.create({ 
        wellId: well._id, 
        startDepth: chunk[0][curves[0]], 
        endDepth: chunk[chunk.length-1][curves[0]], 
        rows: chunk 
      });
    }

    fs.unlinkSync(req.file.path);
    res.json({ wellId: well._id, curves, preview: parsedData.slice(0, 500), aiAnalysis: aiSummary });
  } catch (err) {
    res.status(500).json({ error: "Upload failed" });
  }
});

app.post("/interpret", async (req, res) => {
  try {
    const { wellId, curve, minDepth, maxDepth } = req.body;
    const chunks = await LogChunk.find({ wellId }).sort({ startDepth: 1 }).lean();
    let rows = [];
    chunks.forEach(c => rows.push(...c.rows));

    const filtered = rows.filter(r => {
      const d = r.Depth || r.DEPT || r.DEPTH;
      return (!minDepth || d >= minDepth) && (!maxDepth || d <= maxDepth);
    });

    const values = filtered.map(r => r[curve]).filter(v => v !== undefined && !isNaN(v) && v > -999);
    
    const stats = {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      range: `${minDepth || 'Start'} - ${maxDepth || 'End'}`
    };

    const aiRes = await askAI(
      "As a Petrophysicist, interpret these stats.",
      `Curve: ${curve}, Range: ${stats.range}, Min: ${stats.min.toFixed(2)}, Max: ${stats.max.toFixed(2)}, Avg: ${stats.avg.toFixed(2)}. 1-sentence geological conclusion.`
    );

    res.json({
      zones: [{
        startDepth: minDepth || "Start",
        endDepth: maxDepth || "End",
        interpretation: aiRes
      }]
    });
  } catch (err) {
    res.status(500).json({ error: "AI failed" });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const { wellId, message } = req.body;
    const well = await Well.findById(wellId);
    
    const reply = await askAI(
      `Petrophysics Bot. Well: ${well.fileName}. Curves: ${well.curves.join(", ")}.`,
      `User: ${message}. Answer concisely in 2 sentences.`
    );

    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: "Chat failed" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server: http://localhost:${PORT}`));