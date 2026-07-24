require("dotenv").config();

const { App } = require("@slack/bolt");
const axios = require("axios");
const fs = require("fs");

const cards = JSON.parse(
  fs.readFileSync(__dirname + "/data/cards.json", "utf8")
);

console.log(`Loaded ${cards.length} cards`);

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

app.command("/slacktcg-pack", async ({ command, ack, respond }) => {
  await ack();

  const rarityChances = [
    { rarity: "Common", chance: 60 },
    { rarity: "Rare", chance: 25 },
    { rarity: "Epic", chance: 10 },
    { rarity: "Legendary", chance: 4 },
    { rarity: "Mythical", chance: 1 }
  ];

  const rarityIcons = {
    Common: "⚪",
    Rare: "🔵",
    Epic: "🟣",
    Legendary: "🟠",
    Mythical: "🔴"
  };

  function getRandomRarity() {
    const roll = Math.random() * 100;
    let total = 0;

    for (const item of rarityChances) {
      total += item.chance;

      if (roll < total) {
        return item.rarity;
      }
    }
  }

  function getRandomCard(rarity) {
    const possibleCards = cards.filter(
      card => card.rarity === rarity
    );

    return possibleCards[
      Math.floor(Math.random() * possibleCards.length)
    ];
  }

  function getVariant() {
    const roll = Math.random() * 100;

    if (roll < 0.5) {
      return "🌈 Rainbow";
    } else if (roll < 2) {
      return "✨ Shiny";
    } else if (roll < 5) {
      return "🟨 Gold";
    } else {
      return "Normal";
    }
  }

  const pack = [];

  for (let i = 0; i < 5; i++) {
    const rarity = getRandomRarity();
    const card = getRandomCard(rarity);

    pack.push({
      ...card,
      variant: getVariant()
    });
  }

  const cardsText = pack
    .map(card => {
      const rarity = `${rarityIcons[card.rarity]} *${card.rarity}*`;

      let result = `🃏 *${card.name}*\n${rarity}`;

      if (card.variant !== "Normal") {
        result += `\n✨ *Modifier:* ${card.variant}`;
      }

      return result;
    })
    .join("\n\n");

  await respond({
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "SlackTCG Pack Opened!"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: cardsText
        }
      }
    ]
  });
});

(async () => {
  await app.start();
  console.log("bot is running!");
})();