require("dotenv").config();

const { App } = require("@slack/bolt");
const axios = require("axios");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true
});

app.command("/slacktcg-ping", async ({ command, ack, respond }) => {
  const start = Date.now();
  await ack();
  const latency = Date.now() - start;
  await respond({ text: `Pong!\nLatency: ${latency}ms` });
});

app.command("/slacktcg-help", async ({ ack, respond }) => {
  await ack();
  await respond({
    text:
`Available Commands:
/slacktcg-ping - Check bot latency
/slacktcg-pack - Open your daily pack
/slacktcg-inventory - See what cards you've collected
/slacktcg-list - Lists all available cards and their rarity.`
  });
});

(async () => {
  await app.start();
  console.log("bot is running!");
})();