require("dotenv").config();

const { App } = require("@slack/bolt");
const { FileInstallationStore, InstallProvider } = require("@slack/oauth");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const usersPath = __dirname + "/data/users.json";
const statsPath = __dirname + "/data/stats.json";
const PACK_COOLDOWN = 60 * 1000;

let users = JSON.parse(
  fs.readFileSync(usersPath, "utf8")
);
let stats = fs.existsSync(statsPath)
  ? JSON.parse(fs.readFileSync(statsPath, "utf8"))
  : { teams: {} };

let removedLegacyCards = false;

for (const user of Object.values(users)) {
  const currentCards = user.cards || [];
  user.cards = currentCards.filter(card => card.memberId);
  removedLegacyCards ||= user.cards.length !== currentCards.length;
}

function saveUsers() {
  fs.writeFileSync(
    usersPath,
    JSON.stringify(users, null, 2)
  );
}

function saveStats() {
  fs.writeFileSync(
    statsPath,
    JSON.stringify(stats, null, 2)
  );
}

function getCardOddsProbability(card) {
  if (card.pullOddsProbability) return card.pullOddsProbability;

  const normalRarityOdds = {
    Common: 0.6,
    Rare: 0.25,
    Epic: 0.1,
    Legendary: 0.04,
    Mythical: 0.01
  };
  const godPackRarityOdds = {
    Rare: 0.625,
    Epic: 0.25,
    Legendary: 0.1,
    Mythical: 0.025
  };
  const variantOdds = {
    Normal: 0.96,
    "🟨 Gold": 0.03,
    "✨ Shiny": 0.009,
    "🌈 Rainbow": 0.001
  };

  if (card.variant === "👑 God") {
    return 0.05 *
      (godPackRarityOdds[card.rarity] || 0) *
      (card.prismatic ? 0.01 : 0.99);
  }

  return 0.95 *
    (normalRarityOdds[card.rarity] || 0) *
    (variantOdds[card.variant] || 0);
}

function formatCardOdds(card) {
  const probability = getCardOddsProbability(card);

  if (!probability) return "Unknown odds";

  const percentage = probability * 100;
  const percentageText = percentage >= 0.01
    ? percentage.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")
    : percentage.toPrecision(3);

  return `1 in ${Math.round(1 / probability).toLocaleString("en-US")} (${percentageText}%)`;
}

function recordPackStats(teamId, slackUserId, pack) {
  const teamStats = stats.teams[teamId] ||= {};

  for (const card of pack) {
    const probability = getCardOddsProbability(card);

    if (
      !teamStats.rarestPull ||
      probability < getCardOddsProbability(teamStats.rarestPull.card)
    ) {
      teamStats.rarestPull = {
        card,
        probability,
        pulledBy: slackUserId,
        pulledAt: Date.now()
      };
    }
  }

  saveStats();
}

function refreshRarestPullsFromInventories() {
  let changed = false;

  for (const [userKey, user] of Object.entries(users)) {
    const separatorIndex = userKey.indexOf(":");
    if (separatorIndex === -1) continue;

    const teamId = userKey.slice(0, separatorIndex);
    const slackUserId = userKey.slice(separatorIndex + 1);
    const teamStats = stats.teams[teamId] ||= {};

    for (const card of user.cards || []) {
      const probability = getCardOddsProbability(card);

      if (
        probability &&
        (
          !teamStats.rarestPull ||
          probability < getCardOddsProbability(teamStats.rarestPull.card)
        )
      ) {
        teamStats.rarestPull = {
          card,
          probability,
          pulledBy: slackUserId,
          pulledAt: null
        };
        changed = true;
      }
    }
  }

  if (changed) saveStats();
}

refreshRarestPullsFromInventories();

function getPackCooldown(user) {
  if (!user.lastPack) return 0;

  return Math.max(0, PACK_COOLDOWN - (Date.now() - user.lastPack));
}

function getHourKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 13);
}

function isLuckyHour(timestamp = Date.now()) {
  const digest = crypto
    .createHmac("sha256", process.env.SLACK_STATE_SECRET)
    .update(`lucky-hour:${getHourKey(timestamp)}`)
    .digest();

  return digest.readUInt32BE(0) / 0x100000000 < 0.1;
}

const announcedLuckyHours = new Set();

async function announceLuckyHour(client, teamId) {
  const announcementKey = `${teamId}:${getHourKey()}`;

  if (announcedLuckyHours.has(announcementKey)) return;

  let cursor;

  do {
    const response = await client.conversations.list({
      types: "public_channel",
      exclude_archived: true,
      cursor,
      limit: 200
    });
    const gamingChannel = response.channels.find(
      channel => channel.name === "gaming"
    );

    if (gamingChannel) {
      await client.chat.postMessage({
        channel: gamingChannel.id,
        text: "🍀 *LUCKY HOUR!* For the rest of this hour, rare-card and special-modifier odds are tripled in every channel!"
      });
      announcedLuckyHours.add(announcementKey);
      return;
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  console.warn("Lucky Hour could not be announced because #gaming was not found");
}

const rarityIcons = {
  Common: "⚪",
  Rare: "🔵",
  Epic: "🟣",
  Legendary: "🟠",
  Mythical: "🔴"
};

const requiredEnvironmentVariables = [
  "SLACK_APP_TOKEN",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_STATE_SECRET",
  "PUBLIC_BASE_URL"
];

const missingEnvironmentVariables = requiredEnvironmentVariables.filter(
  name => !process.env[name]
);

if (missingEnvironmentVariables.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingEnvironmentVariables.join(", ")}`
  );
}

if (removedLegacyCards) {
  saveUsers();
}

async function getChannelMemberCards(client, channelId) {
  const memberIds = [];
  let cursor;

  do {
    const response = await client.conversations.members({
      channel: channelId,
      cursor,
      limit: 200
    });

    memberIds.push(...response.members);
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const channelMemberIds = new Set(memberIds);
  const members = [];
  cursor = undefined;

  do {
    const response = await client.users.list({
      cursor,
      limit: 200
    });

    members.push(...response.members);
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return members
    .filter(member =>
      member &&
      channelMemberIds.has(member.id) &&
      !member.deleted &&
      !member.is_bot &&
      member.id !== "USLACKBOT"
    )
    .map(member => {
      const profile = member.profile || {};
      const fullName = [profile.first_name, profile.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();

      return {
        id: `member:${member.id}`,
        memberId: member.id,
        name: fullName || profile.real_name || profile.display_name || member.real_name || member.name,
        imageUrl: profile.image_512 || profile.image_192 || profile.image_72
      };
    })
    .filter(card => card.name);
}

async function resolveSlackUserId(client, target) {
  const mentionMatch = target.match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/i);

  if (mentionMatch) {
    return mentionMatch[1];
  }

  const requestedName = target.replace(/^@/, "").trim().toLowerCase();
  let cursor;

  do {
    const response = await client.users.list({
      cursor,
      limit: 200
    });
    const matchingUser = response.members.find(member => {
      const profile = member.profile || {};
      const names = [
        member.name,
        profile.display_name,
        profile.real_name
      ];

      return !member.deleted && names.some(
        name => name && name.toLowerCase() === requestedName
      );
    });

    if (matchingUser) {
      return matchingUser.id;
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return null;
}

const publicBaseUrl = process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
const redirectUri = `${publicBaseUrl}/slack/oauth_redirect`;
const installationStore = new FileInstallationStore({
  baseDir: process.env.SLACK_INSTALLATION_STORE_PATH ||
    path.join(__dirname, "data", "installations"),
  clientId: process.env.SLACK_CLIENT_ID
});
const installProvider = new InstallProvider({
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  installationStore,
  authVersion: "v2",
  directInstall: true,
  installUrlOptions: {
    scopes: [
      "commands",
      "users:read",
      "channels:read",
      "groups:read",
      "im:read",
      "mpim:read",
      "chat:write"
    ],
    redirectUri
  }
});

const supportEmail = "john.rachwalski1@gmail.com";
const siteStyles = `
  :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #111827; color: #f9fafb; line-height: 1.6; }
  main { width: min(760px, calc(100% - 32px)); margin: 64px auto; }
  nav { display: flex; gap: 18px; margin-bottom: 48px; }
  nav a, a { color: #93c5fd; }
  h1 { font-size: clamp(2.2rem, 7vw, 4rem); line-height: 1.05; margin: 0 0 20px; }
  h2 { margin-top: 36px; }
  .card { background: #1f2937; border: 1px solid #374151; border-radius: 18px; padding: 28px; }
  .button { display: inline-block; margin-top: 18px; padding: 12px 20px; border-radius: 10px;
    background: #4f46e5; color: white; font-weight: 700; text-decoration: none; }
  .muted { color: #cbd5e1; }
  footer { margin-top: 48px; color: #94a3b8; font-size: .9rem; }
`;

function page(title, content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | SlackTCG</title>
  <style>${siteStyles}</style>
</head>
<body>
  <main>
    <nav>
      <a href="/">SlackTCG</a>
      <a href="/support">Support</a>
      <a href="/privacy">Privacy</a>
    </nav>
    ${content}
    <footer>SlackTCG is an independent Slack app and is not affiliated with Slack Technologies.</footer>
  </main>
</body>
</html>`;
}

function sendHtml(res, title, content) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  });
  res.end(page(title, content));
}

const customRoutes = [
  {
    path: "/",
    method: "GET",
    handler: (_req, res) => sendHtml(res, "Collect, trade, and play", `
      <section class="card">
        <p class="muted">A trading card game for Slack</p>
        <h1>Open packs. Build a collection. Trade with friends.</h1>
        <p>SlackTCG brings a lightweight card-collecting game into your workspace.
          Open a daily pack, discover rare modifiers, browse your inventory, and
          trade cards with other members using simple slash commands.</p>
        <a class="button" href="/slack/install">Add SlackTCG to Slack</a>
      </section>
      <h2>What you can do</h2>
      <ul>
        <li>Open a free pack of five cards every 24 hours.</li>
        <li>Collect Common, Rare, Epic, Legendary, and Mythical cards.</li>
        <li>Find Gold, Shiny, and Rainbow variants.</li>
        <li>Trade cards directly with other workspace members.</li>
      </ul>
    `)
  },
  {
    path: "/privacy",
    method: "GET",
    handler: (_req, res) => sendHtml(res, "Privacy Policy", `
      <h1>Privacy Policy</h1>
      <p class="muted">Effective July 26, 2026</p>
      <h2>Information SlackTCG processes</h2>
      <p>SlackTCG stores Slack workspace and user identifiers, card inventory,
        pack-opening timestamps, and OAuth installation credentials supplied by
        Slack. It processes slash-command content when you use the app.</p>
      <h2>How information is used</h2>
      <p>This information is used only to authenticate installations, operate the
        game, display inventories, and complete trades.
        SlackTCG does not sell personal information or use it for advertising.</p>
      <h2>Storage and sharing</h2>
      <p>Application data is stored on the service's private hosting environment.
        It is shared only with Slack as necessary to provide the service or when
        required by law.</p>
      <h2>Retention and deletion</h2>
      <p>Data is retained while needed to operate SlackTCG. Workspace owners or
        users may request deletion of their associated data by contacting
        <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
      <h2>Contact</h2>
      <p>Questions about this policy can be sent to
        <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
    `)
  },
  {
    path: "/support",
    method: "GET",
    handler: (_req, res) => sendHtml(res, "Support", `
      <h1>SlackTCG Support</h1>
      <p>For installation help, bug reports, data-deletion requests, or other
        questions, email <a href="mailto:${supportEmail}">${supportEmail}</a>.</p>
      <h2>Quick help</h2>
      <div class="card">
        <p><strong>/slacktcg-help</strong> — View all commands.</p>
        <p><strong>/slacktcg-pack</strong> — Open your daily pack.</p>
        <p><strong>/slacktcg-inventory</strong> — View your collection.</p>
        <p><strong>/slacktcg-trade @user card-name</strong> — Trade a card.</p>
        <p><strong>/slacktcg-ping</strong> — Check whether the app is online.</p>
      </div>
      <h2>Response time</h2>
      <p>Support requests are normally reviewed within three business days.</p>
    `)
  }
];

const app = new App({
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  authorize: source => installProvider.authorize(source)
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

/slacktcg-leaderboard
View the workspace's pack, Mythical, and rarest-pull leaders

/slacktcg-trade @user <card>
Trade a member card by first and last name. Capitalization, spaces, and hyphens are optional. Add normal, gold, shiny, rainbow, god, or god-prismatic to specify the card.

Card Rarities: Common 60%, Rare 25%, Epic 10%, Legendary 4%, Mythical 1%
Modifier Rarities: Normal 96%, Gold 3%, Shiny 0.9%, Rainbow 0.1%
God Pack: 5% per pack; Prismatic: 1% per God Pack card`
  });
});


app.command("/slacktcg-pack", async ({ command, ack, respond, client }) => {
  await ack();

  const luckyHour = isLuckyHour();

  if (luckyHour) {
    try {
      await announceLuckyHour(client, command.team_id);
    } catch (error) {
      console.error("Could not announce Lucky Hour in #gaming", error);
    }
  }
  const rarityWeights = [
    { rarity: "Common", chance: 60 },
    { rarity: "Rare", chance: 25 },
    { rarity: "Epic", chance: 10 },
    { rarity: "Legendary", chance: 4 },
    { rarity: "Mythical", chance: 1 }
  ].map(item => ({
    ...item,
    chance: luckyHour && item.rarity !== "Common"
      ? item.chance * 3
      : item.chance
  }));


  function getRandomRarity(minimumRarity = "Common") {
    const minimumRank = {
      Common: 0,
      Rare: 1,
      Epic: 2,
      Legendary: 3,
      Mythical: 4
    }[minimumRarity];
    const eligibleWeights = rarityWeights.filter(
      item => ({
        Common: 0,
        Rare: 1,
        Epic: 2,
        Legendary: 3,
        Mythical: 4
      })[item.rarity] >= minimumRank
    );
    const totalWeight = eligibleWeights.reduce(
      (total, item) => total + item.chance,
      0
    );
    const roll = Math.random() * totalWeight;
    let total = 0;

    for (const item of eligibleWeights) {
      total += item.chance;

      if (roll < total) {
        return item.rarity;
      }
    }
  }

  function getRarityProbability(rarity, minimumRarity = "Common") {
    const rarityRank = {
      Common: 0,
      Rare: 1,
      Epic: 2,
      Legendary: 3,
      Mythical: 4
    };
    const eligibleWeights = rarityWeights.filter(
      item => rarityRank[item.rarity] >= rarityRank[minimumRarity]
    );
    const totalWeight = eligibleWeights.reduce(
      (total, item) => total + item.chance,
      0
    );
    const selectedWeight = eligibleWeights.find(
      item => item.rarity === rarity
    )?.chance || 0;

    return selectedWeight / totalWeight;
  }


  function getVariant() {
    const roll = Math.random() * 100;
    const multiplier = luckyHour ? 3 : 1;

    if (roll < 0.1 * multiplier) {
      return "🌈 Rainbow";
    }

    if (roll < 1 * multiplier) {
      return "✨ Shiny";
    }

    if (roll < 4 * multiplier) {
      return "🟨 Gold";
    }

    return "Normal";
  }

  function getVariantProbability(variant) {
    const multiplier = luckyHour ? 3 : 1;
    const probabilities = {
      "🌈 Rainbow": 0.001 * multiplier,
      "✨ Shiny": 0.009 * multiplier,
      "🟨 Gold": 0.03 * multiplier,
      Normal: 1 - 0.04 * multiplier
    };

    return probabilities[variant] || 0;
  }


  const userId = `${command.team_id}:${command.user_id}`;

  if (!users[userId]) {
    users[userId] = {
      cards: []
    };
  }

  const user = users[userId];
  const cooldown = getPackCooldown(user);

  if (cooldown > 0) {
    await respond(
      `⏳ You can open another pack in ${Math.ceil(cooldown / 1000)} seconds.`
    );
    return;
  }

  let memberCards;

  try {
    memberCards = await getChannelMemberCards(client, command.channel_id);
  } catch (error) {
    console.error("Could not load channel members", error);
    await respond(
      "❌ I couldn't load this channel's members. Check that the app has the required channel and user scopes."
    );
    return;
  }

  if (memberCards.length === 0) {
    await respond("❌ This channel has no eligible members to use as cards.");
    return;
  }

  const godPack = Math.random() < 0.05;
  const godPackMember = godPack
    ? memberCards[Math.floor(Math.random() * memberCards.length)]
    : null;
  const pack = [];

  for (let i = 0; i < 5; i++) {

    const minimumRarity = godPack ? "Rare" : "Common";
    const rarity = getRandomRarity(minimumRarity);
    const card = godPack
      ? godPackMember
      : memberCards[Math.floor(Math.random() * memberCards.length)];
    const variant = godPack ? "👑 God" : getVariant();
    const prismatic = godPack && Math.random() < 0.01;
    const rarityProbability = getRarityProbability(rarity, minimumRarity);
    const pullOddsProbability = godPack
      ? 0.05 * rarityProbability * (prismatic ? 0.01 : 0.99)
      : 0.95 * rarityProbability * getVariantProbability(variant);

    pack.push({
      ...card,
      rarity,
      variant,
      prismatic,
      pullOddsProbability
    });
  }

  users[userId].cards.push(...pack);
  user.packsOpened = (user.packsOpened || 0) + 1;
  user.lastPack = Date.now();
  recordPackStats(command.team_id, command.user_id, pack);
  saveUsers();


  const packBlocks = pack
    .flatMap(card => {
      let text =
        `🃏 *${card.name}*
${rarityIcons[card.rarity]} *${card.rarity}*`;

      if (card.variant !== "Normal") {
        text += `\n✨ Modifier: ${card.variant}`;
      }

      if (card.prismatic) {
        text += "\n🔮 Finish: *Prismatic*";
      }

      text += `\n🎲 Total odds: *${formatCardOdds(card)}*`;

      const cardBlock = {
        type: "section",
        text: {
          type: "mrkdwn",
          text
        }
      };

      if (card.imageUrl) {
        cardBlock.accessory = {
          type: "image",
          image_url: card.imageUrl,
          alt_text: `${card.name} profile photo`
        };
      }

      return [cardBlock];
    });


  await respond({
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: godPack
            ? "⚡ GOD PACK ⚡"
            : "🎴 SlackTCG Pack Opened!"
        }
      },
      ...(luckyHour
        ? [{
            type: "section",
            text: {
              type: "mrkdwn",
              text: "🍀 *LUCKY HOUR!* Rare-card and special-modifier odds are tripled in every channel."
            }
          }]
        : []),
      ...packBlocks
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

function normalizeCardName(value) {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

function getEditDistance(left, right) {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index
  );

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function findTradeCard(cards, cardArg) {
  const variants = {
    normal: "Normal",
    gold: "🟨 Gold",
    shiny: "✨ Shiny",
    rainbow: "🌈 Rainbow",
    god: "👑 God"
  };
  const explicitVariant = cardArg.match(
    /^(.*?)[\s_-]+(normal|gold|shiny|rainbow|god)(?:[\s_-]+(prismatic))?\s*$/i
  );
  let candidates;

  if (explicitVariant) {
    const requestedName = normalizeCardName(explicitVariant[1]);
    const requestedVariant = variants[explicitVariant[2].toLowerCase()];
    candidates = cards
      .map((card, index) => ({ card, index }))
      .filter(({ card }) =>
        card.variant === requestedVariant &&
        Boolean(card.prismatic) === Boolean(explicitVariant[3])
      )
      .map(match => ({
        ...match,
        distance: getEditDistance(
          normalizeCardName(match.card.name),
          requestedName
        )
      }));
  } else {
    const requestedCard = normalizeCardName(cardArg);
    candidates = cards
      .map((card, index) => ({ card, index }))
      .map(match => {
        const card = match.card;
        const modifier = card.variant === "Normal"
          ? ""
          : card.variant.replace(/^[^A-Za-z]+/, "");
        const finish = card.prismatic ? "Prismatic" : "";

        return {
          ...match,
          distance: getEditDistance(
            normalizeCardName(`${card.name}${modifier}${finish}`),
            requestedCard
          )
        };
      });
  }

  const exactMatches = candidates.filter(match => match.distance === 0);
  const matches = exactMatches.length > 0
    ? exactMatches
    : candidates.filter(match => match.distance === 1);
  const uniqueMatches = new Map();

  for (const match of matches) {
    const key =
      `${match.card.name.toLowerCase()}:${match.card.variant}:${Boolean(match.card.prismatic)}`;
    if (!uniqueMatches.has(key)) uniqueMatches.set(key, match);
  }

  return [...uniqueMatches.values()];
}

app.command("/slacktcg-inventory", async ({ command, ack, respond }) => {
  await ack();

  const userId = `${command.team_id}:${command.user_id}`;

  if (!users[userId] || users[userId].cards.length === 0) {
    await respond({
      text: "📦 Your inventory is empty!"
    });
    return;
  }

  const grouped = {};

  for (const card of users[userId].cards) {
    const key =
      `${card.id}-${card.rarity}-${card.variant}-${Boolean(card.prismatic)}`;

    if (!grouped[key]) {
      grouped[key] = {
        ...card,
        count: 0
      };
    }

    grouped[key].count++;
  }

  const inventoryEntries = Object.values(grouped)
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

      if (card.prismatic) {
        text += "\n🔮 Finish: *Prismatic*";
      }

      return text;
    });
  const separator = "\n\n────────────\n\n";
  const inventoryChunks = [];
  let currentChunk = "";

  for (const entry of inventoryEntries) {
    const nextChunk = currentChunk
      ? `${currentChunk}${separator}${entry}`
      : entry;

    if (nextChunk.length > 2800 && currentChunk) {
      inventoryChunks.push(currentChunk);
      currentChunk = entry;
    } else {
      currentChunk = nextChunk;
    }
  }

  if (currentChunk) inventoryChunks.push(currentChunk);

  const visibleChunks = inventoryChunks.slice(0, 49);

  if (inventoryChunks.length > 49) {
    visibleChunks[48] =
      `${visibleChunks[48]}\n\n_Inventory truncated because it is too large for one Slack message._`;
  }

  await respond({
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🎒 Your SlackTCG Inventory"
        }
      },
      ...visibleChunks.map(text => ({
        type: "section",
        text: {
          type: "mrkdwn",
          text
        }
      }))
    ]
  });
});

app.command("/slacktcg-leaderboard", async ({ command, ack, respond }) => {
  await ack();

  const teamPrefix = `${command.team_id}:`;
  const workspaceUsers = Object.entries(users)
    .filter(([key]) => key.startsWith(teamPrefix))
    .map(([key, user]) => ({
      slackUserId: key.slice(teamPrefix.length),
      packsOpened: user.packsOpened || 0,
      mythicals: (user.cards || []).filter(
        card => card.rarity === "Mythical"
      ).length
    }));

  const topPackOpeners = [...workspaceUsers]
    .filter(user => user.packsOpened > 0)
    .sort((a, b) => b.packsOpened - a.packsOpened)
    .slice(0, 3);
  const topMythicalOwners = [...workspaceUsers]
    .filter(user => user.mythicals > 0)
    .sort((a, b) => b.mythicals - a.mythicals)
    .slice(0, 3);
  const rarestPull = stats.teams[command.team_id]?.rarestPull;

  const formatRanking = (ranking, property, singular, plural) =>
    ranking.length > 0
      ? ranking.map((user, index) => {
          const count = user[property];
          return `${index + 1}. <@${user.slackUserId}> — ${count} ${count === 1 ? singular : plural}`;
        }).join("\n")
      : "_No qualifying players yet._";

  let rarestPullText = "_No cards have been recorded yet._";

  if (rarestPull) {
    const card = rarestPull.card;
    rarestPullText =
      `🃏 *${card.name}*\n` +
      `${rarityIcons[card.rarity]} *${card.rarity}*` +
      (card.variant !== "Normal" ? ` · ${card.variant}` : "") +
      (card.prismatic ? " · 🔮 Prismatic" : "") +
      `\n🎲 Total odds: *${formatCardOdds(card)}*` +
      `\nPulled by <@${rarestPull.pulledBy}>`;
  }

  await respond({
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🏆 SlackTCG Leaderboard"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Most Packs Opened*\n${formatRanking(
            topPackOpeners,
            "packsOpened",
            "pack",
            "packs"
          )}`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Most Mythicals Owned*\n${formatRanking(
            topMythicalOwners,
            "mythicals",
            "Mythical",
            "Mythicals"
          )}`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Rarest Card Ever Pulled*\n${rarestPullText}`
        }
      }
    ]
  });
});

app.command("/slacktcg-trade", async ({ command, ack, respond, client }) => {
  await ack();

  const senderId = `${command.team_id}:${command.user_id}`;

  const firstSpace = command.text.indexOf(" ");

  if (firstSpace === -1) {
    await respond(
      "❌ Usage: `/slacktcg-trade @user card-name`"
    );
    return;
  }

  const targetArg = command.text.substring(0, firstSpace);
  const cardArg = command.text.substring(firstSpace + 1).trim();

  const targetSlackId = await resolveSlackUserId(client, targetArg);

  if (!targetSlackId) {
    await respond(
      "❌ I couldn't find that user. Select them from Slack's @mention autocomplete and try again."
    );
    return;
  }

  const targetId = `${command.team_id}:${targetSlackId}`;

  if (!users[senderId] || users[senderId].cards.length === 0) {
    await respond("❌ You don't have any cards.");
    return;
  }

  if (!users[targetId]) {
    users[targetId] = {
      cards: []
    };
  }

  const matchingCards = findTradeCard(users[senderId].cards, cardArg);

  if (matchingCards.length === 0) {
    await respond(
      `❌ You don't own a card matching "${cardArg}".`
    );
    return;
  }

  if (matchingCards.length > 1) {
    await respond(
      "❌ That card name is ambiguous. Add `-normal`, `-gold`, `-shiny`, `-rainbow`, `-god`, or `-god-prismatic` to specify the exact card."
    );
    return;
  }

  const tradedCard = users[senderId].cards.splice(
    matchingCards[0].index,
    1
  )[0];

  users[targetId].cards.push(tradedCard);

  saveUsers();

  let text =
    `🤝 *Trade Complete!*\n\n` +
    `<@${command.user_id}> gave:\n` +
    `🃏 *${tradedCard.name}*\n` +
    `${rarityIcons[tradedCard.rarity]} ${tradedCard.rarity}`;

  if (tradedCard.variant !== "Normal") {
    text += `\n✨ Modifier: ${tradedCard.variant}`;
  }

  if (tradedCard.prismatic) {
    text += "\n🔮 Finish: *Prismatic*";
  }

  text += `\n\nTo:\n<@${targetSlackId}>`;

  await respond({
    response_type: "in_channel",
    text
  });
});



(async () => {
  const port = Number(process.env.PORT || 3000);
  const oauthServer = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, publicBaseUrl).pathname;

      if (req.method === "GET" && pathname === "/slack/install") {
        await installProvider.handleInstallPath(req, res);
        return;
      }

      if (req.method === "GET" && pathname === "/slack/oauth_redirect") {
        await installProvider.handleCallback(req, res);
        return;
      }

      const customRoute = customRoutes.find(
        route => route.method === req.method && route.path === pathname
      );

      if (customRoute) {
        customRoute.handler(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (error) {
      console.error("HTTP request failed", error);

      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }

      res.end("Internal server error");
    }
  });

  await new Promise((resolve, reject) => {
    oauthServer.once("error", reject);
    oauthServer.listen(port, resolve);
  });

  await app.start();
  console.log("SlackTCG is connected through Socket Mode");
  console.log(`Install URL: ${publicBaseUrl}/slack/install`);
  console.log(`OAuth redirect URL: ${redirectUri}`);
})();
