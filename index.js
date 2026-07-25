require("dotenv").config();

const { App } = require("@slack/bolt");
const fs = require("fs");

const cards = JSON.parse(
  fs.readFileSync(__dirname + "/data/cards.json", "utf8")
);

console.log(`Loaded ${cards.length} cards`);

const usersPath = __dirname + "/data/users.json";

let users = JSON.parse(
  fs.readFileSync(usersPath, "utf8")
);

function saveUsers() {
  fs.writeFileSync(
    usersPath,
    JSON.stringify(users, null, 2)
  );
}

const rarityIcons = {
  Common: "⚪",
  Rare: "🔵",
  Epic: "🟣",
  Legendary: "🟠",
  Mythical: "🔴"
};

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true
});


app.command("/slacktcg-ping", async ({ ack, respond }) => {
  const start = Date.now();

  await ack();

  const latency = Date.now() - start;

  await respond({
    text: `🏓 Pong!\nLatency: ${latency}ms`
  });
});


app.command("/slacktcg-help", async ({ ack, respond }) => {
  await ack();

  await respond({
    text:
      `🎴 *SlackTCG Commands*

/slacktcg-ping
Check bot latency

/slacktcg-pack
Open your daily pack

/slacktcg-inventory
View your collection

/slacktcg-trade @user <card>
Trade a specific card by using title. If the card has a modifier, it would look like ghoul-shiny or rock golem-shiny (include spaces if title has them)

Card Rarities: Common 60%, Rare 25%, Epic 10%, Legendary 4%, Mythical 1%
Modifier Rarities: Normal 96%, Gold 3%, Shiny 0.9%, Rainbow 0.1%`
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

    if (roll < 0.1) {
      return "🌈 Rainbow";
    }

    if (roll < 1) {
      return "✨ Shiny";
    }

    if (roll < 4) {
      return "🟨 Gold";
    }

    return "Normal";
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


  const userId = command.user_id;


  if (!users[userId]) {
    users[userId] = {
      cards: []
    };
  }


  users[userId].cards.push(...pack);

  saveUsers();


  const packText = pack
    .map(card => {

      let text =
        `🃏 *${card.name}*
${rarityIcons[card.rarity]} *${card.rarity}*`;

      if (card.variant !== "Normal") {
        text += `\n✨ Modifier: ${card.variant}`;
      }

      return text;

    })
    .join("\n\n");


  await respond({
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🎴 SlackTCG Pack Opened!"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: packText
        }
      }
    ]
  });
});
const rarityOrder = {
  Mythical: 0,
  Legendary: 1,
  Epic: 2,
  Rare: 3,
  Uncommon: 4,
  Common: 5
};

app.command("/slacktcg-inventory", async ({ command, ack, respond }) => {
  await ack();

  const userId = command.user_id;

  if (!users[userId] || users[userId].cards.length === 0) {
    await respond({
      text: "📦 Your inventory is empty!"
    });
    return;
  }

  const grouped = {};

  for (const card of users[userId].cards) {
    const key = `${card.id}-${card.variant}`;

    if (!grouped[key]) {
      grouped[key] = {
        ...card,
        count: 0
      };
    }

    grouped[key].count++;
  }

  const inventoryText = Object.values(grouped)
    .sort((a, b) => {
      // Sort by rarity
      const rarityDiff =
        (rarityOrder[a.rarity] ?? 999) -
        (rarityOrder[b.rarity] ?? 999);

      if (rarityDiff !== 0) return rarityDiff;

      // Then by name
      const nameDiff = a.name.localeCompare(b.name);
      if (nameDiff !== 0) return nameDiff;

      // Then by variant
      return a.variant.localeCompare(b.variant);
    })
    .map(card => {
      let text =
        `🃏 *${card.name}* x${card.count}
${rarityIcons[card.rarity]} *${card.rarity}*`;

      if (card.variant !== "Normal") {
        text += `\n✨ Modifier: ${card.variant}`;
      }

      return text;
    })
    .join("\n\n────────────\n\n");

  await respond({
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🎒 Your SlackTCG Inventory"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: inventoryText
        }
      }
    ]
  });
});

app.command("/slacktcg-trade", async ({ command, ack, respond }) => {
  await ack();

  const senderId = command.user_id;

  const firstSpace = command.text.indexOf(" ");

  if (firstSpace === -1) {
    await respond(
      "❌ Usage: `/slacktcg-trade @user card-name`"
    );
    return;
  }

  const targetArg = command.text.substring(0, firstSpace);
  const cardArg = command.text.substring(firstSpace + 1).trim();

  const targetId = targetArg
    .replace("<@", "")
    .replace(">", "")
    .split("|")[0];

  if (!users[senderId] || users[senderId].cards.length === 0) {
    await respond("❌ You don't have any cards.");
    return;
  }

  if (!users[targetId]) {
    users[targetId] = {
      cards: []
    };
  }

  let name = cardArg;
  let variant = "Normal";

  const lower = cardArg.toLowerCase();

  if (lower.endsWith("-rainbow")) {
    variant = "🌈 Rainbow";
    name = cardArg.slice(0, -9);
  } else if (lower.endsWith("-shiny")) {
    variant = "✨ Shiny";
    name = cardArg.slice(0, -7);
  } else if (lower.endsWith("-gold")) {
    variant = "🟨 Gold";
    name = cardArg.slice(0, -5);
  }

  name = name.trim();

  const cardIndex = users[senderId].cards.findIndex(card =>
    card.name.toLowerCase() === name.toLowerCase() &&
    card.variant === variant
  );

  if (cardIndex === -1) {
    await respond(
      `❌ You don't own a ${variant === "Normal"
        ? name
        : `${name} (${variant})`
      }.`
    );
    return;
  }

  const tradedCard = users[senderId].cards.splice(cardIndex, 1)[0];

  users[targetId].cards.push(tradedCard);

  saveUsers();

  let text =
    `🤝 *Trade Complete!*\n\n` +
    `You gave:\n` +
    `🃏 *${tradedCard.name}*\n` +
    `${rarityIcons[tradedCard.rarity]} ${tradedCard.rarity}`;

  if (tradedCard.variant !== "Normal") {
    text += `\n✨ Modifier: ${tradedCard.variant}`;
  }

  text += `\n\nTo:\n<@${targetId}>`;

  await respond({
    text
  });
});



(async () => {
  await app.start();
  console.log("bot is running!");
})();