SlackTCG
========
A trading card game in Slack where you interact with a bot to open packs and see your collection. You can trade with others, collect cards with rare modifiers, and form an extensive collection!

Card Rarities: Common 60%, Rare 25%, Epic 10%, Legendary 4%, Mythical 1%

Modifier Rarities: Normal 96%, Gold 3%, Shiny 0.9%, Rainbow 0.1%

Each card is a non-bot member of the Slack channel where the pack is opened,
using that member's first and last name.

Every hour has a 10% chance of Lucky Hour. The event is announced in `#gaming`,
while non-Common rarity weights and Gold, Shiny, and Rainbow odds are tripled
in every channel.

Every pack has a 5% chance to become a **GOD PACK**. All five cards feature the
same random channel member, are Rare or higher, and have the God modifier.
God Packs are the only source of Prismatic cards, with a 1% chance per card.
Every pulled card displays its combined odds. The leaderboard uses the same
probability.

Cards are stamped by generation based on the year they were pulled: cards from
2026 are Gen 1, cards from 2027 are Gen 2, and each following year increments
the generation.

# How to use each command

`/slacktcg-ping` — Check if the SlackTCG bot is online and view its latency.

`/slacktcg-pack` — Open your daily pack to receive five random cards

`/slacktcg-help` — View a list of all available commands and learn how to use them.

`/slacktcg-inventory [@user]` — View your or another player's five rarest
unique cards.

`/slacktcg-leaderboard` — View the top pack openers, top Mythical collectors,
and the rarest card ever pulled.

`/slacktcg-odds` — View all standard and special-event odds, compare your
Rare-or-better pulls with the statistically expected total, and see the three
luckiest tracked players.

`/slacktcg-auction <card>` — Start a public five-minute auction in the current
channel. Other members offer one card each, may replace their offer, and the
rarest valid offer wins the auctioned card.

`/slacktcg merge <rarity>` — Randomly consume 10 owned cards of one rarity,
excluding all copies represented among your five rarest unique cards, and pull
a new card of the next rarity. The member is selected from the current
channel and the modifier is rolled again. God and Prismatic remain exclusive
to God Packs. Mythical cards cannot be merged upward.

`/slacktcg-trade @user <card>` — Trade one of your cards to another user.
Using only a name selects the rarest matching card. Add rarity, modifier,
finish, and generation with hyphens in any order, such as
`Jane Doe-mythical-prismatic-god-gen1`. A unique one-character typo is also
accepted. The recipient
offers one of their own cards, then the original sender accepts or declines the
final swap.


![alt text](https://stardance.hackclub.com/rails/active_storage/blobs/proxy/eyJfcmFpbHMiOnsiZGF0YSI6MjA1MTM0LCJwdXIiOiJibG9iX2lkIn19--36ed88260394e82bd99a9ad94690a0affbe238c8/Screenshot%202026-07-25%20161904.png)


