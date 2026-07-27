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

# How to use each command

`/slacktcg-ping` — Check if the SlackTCG bot is online and view its latency.

`/slacktcg-pack` — Open your daily pack to receive five random cards

`/slacktcg-help` — View a list of all available commands and learn how to use them.

`/slacktcg-inventory` — View your card collection.

`/slacktcg-leaderboard` — View the top pack openers, top Mythical collectors,
and the rarest card ever pulled.

`/slacktcg-trade @user <card>` — Trade one of your cards to another user.
Capitalization, spaces, and hyphens are optional, so `Jane Doe-shiny`,
`janedoe shiny`, and `JANE DOE SHINY` all work. Use `-normal`, `-gold`,
`-shiny`, or `-rainbow` when a name could otherwise be ambiguous. A unique
one-character typo is also accepted.


![alt text](https://stardance.hackclub.com/rails/active_storage/blobs/proxy/eyJfcmFpbHMiOnsiZGF0YSI6MjA1MTM0LCJwdXIiOiJibG9iX2lkIn19--36ed88260394e82bd99a9ad94690a0affbe238c8/Screenshot%202026-07-25%20161904.png)


