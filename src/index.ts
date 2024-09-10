import EventEmitter from "events";
import { config } from "dotenv";
import express from "express";
import winston from "winston";
import cors from "cors";
import pg from "pg";

config();

const PORT = 3000;

// DB connection
const { Pool } = pg;
const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: 5432,
  ssl: true,
});

// logger settings
const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

// Map of Server-Sent-Events emitters per channel
const eventEmitters = new Map<
  string,
  { emitter: EventEmitter; messageCounter: number }
>();

// Start App and middleware
const app = express();

const corsOptions = {
  origin: process.env.ORIGIN,
  optionsSuccessStatus: 200, // some legacy browsers (IE11, various SmartTVs) choke on 204
};

app.use(cors(corsOptions));
app.use(express.json());

app.use((req, res, next) => {
  logger.info(`Request: [${req.method}] ${req.url} - ${res.statusCode}`);
  next();
});

// endpoints
app.post("/channel", async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      console.error("Missing required name");
      res.status(400).json({
        msg: "Missing required argument name",
      });
    }

    const query = `
        INSERT INTO channels (name)
        VALUES ($1)
        RETURNING *;
        `;

    const results = await pool.query(query, [name]);
    const { id } = results.rows[0];

    return res.status(200).json({ id, name });
  } catch (err) {
    console.error(err);
    return res.status(500).send(err);
  }
});

app.get("/channels", async (req, res) => {
  try {
    const query = `
      SELECT *
      FROM channels
      ORDER BY id;
      `;

    const results = await pool.query(query, []);

    return res
      .status(200)
      .json({ n: results.rows.length, channels: [...results.rows] });
  } catch (err) {
    console.error(err);
    return res.status(404).send(err);
  }
});

app.delete("/channel/:channelId", async (req, res) => {
  try {
    const channelId = req.params.channelId;

    if (channelId) {
      let query = `
      DELETE FROM messages
      WHERE channelid = $1;
      `;

      await pool.query(query, [channelId]);

      query = `
      DELETE FROM channels
      WHERE id = $1;
      `;

      await pool.query(query, [channelId]);

      eventEmitters.delete(channelId);
    }

    return res.status(204).send();
  } catch (err) {
    console.error(err);
    return res.status(500).send(err);
  }
});

app.get("/events/:channelId", (req, res) => {
  if (req.headers.accept === "text/event-stream") {
    const channelId = req.params.channelId;

    if (!channelId) {
      console.error("Missing required channelId");
      res.status(400).json({
        msg: "Missing required argument channelId",
      });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    res.write("event: init\n\n");

    let emitter: EventEmitter;
    let messageCounter: number;
    if (eventEmitters.has(channelId)) {
      const channelData = eventEmitters.get(channelId)!;
      emitter = channelData.emitter;
      messageCounter = channelData.messageCounter;
    } else {
      emitter = new EventEmitter();
      messageCounter = 1;
      eventEmitters.set(channelId, { emitter, messageCounter });
    }

    emitter.on("broadcast", (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.write(`id: ${messageCounter}`);

      messageCounter += 1;
      eventEmitters.set(channelId, { emitter, messageCounter });
    });

    const intervalId = setInterval(() => {
      res.write(":\n\n"); // Send a comment event to keep the connection alive
    }, 10000);

    emitter.on("close", () => {
      clearInterval(intervalId);
      emitter.removeListener("broadcast", () => {});
    });
  } else {
    res.json({ msg: "OK" });
  }
});

app.get("/messages/:channelId", async (req, res) => {
  try {
    const channelId = req.params.channelId;

    if (!channelId) {
      console.error("Missing required channelId");
      res.status(400).json({
        msg: "Missing required argument channelId",
      });
    }

    const query = `
      SELECT *
      FROM messages
      WHERE channelId = $1
      ORDER BY created_at DESC;
      `;

    const results = await pool.query(query, [channelId]);

    return res.status(200).json({ messages: [...results.rows] });
  } catch (err) {
    console.error(err);
    return res.status(404).send(err);
  }
});

app.post("/message/:channelId", async (req, res) => {
  const channelId = req.params.channelId;
  const { content, username } = req.body;

  if (!channelId || !content || !username) {
    console.error("Missing required argument to post message");
    res.status(400).json({
      msg: "Missing required argument (channelId, content or username)",
    });
  }

  const query = `
    INSERT INTO messages (content, channelid, username)
    VALUES ($1, $2, $3)
    RETURNING *;
    `;

  const results = await pool.query(query, [content, channelId, username]);
  const { id, created_at } = results.rows[0];

  const channelData = eventEmitters.get(channelId);
  const emitter = channelData?.emitter;

  if (!emitter) {
    res.status(404).send("Channel not found");
  }

  emitter?.emit("broadcast", { channelId, id, username, content, created_at });

  res.status(201).json({ msg: "Chat message posted" });
});

app.listen(PORT, () => {
  console.log("Server up and running on port ", PORT);
});
