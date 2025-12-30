import express from "express";
import { initBot } from "./bot/bot.js";

const app = express();
const PORT = process.env.PORT || 8080;

// healthcheck для Fly
app.get("/", (_, res) => res.send("OK"));

app.listen(PORT, () => {
  console.log("HTTP server running on", PORT);
});

initBot();
