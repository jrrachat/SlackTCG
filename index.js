require("dotenv").config();

const { App } = require("@slack/bolt");
const { FileInstallationStore, InstallProvider } = require("@slack/oauth");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const usersPath = __dirname + "/data/users.json";
const statsPath = __dirname + "/data/stats.json";
const PACK_COOLDOWN = 30 * 1000;
const TRADE_EXPIRATION = 10 * 60 * 1000;
const AUCTION_DURATION = 60 * 1000;
const MEMBER_CARD_CACHE_DURATION = 5 * 60 * 1000;
const pendingTrades = new Map();
const activeAuctions = new Map();
const memberCardCache = new Map();

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

  for (const card of user.cards) {
    if (!card.generation) {
      card.generation = 1;
      removedLegacyCards = true;
    }
  }
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
  if (
    Number.isFinite(card.pullOddsProbability) &&
    card.pullOddsProbability > 0
  ) {
    return card.pullOddsProbability;
  }

  const normalRarityOdds = {
    Common: 0.6,
    Rare: 0.25,
    Epic: 0.1,
    Legendary: 0.04,
    Mythical: 0.01,
    BOYLED: 0.0001
  };
  const godPackRarityOdds = {
    Rare: 0.625,
    Epic: 0.25,
    Legendary: 0.1,
    Mythical: 0.025,
    BOYLED: 0.0001
  };
  const variantOdds = {
    Normal: 0.96,
    "🟨 Gold": 0.03,
    "✨ Shiny": 0.009,
    "🌈 Rainbow": 0.001
  };

  const memberProbability = 1 / (card.memberPoolSize || 1);

  if (card.variant === "👑 God") {
    return memberProbability *
      0.05 *
      (godPackRarityOdds[card.rarity] || 0) *
      (card.prismatic ? 0.01 : 0.99);
  }

  return memberProbability *
    0.95 *
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
  const oneIn = 1 / probability;
  const oneInText = oneIn < 10
    ? oneIn.toFixed(2)
    : Math.round(oneIn).toLocaleString("en-US");

  return `${percentageText}% (1 in ${oneInText})`;
}

function formatCardRarityScore(card) {
  const probability = getCardOddsProbability(card);

  if (!probability) return "Unknown";

  const memberProbability = 1 / (card.memberPoolSize || 1);
  const mostCommonCardProbability =
    memberProbability * 0.95 * 0.6 * 0.96;
  const score = mostCommonCardProbability / probability;

  return score >= 100
    ? Math.round(score).toLocaleString("en-US")
    : score.toFixed(2).replace(/\.?0+$/, "");
}

function getRarestPullKey(pull) {
  const card = pull.card;

  return [
    pull.pulledBy,
    card.id,
    card.rarity,
    card.variant,
    Boolean(card.prismatic),
    card.generation || 1
  ].join(":");
}

function addRarestPull(teamStats, pull) {
  const existingPulls = teamStats.rarestPulls ||
    (teamStats.rarestPull ? [teamStats.rarestPull] : []);
  const pullsByKey = new Map(
    existingPulls.map(existing => [getRarestPullKey(existing), existing])
  );

  const pullKey = getRarestPullKey(pull);

  if (!pullsByKey.has(pullKey)) {
    pullsByKey.set(pullKey, pull);
  }

  const nextPulls = [...pullsByKey.values()]
    .sort((left, right) =>
      getCardOddsProbability(left.card) -
      getCardOddsProbability(right.card)
    )
    .slice(0, 3);
  const changed =
    JSON.stringify(nextPulls) !== JSON.stringify(teamStats.rarestPulls || []);

  teamStats.rarestPulls = nextPulls;
  teamStats.rarestPull = nextPulls[0] || null;
  return changed;
}

function recordPackStats(teamId, slackUserId, pack) {
  stats ||= {};
  stats.teams ||= {};
  const teamStats = stats.teams[teamId] ||= {};

  for (const card of pack) {
    const probability = getCardOddsProbability(card);

    addRarestPull(teamStats, {
      card,
      probability,
      pulledBy: slackUserId,
      pulledAt: Date.now()
    });
  }

  saveStats();
}

function refreshRarestPullsFromInventories() {
  let changed = false;
  stats.teams ||= {};

  for (const [userKey, user] of Object.entries(users)) {
    const separatorIndex = userKey.indexOf(":");
    if (separatorIndex === -1) continue;

    const teamId = userKey.slice(0, separatorIndex);
    const slackUserId = userKey.slice(separatorIndex + 1);
    const teamStats = stats.teams[teamId] ||= {};

    for (const card of user.cards || []) {
      if (card.merged) continue;

      const probability = getCardOddsProbability(card);

      if (probability) {
        changed = addRarestPull(teamStats, {
          card,
          probability,
          pulledBy: slackUserId,
          pulledAt: null
        }) || changed;
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

function getCurrentGeneration(timestamp = Date.now()) {
  return Math.max(1, new Date(timestamp).getUTCFullYear() - 2025);
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
  BOYLED: "🥚",
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

async function getChannelMemberCards(client, channelId, teamId = "") {
  const cacheKey = `${teamId}:${channelId}`;
  const cached = memberCardCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.cards;
  }

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

  const cards = members
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

  memberCardCache.set(cacheKey, {
    cards,
    expiresAt: Date.now() + MEMBER_CARD_CACHE_DURATION
  });

  return cards;
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
        <p><strong>/slacktcg-inventory [@user]</strong> — View your or another player's five rarest cards.</p>
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

/slacktcg-inventory [@user]
View your or another player's five rarest cards

/slacktcg-rarestof @user
View another player's five rarest cards

/slacktcg-leaderboard
View the workspace's pack-opening leaders and rarest pull

/slacktcg-odds
View pull odds, your luckiness, and the workspace's luckiest players

/slacktcg-auction <card>
Auction a card for one minute; the rarest valid card offer wins

/slacktcg merge <rarity>
Merge 10 random cards into one card of the next rarity

/slacktcg-trade @user <card>
Trade the rarest matching member card by default. Add rarity, modifier, finish, or generation with hyphens in any order to specify a card.

Card Rarities: Common 60%, Rare 25%, Epic 10%, Legendary 4%, Mythical 1%
Modifier Rarities: Normal 96%, Gold 3%, Shiny 0.9%, Rainbow 0.1%
God Pack: 5% per pack; Prismatic: 1% per God Pack card`
  });
});


app.command("/slacktcg-pack", async ({ command, ack, respond, client }) => {
  await ack();

  try {
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
  user.cards = Array.isArray(user.cards) ? user.cards : [];
  const cooldown = getPackCooldown(user);

  if (cooldown > 0) {
    await respond(
      `⏳ You can open another pack in ${Math.ceil(cooldown / 1000)} seconds.`
    );
    return;
  }

  let memberCards;

  try {
    memberCards = await getChannelMemberCards(
      client,
      command.channel_id,
      command.team_id
    );
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
    const rarity = Math.random() < 0.0001
      ? "BOYLED"
      : getRandomRarity(minimumRarity);
    const card = godPack
      ? godPackMember
      : memberCards[Math.floor(Math.random() * memberCards.length)];
    const variant = godPack ? "👑 God" : getVariant();
    const prismatic = godPack && Math.random() < 0.01;
    const rarityProbability = rarity === "BOYLED"
      ? 0.0001
      : 0.9999 * getRarityProbability(rarity, minimumRarity);
    const pullOddsProbability = godPack
      ? (1 / memberCards.length) *
        0.05 *
        rarityProbability *
        (prismatic ? 0.01 : 0.99)
      : (1 / memberCards.length) *
        0.95 *
        rarityProbability *
        getVariantProbability(variant);

    pack.push({
      ...card,
      rarity,
      variant,
      prismatic,
      generation: getCurrentGeneration(),
      memberPoolSize: memberCards.length,
      pullOddsProbability
    });
  }

  users[userId].cards.push(...pack);
  user.packsOpened = (user.packsOpened || 0) + 1;
  user.pullStats ||= {
    totalPulls: 0,
    rarePulls: 0,
    expectedRarePulls: 0
  };
  const standardPackWeight = rarityWeights.reduce(
    (total, item) => total + item.chance,
    0
  );
  const commonWeight = rarityWeights.find(
    item => item.rarity === "Common"
  ).chance;
  const standardRareProbability =
    1 - commonWeight / standardPackWeight;
  const overallRareProbability =
    0.05 + 0.95 * standardRareProbability;
  user.pullStats.totalPulls += pack.length;
  user.pullStats.rarePulls += pack.filter(
    card => card.rarity !== "Common"
  ).length;
  user.pullStats.expectedRarePulls +=
    pack.length * overallRareProbability;
  user.lastPack = Date.now();
  recordPackStats(command.team_id, command.user_id, pack);
  saveUsers();


  const packBlocks = pack
    .flatMap(card => {
      let details =
        `${rarityIcons[card.rarity]} *${card.rarity}* · ` +
        `Gen ${card.generation || 1}`;

      if (card.variant !== "Normal") {
        details += ` · ${card.variant}`;
      }

      if (card.prismatic) {
        details += " · 🔮 Prismatic";
      }

      details += `\nOdds: *${formatCardOdds(card)}*`;

      const cardBlock = {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🃏 *${card.name}*`
        }
      };

      if (card.imageUrl) {
        cardBlock.accessory = {
          type: "image",
          image_url: card.imageUrl,
          alt_text: `${card.name} profile photo`
        };
      }

      return [
        cardBlock,
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: details
            }
          ]
        }
      ];
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
  } catch (error) {
    console.error("Could not open pack", error);

    try {
      await respond(
        "❌ Pack failed. Check the server log for `Could not open pack`."
      );
    } catch (responseError) {
      console.error("Could not send pack error response", responseError);
    }
  }
});
const rarityOrder = {
  BOYLED: -1,
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
  const rarities = {
    boyled: "BOYLED",
    common: "Common",
    rare: "Rare",
    epic: "Epic",
    legendary: "Legendary",
    mythical: "Mythical"
  };
  const requested = {
    rarity: null,
    variant: null,
    prismatic: null,
    generation: null
  };
  const applyDescriptor = token => {
    const normalized = token.toLowerCase().replace(/\s+/g, "");

    if (normalized in rarities) {
      requested.rarity = rarities[normalized];
      return true;
    }

    if (normalized in variants) {
      requested.variant = variants[normalized];
      return true;
    }

    if (normalized === "prismatic") {
      requested.prismatic = true;
      return true;
    }

    if (normalized === "nonprismatic" || normalized === "standard") {
      requested.prismatic = false;
      return true;
    }

    const generation = normalized.match(/^gen(?:eration)?(\d+)$/);

    if (generation) {
      requested.generation = Number(generation[1]);
      return true;
    }

    return false;
  };
  const nameParts = [];

  for (const part of cardArg.split("-").map(value => value.trim()).filter(Boolean)) {
    if (!applyDescriptor(part)) nameParts.push(part);
  }

  const trailingNameParts = nameParts.join("-").trim().split(/\s+/);

  while (
    trailingNameParts.length > 1 &&
    applyDescriptor(trailingNameParts[trailingNameParts.length - 1])
  ) {
    trailingNameParts.pop();
  }

  let requestedName = normalizeCardName(trailingNameParts.join(" "));
  let candidates = cards
    .map((card, index) => ({
      card,
      index,
      distance: getEditDistance(
        normalizeCardName(card.name),
        requestedName
      )
    }))
    .filter(({ card }) =>
      (requested.rarity === null || card.rarity === requested.rarity) &&
      (requested.variant === null || card.variant === requested.variant) &&
      (
        requested.prismatic === null ||
        Boolean(card.prismatic) === requested.prismatic
      ) &&
      (
        requested.generation === null ||
        (card.generation || 1) === requested.generation
      )
    );

  if (candidates.length === 0 && nameParts.length !== cardArg.split("-").length) {
    requestedName = normalizeCardName(cardArg);
    candidates = cards.map((card, index) => ({
      card,
      index,
      distance: getEditDistance(
        normalizeCardName(card.name),
        requestedName
      )
    }));
  }

  const closestDistance = Math.min(
    ...candidates.map(candidate => candidate.distance),
    Infinity
  );

  if (closestDistance > 1) return [];

  return candidates
    .filter(candidate => candidate.distance === closestDistance)
    .sort((left, right) =>
      getCardOddsProbability(left.card) -
      getCardOddsProbability(right.card)
    )
    .slice(0, 1);
}

function getCardCollectionKey(card) {
  return `${card.id}-${card.rarity}-${card.variant}-${Boolean(card.prismatic)}-` +
    `${card.generation || 1}-${getCardOddsProbability(card)}`;
}

function getFiveRarestCollectionKeys(cards) {
  const uniqueCards = new Map();

  for (const card of cards) {
    const key = getCardCollectionKey(card);
    if (!uniqueCards.has(key)) uniqueCards.set(key, card);
  }

  return new Set(
    [...uniqueCards.entries()]
      .sort(([, left], [, right]) => {
        const oddsDifference =
          getCardOddsProbability(left) - getCardOddsProbability(right);

        if (oddsDifference !== 0) return oddsDifference;

        const rarityDifference =
          (rarityOrder[left.rarity] ?? 999) -
          (rarityOrder[right.rarity] ?? 999);

        if (rarityDifference !== 0) return rarityDifference;

        return left.name.localeCompare(right.name);
      })
      .slice(0, 5)
      .map(([key]) => key)
  );
}

app.command("/slacktcg-inventory", async ({ command, ack, respond, client }) => {
  await ack();

  const targetArg = command.text.trim();
  const targetSlackId = targetArg
    ? await resolveSlackUserId(client, targetArg)
    : command.user_id;

  if (!targetSlackId) {
    await respond(
      "❌ I couldn't find that user. Select them from Slack's @mention autocomplete and try again."
    );
    return;
  }

  const userId = `${command.team_id}:${targetSlackId}`;
  const viewingAnotherUser = targetSlackId !== command.user_id;

  if (!users[userId] || users[userId].cards.length === 0) {
    await respond({
      text: viewingAnotherUser
        ? `📦 <@${targetSlackId}>'s inventory is empty!`
        : "📦 Your inventory is empty!"
    });
    return;
  }

  const grouped = {};

  for (const card of users[userId].cards) {
    const key = getCardCollectionKey(card);

    if (!grouped[key]) {
      grouped[key] = {
        ...card,
        count: 0
      };
    }

    grouped[key].count++;
  }

  const groupedCards = Object.values(grouped);
  const inventoryEntries = groupedCards
    .sort((a, b) => {
      const oddsDifference =
        getCardOddsProbability(a) - getCardOddsProbability(b);

      if (oddsDifference !== 0) return oddsDifference;

      const rarityDifference =
        (rarityOrder[a.rarity] ?? 999) -
        (rarityOrder[b.rarity] ?? 999);

      if (rarityDifference !== 0) return rarityDifference;

      return a.name.localeCompare(b.name);
    })
    .slice(0, 5)
    .map(card => {
      let text =
        `🃏 *${card.name}* x${card.count}
${rarityIcons[card.rarity]} *${card.rarity}*
📅 *Gen ${card.generation || 1}*
Odds: *${formatCardOdds(card)}*`;

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
  const rarityTotals = {
    Common: 0,
    Rare: 0,
    Epic: 0,
    Legendary: 0,
    Mythical: 0
  };

  for (const card of users[userId].cards) {
    if (card.rarity === "BOYLED") {
      rarityTotals.BOYLED = (rarityTotals.BOYLED || 0) + 1;
      continue;
    }

    if (card.rarity in rarityTotals) {
      rarityTotals[card.rarity]++;
    }
  }
  const raritySummary = Object.entries(rarityTotals)
    .map(([rarity, count]) => `${rarityIcons[rarity]} ${rarity}: *${count}*`)
    .join("  ·  ");

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
          text: viewingAnotherUser
            ? "🎒 Player's 5 Rarest Cards"
            : "🎒 Your 5 Rarest Cards"
        }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text:
              (viewingAnotherUser ? `<@${targetSlackId}>\n` : "") +
              `Showing ${Math.min(5, groupedCards.length)} of ` +
              `${groupedCards.length} unique cards.\n${raritySummary}`
          }
        ]
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

app.command("/slacktcg-rarestof", async ({
  command,
  ack,
  respond,
  client
}) => {
  await ack();

  const targetArg = command.text.trim();

  if (!targetArg) {
    await respond("❌ Usage: `/slacktcg-rarestof @person`");
    return;
  }

  const targetSlackId = await resolveSlackUserId(client, targetArg);

  if (!targetSlackId) {
    await respond(
      "❌ I couldn't find that user. Select them from Slack's @mention autocomplete and try again."
    );
    return;
  }

  const cards = users[`${command.team_id}:${targetSlackId}`]?.cards || [];

  if (cards.length === 0) {
    await respond(`📦 <@${targetSlackId}>'s inventory is empty!`);
    return;
  }

  const groupedCards = new Map();

  for (const card of cards) {
    const key = getCardCollectionKey(card);
    const existing = groupedCards.get(key);

    if (existing) {
      existing.count++;
    } else {
      groupedCards.set(key, { ...card, count: 1 });
    }
  }

  const rarestCards = [...groupedCards.values()]
    .sort((left, right) => {
      const oddsDifference =
        getCardOddsProbability(left) - getCardOddsProbability(right);

      if (oddsDifference !== 0) return oddsDifference;
      return left.name.localeCompare(right.name);
    })
    .slice(0, 5);

  await respond({
    text: `${targetArg}'s five rarest SlackTCG cards`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🏆 5 Rarest Cards"
        }
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `<@${targetSlackId}>`
        }]
      },
      ...rarestCards.map(card => {
        let details =
          `${rarityIcons[card.rarity] || "🃏"} *${card.rarity}* · ` +
          `Gen ${card.generation || 1} · ` +
          `Rarity Score: *${formatCardRarityScore(card)}* · ` +
          `Owned: *${card.count}*`;

        if (card.variant !== "Normal") {
          details += ` · ${card.variant}`;
        }

        if (card.prismatic) {
          details += " · 🔮 Prismatic";
        }

        return {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🃏 *${card.name}*\n${details}`
          },
          ...(card.imageUrl
            ? {
                accessory: {
                  type: "image",
                  image_url: card.imageUrl,
                  alt_text: `${card.name} profile photo`
                }
              }
            : {})
        };
      })
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
      packsOpened: user.packsOpened || 0
    }));

  const topPackOpeners = [...workspaceUsers]
    .filter(user => user.packsOpened > 0)
    .sort((a, b) => b.packsOpened - a.packsOpened)
    .slice(0, 15);
  const teamStats = stats.teams[command.team_id] || {};
  const rarestPulls = teamStats.rarestPulls ||
    (teamStats.rarestPull ? [teamStats.rarestPull] : []);

  const formatRanking = (ranking, property, singular, plural) =>
    ranking.length > 0
      ? ranking.map((user, index) => {
          const count = user[property];
          return `${index + 1}. <@${user.slackUserId}> — ${count} ${count === 1 ? singular : plural}`;
        }).join("\n")
      : "_No qualifying players yet._";

  const rarestPullText = rarestPulls.length > 0
    ? rarestPulls.map((pull, index) => {
        const card = pull.card;

        return (
          `*${index + 1}.* 🃏 *${card.name}*\n` +
          `${rarityIcons[card.rarity] || "🃏"} *${card.rarity}*` +
          (card.variant !== "Normal" ? ` · ${card.variant}` : "") +
          (card.prismatic ? " · 🔮 Prismatic" : "") +
          ` · 📅 Gen ${card.generation || 1}` +
          `\nRarity Score: *${formatCardRarityScore(card)}*` +
          ` · Pulled by <@${pull.pulledBy}>`
        );
      }).join("\n\n")
    : "_No cards have been recorded yet._";

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
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `*Most Packs Opened*\n${formatRanking(
            topPackOpeners,
            "packsOpened",
            "pack",
            "packs"
          )}`
        }]
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `*3 Rarest Cards Ever Pulled*\n${rarestPullText}`
        }]
      }
    ]
  });
});

function getLuckiness(user) {
  const pullStats = user.pullStats;

  if (!pullStats?.totalPulls || !pullStats.expectedRarePulls) return null;

  return pullStats.rarePulls / pullStats.expectedRarePulls * 100;
}

app.command("/slacktcg-odds", async ({ command, ack, respond }) => {
  await ack();

  const userId = `${command.team_id}:${command.user_id}`;
  const user = users[userId];
  const pullStats = user?.pullStats;
  const luckiness = getLuckiness(user || {});
  const teamPrefix = `${command.team_id}:`;
  const luckiestPlayers = Object.entries(users)
    .filter(([key]) => key.startsWith(teamPrefix))
    .map(([key, player]) => ({
      slackUserId: key.slice(teamPrefix.length),
      luckiness: getLuckiness(player),
      totalPulls: player.pullStats?.totalPulls || 0,
      rarePulls: player.pullStats?.rarePulls || 0
    }))
    .filter(player => player.luckiness !== null)
    .sort((a, b) => b.luckiness - a.luckiness)
    .slice(0, 3);

  const personalLuckText = pullStats
    ? `${pullStats.rarePulls} Rare+ pulls out of ${pullStats.totalPulls} total\n` +
      `Expected Rare+ pulls: ${pullStats.expectedRarePulls.toFixed(2)}\n` +
      `Luckiness: *${luckiness.toFixed(1)}%* ` +
      `(${luckiness >= 100 ? "above" : "below"} average)`
    : "_No tracked pulls yet. Open a pack to begin tracking._";
  const luckiestText = luckiestPlayers.length > 0
    ? luckiestPlayers.map((player, index) =>
        `${index + 1}. <@${player.slackUserId}> — ` +
        `*${player.luckiness.toFixed(1)}%* luckiness ` +
        `(${player.rarePulls}/${player.totalPulls} Rare+)`
      ).join("\n")
    : "_No tracked players yet._";

  await respond({
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🎲 SlackTCG Odds & Luck"
        }
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text:
            "*Card Rarity Odds*\n" +
            "⚪ Common: 60%\n" +
            "🔵 Rare: 25%\n" +
            "🟣 Epic: 10%\n" +
            "🟠 Legendary: 4%\n" +
            "🔴 Mythical: 1%"
        }]
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text:
            "*Modifier & Finish Odds*\n" +
            "Normal: 96%\n" +
            "🟨 Gold: 3%\n" +
            "✨ Shiny: 0.9%\n" +
            "🌈 Rainbow: 0.1%\n" +
            "🔮 Prismatic: 1% per God Pack card"
        }]
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text:
            "*Special Event Odds*\n" +
            "⚡ God Pack: 5% per pack (1 in 20)\n" +
            "🍀 Lucky Hour: 10% per hour (1 in 10)"
        }]
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `*Your Tracked Luck*\n${personalLuckText}`
        }]
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `*Luckiest Players*\n${luckiestText}`
        }]
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "100% luckiness = expected Rare+ results. New pulls only."
          }
        ]
      }
    ]
  });
});

async function handleMergeCommand({ command, ack, respond, client }) {
  await ack();

  try {
  const commandArgs = command.text.trim().split(/\s+/).filter(Boolean);
  const isDedicatedMergeCommand = command.command === "/slacktcg-merge";
  const subcommand = isDedicatedMergeCommand ? "merge" : commandArgs.shift();
  const rarityArg = commandArgs.shift();

  if (
    subcommand?.toLowerCase() !== "merge" ||
    !rarityArg ||
    commandArgs.length > 0
  ) {
    await respond(
      "❌ Usage: `/slacktcg merge <rarity>` or `/slacktcg-merge <rarity>`"
    );
    return;
  }

  const rarityNames = {
    common: "Common",
    rare: "Rare",
    epic: "Epic",
    legendary: "Legendary",
    mythical: "Mythical"
  };
  const nextRarity = {
    Common: "Rare",
    Rare: "Epic",
    Epic: "Legendary",
    Legendary: "Mythical"
  };
  const rarity = rarityNames[rarityArg.toLowerCase()];

  if (!rarity) {
    await respond(
      "❌ Rarity must be Common, Rare, Epic, Legendary, or Mythical."
    );
    return;
  }

  if (rarity === "Mythical") {
    await respond("❌ Mythical is already the highest rarity.");
    return;
  }

  const userId = `${command.team_id}:${command.user_id}`;
  const userCards = users[userId]?.cards || [];
  const protectedCardKeys = getFiveRarestCollectionKeys(userCards);
  const eligibleCards = userCards
    .map((card, index) => ({ card, index }))
    .filter(({ card }) =>
      card.rarity === rarity &&
      !protectedCardKeys.has(getCardCollectionKey(card))
    );

  if (eligibleCards.length < 10) {
    const ownedAtRarity = userCards.filter(
      card => card.rarity === rarity
    ).length;
    const protectedAtRarity = ownedAtRarity - eligibleCards.length;

    await respond(
      `❌ You need 10 unprotected ${rarity} cards to merge. You have ` +
      `${eligibleCards.length} available` +
      (
        protectedAtRarity > 0
          ? `; ${protectedAtRarity} are protected because they are among ` +
            "your five rarest cards."
          : "."
      )
    );
    return;
  }

  for (let index = eligibleCards.length - 1; index > 0; index--) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [eligibleCards[index], eligibleCards[randomIndex]] =
      [eligibleCards[randomIndex], eligibleCards[index]];
  }

  let memberCards;

  try {
    memberCards = await getChannelMemberCards(
      client,
      command.channel_id,
      command.team_id
    );
  } catch (error) {
    console.error("Could not load channel members for merge", error);
    await respond("❌ I couldn't load this channel's members.");
    return;
  }

  if (memberCards.length === 0) {
    await respond("❌ This channel has no eligible members to pull.");
    return;
  }

  const consumedCards = eligibleCards.slice(0, 10);
  const pulledMember = memberCards[
    Math.floor(Math.random() * memberCards.length)
  ];
  const modifierRoll = Math.random() * 100;
  let variant = "Normal";
  let variantProbability = 0.96;

  if (modifierRoll < 0.1) {
    variant = "🌈 Rainbow";
    variantProbability = 0.001;
  } else if (modifierRoll < 1) {
    variant = "✨ Shiny";
    variantProbability = 0.009;
  } else if (modifierRoll < 4) {
    variant = "🟨 Gold";
    variantProbability = 0.03;
  }

  const upgradedCard = {
    ...pulledMember,
    rarity: nextRarity[rarity],
    variant,
    prismatic: false,
    generation: getCurrentGeneration(),
    memberPoolSize: memberCards.length,
    pullOddsProbability:
      (1 / memberCards.length) * variantProbability,
    merged: true,
    mergedFrom: rarity
  };

  const consumedIndexes = consumedCards
    .map(({ index }) => index)
    .sort((left, right) => right - left);

  for (const index of consumedIndexes) {
    userCards.splice(index, 1);
  }

  userCards.push(upgradedCard);
  recordPackStats(command.team_id, command.user_id, [upgradedCard]);
  saveUsers();

  let resultText =
    `🔮 *Merge Complete!*\n\n` +
    `10 ${rarity} cards → 1 ${upgradedCard.rarity} card\n\n` +
    `🃏 *${upgradedCard.name}*\n` +
    `${rarityIcons[upgradedCard.rarity]} ${upgradedCard.rarity} · ` +
    `Gen ${upgradedCard.generation || 1}`;

  if (upgradedCard.variant !== "Normal") {
    resultText += ` · ${upgradedCard.variant}`;
  }

  if (upgradedCard.prismatic) {
    resultText += " · 🔮 Prismatic";
  }

  resultText +=
    `\nOdds: *${formatCardOdds(upgradedCard)}*`;

  await respond(resultText);
  } catch (error) {
    console.error("Could not merge cards", error);

    try {
      await respond(
        "❌ Merge failed. Check the server log for `Could not merge cards`."
      );
    } catch (responseError) {
      console.error("Could not send merge error response", responseError);
    }
  }
}

app.command("/slacktcg", handleMergeCommand);
app.command("/slacktcg-merge", handleMergeCommand);

function formatAuctionCard(card) {
  let text =
    `🃏 *${card.name}*\n` +
    `${rarityIcons[card.rarity]} ${card.rarity} · ` +
    `Gen ${card.generation || 1}`;

  if (card.variant !== "Normal") {
    text += ` · ${card.variant}`;
  }

  if (card.prismatic) {
    text += " · 🔮 Prismatic";
  }

  text += `\nOdds: *${formatCardOdds(card)}*`;
  return text;
}

async function updateAuctionMessage(auction, payload) {
  const response = await fetch(auction.responseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      replace_original: true,
      response_type: "in_channel",
      ...payload
    })
  });

  if (!response.ok) {
    throw new Error(`Slack auction update failed with ${response.status}`);
  }
}

function getValidAuctionOffers(auction) {
  return [...auction.offers.values()]
    .filter(offer =>
      users[offer.bidderId]?.cards.includes(offer.card)
    )
    .sort((left, right) => {
      const oddsDifference =
        getCardOddsProbability(left.card) -
        getCardOddsProbability(right.card);

      return oddsDifference || left.offeredAt - right.offeredAt;
    });
}

async function renderAuction(auction) {
  const bestOffer = getValidAuctionOffers(auction)[0];
  const secondsRemaining = Math.max(
    0,
    Math.ceil((auction.expiresAt - Date.now()) / 1000)
  );
  const bestOfferText = bestOffer
    ? `\n\n*Current winning offer from <@${bestOffer.bidderSlackId}>:*\n` +
      formatAuctionCard(bestOffer.card)
    : "\n\n_No offers yet._";

  await updateAuctionMessage(auction, {
    text: `<@${auction.sellerSlackId}> is auctioning ${auction.card.name}.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `🔨 *SlackTCG Auction*\n\n` +
            `<@${auction.sellerSlackId}> is auctioning:\n` +
            `${formatAuctionCard(auction.card)}` +
            bestOfferText +
            `\n\n_${secondsRemaining}s remaining · rarest valid offer wins_`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "slacktcg_auction_offer",
            text: {
              type: "plain_text",
              text: "Offer a Card"
            },
            style: "primary",
            value: auction.id
          }
        ]
      }
    ]
  });
}

async function finishAuction(auctionId) {
  const auction = activeAuctions.get(auctionId);

  if (!auction) return;

  activeAuctions.delete(auctionId);
  activeAuctions.delete(auction.channelId);
  const sellerCardIndex =
    users[auction.sellerId]?.cards.indexOf(auction.card) ?? -1;

  if (sellerCardIndex === -1) {
    await updateAuctionMessage(auction, {
      text: "❌ Auction cancelled: the seller no longer owns the listed card.",
      blocks: []
    });
    return;
  }

  const winningOffer = getValidAuctionOffers(auction)[0];

  if (!winningOffer) {
    await updateAuctionMessage(auction, {
      text:
        `⌛ *Auction Ended*\n\nNo valid offers were made for ` +
        `*${auction.card.name}*.`,
      blocks: []
    });
    return;
  }

  const bidderCardIndex =
    users[winningOffer.bidderId].cards.indexOf(winningOffer.card);

  if (bidderCardIndex === -1) {
    await updateAuctionMessage(auction, {
      text: "❌ Auction ended without a valid winning offer.",
      blocks: []
    });
    return;
  }

  const auctionedCard =
    users[auction.sellerId].cards.splice(sellerCardIndex, 1)[0];
  const offeredCard =
    users[winningOffer.bidderId].cards.splice(bidderCardIndex, 1)[0];
  users[auction.sellerId].cards.push(offeredCard);
  users[winningOffer.bidderId].cards.push(auctionedCard);
  saveUsers();

  await updateAuctionMessage(auction, {
    text:
      `🏆 *Auction Complete!*\n\n` +
      `<@${winningOffer.bidderSlackId}> won *${auctionedCard.name}* with ` +
      `*${offeredCard.name}* (odds ${formatCardOdds(offeredCard)}).\n` +
      `<@${auction.sellerSlackId}> received the winning offer.`,
    blocks: []
  });
}

app.command("/slacktcg-auction", async ({ command, ack, respond }) => {
  await ack();

  const cardArg = command.text.trim();
  const sellerId = `${command.team_id}:${command.user_id}`;

  if (!cardArg) {
    await respond("❌ Usage: `/slacktcg-auction <card>`");
    return;
  }

  if (activeAuctions.has(command.channel_id)) {
    await respond("❌ This channel already has an active auction.");
    return;
  }

  const matchingCards = findTradeCard(
    users[sellerId]?.cards || [],
    cardArg
  );

  if (matchingCards.length === 0) {
    await respond(`❌ You don't own a card matching "${cardArg}".`);
    return;
  }

  const auctionCard = matchingCards[0].card;
  const cardAlreadyAuctioned = [...new Set(activeAuctions.values())]
    .some(activeAuction => activeAuction.card === auctionCard);

  if (cardAlreadyAuctioned) {
    await respond("❌ That card is already in another active auction.");
    return;
  }

  const auctionId = crypto.randomUUID();
  const auction = {
    id: auctionId,
    channelId: command.channel_id,
    teamId: command.team_id,
    sellerId,
    sellerSlackId: command.user_id,
    card: auctionCard,
    responseUrl: command.response_url,
    offers: new Map(),
    expiresAt: Date.now() + AUCTION_DURATION
  };

  activeAuctions.set(command.channel_id, auction);
  activeAuctions.set(auctionId, auction);

  await respond({
    response_type: "in_channel",
    text: `<@${command.user_id}> started an auction for ${auction.card.name}.`
  });
  await renderAuction(auction);

  setTimeout(() => {
    finishAuction(auctionId).catch(error => {
      console.error("Could not finish auction", error);
    });
  }, AUCTION_DURATION);
});

app.action("slacktcg_auction_offer", async ({
  ack,
  body,
  action,
  client
}) => {
  await ack();

  const auction = activeAuctions.get(action.value);

  if (!auction || Date.now() >= auction.expiresAt) {
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: "⌛ This auction has ended."
    });
    return;
  }

  if (body.user.id === auction.sellerSlackId) {
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: "❌ You can't bid on your own auction."
    });
    return;
  }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "slacktcg_auction_offer_modal",
      private_metadata: auction.id,
      title: {
        type: "plain_text",
        text: "Auction Offer"
      },
      submit: {
        type: "plain_text",
        text: "Submit Offer"
      },
      close: {
        type: "plain_text",
        text: "Cancel"
      },
      blocks: [
        {
          type: "input",
          block_id: "card_input",
          label: {
            type: "plain_text",
            text: "Card to offer"
          },
          element: {
            type: "plain_text_input",
            action_id: "card_name",
            placeholder: {
              type: "plain_text",
              text: "Example: Jane Doe-mythical-shiny-gen1"
            }
          }
        }
      ]
    }
  });
});

app.view("slacktcg_auction_offer_modal", async ({
  ack,
  body,
  view
}) => {
  const auction = activeAuctions.get(view.private_metadata);
  const cardArg =
    view.state.values.card_input.card_name.value.trim();

  if (!auction || Date.now() >= auction.expiresAt) {
    await ack({
      response_action: "errors",
      errors: {
        card_input: "This auction has ended."
      }
    });
    return;
  }

  const bidderId = `${auction.teamId}:${body.user.id}`;
  const matchingCards = findTradeCard(
    users[bidderId]?.cards || [],
    cardArg
  );

  if (matchingCards.length === 0) {
    await ack({
      response_action: "errors",
      errors: {
        card_input: `You don't own a card matching "${cardArg}".`
      }
    });
    return;
  }

  const offeredCard = matchingCards[0].card;

  if (offeredCard === auction.card) {
    await ack({
      response_action: "errors",
      errors: {
        card_input: "You cannot offer the auctioned card."
      }
    });
    return;
  }

  auction.offers.set(body.user.id, {
    bidderId,
    bidderSlackId: body.user.id,
    card: offeredCard,
    offeredAt: Date.now()
  });
  await ack();
  await renderAuction(auction);
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

  if (targetSlackId === command.user_id) {
    await respond("❌ You can't trade a card to yourself.");
    return;
  }

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
      "❌ That card name is ambiguous. Add its modifier and generation, such as `-shiny-gen1`, to specify the exact card."
    );
    return;
  }

  const requestedCard = matchingCards[0].card;
  const tradeId = crypto.randomUUID();
  let cardText =
    `🃏 *${requestedCard.name}*\n` +
    `${rarityIcons[requestedCard.rarity]} ${requestedCard.rarity}\n` +
    `📅 Gen ${requestedCard.generation || 1}`;

  if (requestedCard.variant !== "Normal") {
    cardText += `\n✨ Modifier: ${requestedCard.variant}`;
  }

  if (requestedCard.prismatic) {
    cardText += "\n🔮 Finish: *Prismatic*";
  }

  pendingTrades.set(tradeId, {
    senderId,
    senderSlackId: command.user_id,
    targetId,
    targetSlackId,
    card: requestedCard,
    responseUrl: command.response_url,
    expiresAt: Date.now() + TRADE_EXPIRATION
  });
  setTimeout(() => pendingTrades.delete(tradeId), TRADE_EXPIRATION);

  await respond({
    response_type: "in_channel",
    text: `<@${command.user_id}> wants to trade ${requestedCard.name} to <@${targetSlackId}>.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `🤝 *Trade Request*\n\n` +
            `<@${command.user_id}> wants to give this card to <@${targetSlackId}>:\n\n` +
            cardText +
            "\n\n_This request expires in 10 minutes._"
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "slacktcg_offer_trade_card",
            text: {
              type: "plain_text",
              text: "Offer Your Card"
            },
            style: "primary",
            value: tradeId
          },
          {
            type: "button",
            action_id: "slacktcg_decline_trade",
            text: {
              type: "plain_text",
              text: "Decline"
            },
            style: "danger",
            value: tradeId
          }
        ]
      }
    ]
  });
});

async function rejectUnauthorizedTradeAction(client, body) {
  await client.chat.postEphemeral({
    channel: body.channel.id,
    user: body.user.id,
    text: "❌ You are not allowed to perform that action on this trade."
  });
}

app.action("slacktcg_offer_trade_card", async ({
  ack,
  body,
  action,
  client
}) => {
  await ack();

  const trade = pendingTrades.get(action.value);

  if (!trade || Date.now() >= trade.expiresAt) {
    pendingTrades.delete(action.value);
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: "⌛ This trade request has expired."
    });
    return;
  }

  if (body.user.id !== trade.targetSlackId) {
    await rejectUnauthorizedTradeAction(client, body);
    return;
  }

  trade.channelId = body.channel.id;
  trade.messageTs = body.message.ts;

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "slacktcg_trade_offer_modal",
      private_metadata: action.value,
      title: {
        type: "plain_text",
        text: "Offer a Card"
      },
      submit: {
        type: "plain_text",
        text: "Make Offer"
      },
      close: {
        type: "plain_text",
        text: "Cancel"
      },
      blocks: [
        {
          type: "input",
          block_id: "card_input",
          label: {
            type: "plain_text",
            text: "Card to offer"
          },
          element: {
            type: "plain_text_input",
            action_id: "card_name",
            placeholder: {
              type: "plain_text",
              text: "Example: Carter Anthony-shiny"
            }
          }
        }
      ]
    }
  });
});

app.view("slacktcg_trade_offer_modal", async ({
  ack,
  body,
  view,
  client
}) => {
  const tradeId = view.private_metadata;
  const trade = pendingTrades.get(tradeId);
  const cardArg =
    view.state.values.card_input.card_name.value.trim();

  if (
    !trade ||
    Date.now() >= trade.expiresAt ||
    body.user.id !== trade?.targetSlackId
  ) {
    await ack({
      response_action: "errors",
      errors: {
        card_input: "This trade request has expired or is no longer available."
      }
    });
    return;
  }

  const matchingCards = findTradeCard(
    users[trade.targetId]?.cards || [],
    cardArg
  );

  if (matchingCards.length === 0) {
    await ack({
      response_action: "errors",
      errors: {
        card_input: `You don't own a card matching "${cardArg}".`
      }
    });
    return;
  }

  if (matchingCards.length > 1) {
    await ack({
      response_action: "errors",
      errors: {
        card_input: "That card is ambiguous. Add its modifier and generation, such as -shiny-gen1."
      }
    });
    return;
  }

  trade.targetCard = matchingCards[0].card;
  await ack();

  const offeredCard = trade.targetCard;
  let offeredCardText =
    `🃏 *${offeredCard.name}*\n` +
    `${rarityIcons[offeredCard.rarity]} ${offeredCard.rarity}\n` +
    `📅 Gen ${offeredCard.generation || 1}`;

  if (offeredCard.variant !== "Normal") {
    offeredCardText += `\n✨ Modifier: ${offeredCard.variant}`;
  }

  if (offeredCard.prismatic) {
    offeredCardText += "\n🔮 Finish: *Prismatic*";
  }

  const updateResponse = await fetch(trade.responseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      replace_original: true,
      text:
        `<@${trade.targetSlackId}> offered ${offeredCard.name} to ` +
        `<@${trade.senderSlackId}>.`,
      blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `🤝 *Trade Counteroffer*\n\n` +
            `<@${trade.senderSlackId}> offers:\n${trade.card.name} · ` +
            `${trade.card.rarity} · ${trade.card.variant}` +
            (trade.card.prismatic ? " · Prismatic" : "") +
            ` · Gen ${trade.card.generation || 1}` +
            `\n\n<@${trade.targetSlackId}> offers:\n${offeredCardText}\n\n` +
            `<@${trade.senderSlackId}>, accept this swap?`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "slacktcg_confirm_trade",
            text: {
              type: "plain_text",
              text: "Accept Swap"
            },
            style: "primary",
            value: tradeId
          },
          {
            type: "button",
            action_id: "slacktcg_decline_trade",
            text: {
              type: "plain_text",
              text: "Decline"
            },
            style: "danger",
            value: tradeId
          }
        ]
      }
      ]
    })
  });

  if (!updateResponse.ok) {
    throw new Error(
      `Slack trade message update failed with ${updateResponse.status}`
    );
  }
});

app.action("slacktcg_confirm_trade", async ({
  ack,
  body,
  action,
  client
}) => {
  await ack();

  const trade = pendingTrades.get(action.value);

  if (!trade || Date.now() >= trade.expiresAt || !trade.targetCard) {
    pendingTrades.delete(action.value);
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: "⌛ This trade request has expired."
    });
    return;
  }

  if (body.user.id !== trade.senderSlackId) {
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: "❌ Only the original sender can accept this counteroffer."
    });
    return;
  }

  const senderCardIndex =
    users[trade.senderId]?.cards.indexOf(trade.card) ?? -1;
  const targetCardIndex =
    users[trade.targetId]?.cards.indexOf(trade.targetCard) ?? -1;

  if (senderCardIndex === -1 || targetCardIndex === -1) {
    pendingTrades.delete(action.value);
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: "❌ This trade is no longer available because one of the cards is no longer owned by its offerer."
    });
    return;
  }

  const senderCard =
    users[trade.senderId].cards.splice(senderCardIndex, 1)[0];
  const targetCard =
    users[trade.targetId].cards.splice(targetCardIndex, 1)[0];
  users[trade.senderId].cards.push(targetCard);
  users[trade.targetId].cards.push(senderCard);
  saveUsers();
  pendingTrades.delete(action.value);

  const confirmationResponse = await fetch(trade.responseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      replace_original: true,
      response_type: "in_channel",
      text:
        `🤝 *Trade Complete!*\n\n` +
        `<@${trade.senderSlackId}> received *${targetCard.name}* ` +
        `(Gen ${targetCard.generation || 1}) from ` +
        `<@${trade.targetSlackId}>.\n` +
        `<@${trade.targetSlackId}> received *${senderCard.name}* ` +
        `(Gen ${senderCard.generation || 1}) from ` +
        `<@${trade.senderSlackId}>.`
    })
  });

  if (!confirmationResponse.ok) {
    throw new Error(
      `Slack trade confirmation failed with ${confirmationResponse.status}`
    );
  }
});

app.action("slacktcg_decline_trade", async ({
  ack,
  body,
  action,
  respond,
  client
}) => {
  await ack();

  const trade = pendingTrades.get(action.value);

  if (!trade || Date.now() >= trade.expiresAt) {
    pendingTrades.delete(action.value);
    await respond({
      replace_original: true,
      text: "⌛ This trade request has expired."
    });
    return;
  }

  const allowedToDecline = trade.targetCard
    ? [trade.senderSlackId, trade.targetSlackId]
    : [trade.targetSlackId];

  if (!allowedToDecline.includes(body.user.id)) {
    await rejectUnauthorizedTradeAction(client, body);
    return;
  }

  pendingTrades.delete(action.value);
  await respond({
    replace_original: true,
    text:
      `❌ <@${body.user.id}> declined the trade between ` +
      `<@${trade.senderSlackId}> and <@${trade.targetSlackId}>.`
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
