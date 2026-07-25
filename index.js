require("dotenv").config();

const { App } = require("@slack/bolt");
const fs = require("fs");
const crypto = require("crypto");

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

/slacktcg-view <card>
View individual copies

/slacktcg-trade @user <cardID>
Trade a specific card`
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

    if (roll < 0.5) {
      return "🌈 Rainbow";
    }

    if (roll < 2) {
      return "✨ Shiny";
    }

    if (roll < 5) {
      return "🟨 Gold";
    }

    return "Normal";
  }


  const pack = [];

  for (let i = 0; i < 5; i++) {

    const rarity = getRandomRarity();
    const card = getRandomCard(rarity);

    pack.push({
      instanceId: crypto.randomBytes(4).toString("hex"),
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
        count: 0,
        ids: []
      };
    }

    grouped[key].count++;
    grouped[key].ids.push(card.instanceId);
  }


  const inventoryText = Object.values(grouped)
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



app.command("/slacktcg-view", async ({ command, ack, respond }) => {
  await ack();

  const userId = command.user_id;
  const search = command.text.trim().toLowerCase();


  if (!search) {
    await respond(
      "❌ Usage: `/slacktcg-view <card name>`"
    );
    return;
  }


  if (!users[userId]) {
    await respond("📦 Your inventory is empty!");
    return;
  }


  const found = users[userId].cards.filter(
    card => card.name.toLowerCase() === search
  );


  if (found.length === 0) {
    await respond(
      `❌ You don't own any ${command.text}`
    );
    return;
  }


  const text = found
    .map((card, index) => {

      let result =
        `${index + 1}. 🆔 \`${card.instanceId}\`
🃏 *${card.name}*
${rarityIcons[card.rarity]} *${card.rarity}*`;


      if (card.variant !== "Normal") {
        result += `\n✨ Modifier: ${card.variant}`;
      }


      return result;

    })
    .join("\n\n");


  await respond({
    text:
      `🔎 *${found[0].name} Collection*

${text}`
  });
});



app.command("/slacktcg-trade", async ({ command, ack, respond }) => {
  await ack();

  const senderId = command.user_id;

  const args = command.text.split(" ");

  if (args.length < 2) {
    await respond(
      "❌ Usage: `/slacktcg-trade @user cardID`"
    );
    return;
  }


  const targetId = args[0]
    .replace("<@", "")
    .replace(">", "")
    .split("|")[0];


  const cardId = args[1];


  if (!users[senderId] || !users[senderId].cards) {
    await respond(
      "❌ You don't have any cards."
    );
    return;
  }


  if (!users[targetId]) {
    users[targetId] = {
      cards: []
    };
  }


  const cardIndex = users[senderId].cards.findIndex(
    card => card.instanceId === cardId
  );


  if (cardIndex === -1) {
    await respond(
      "❌ You don't own a card with that ID."
    );
    return;
  }


  const tradedCard = users[senderId].cards[cardIndex];


  users[senderId].cards.splice(cardIndex, 1);

  users[targetId].cards.push(tradedCard);


  saveUsers();


  await respond({
    text:
      `🤝 *Trade Complete!*

You gave:
🃏 *${tradedCard.name}*
${rarityIcons[tradedCard.rarity]} ${tradedCard.rarity}

To:
<@${targetId}>`
  });
});



(async () => {
  await app.start();
  console.log("bot is running!");
})();