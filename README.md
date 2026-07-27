SlackTCG
========
A trading card game in Slack where you interact with a bot to open packs and see your collection. You can trade with others, collect cards with rare modifiers, and form an extensive collection!

Card Rarities: Common 60%, Rare 25%, Epic 10%, Legendary 4%, Mythical 1%

Modifier Rarities: Normal 96%, Gold 3%, Shiny 0.9%, Rainbow 0.1%

Rarest cards in the game: Rainbow Ethereal Dragon, Rainbow God Slayer, or Rainbow Cosmic Entity (Expect 1 of these in 20,000 packs).

# How to use each command

`/slacktcg-ping` — Check if the SlackTCG bot is online and view its latency.

`/slacktcg-pack` — Open your daily pack to receive five random cards

`/slacktcg-help` — View a list of all available commands and learn how to use them.

`/slacktcg-inventory` — View your card collection.

`/slacktcg-trade @user <card>` — Trade one of your cards to another user by entering their username and the card name, including the modifier if the card has one (for a shiny rock golem, `rock golem-shiny`).


![alt text](https://stardance.hackclub.com/rails/active_storage/blobs/proxy/eyJfcmFpbHMiOnsiZGF0YSI6MjA1MTM0LCJwdXIiOiJibG9iX2lkIn19--36ed88260394e82bd99a9ad94690a0affbe238c8/Screenshot%202026-07-25%20161904.png)

## Socket Mode setup

SlackTCG uses Socket Mode, so it does not need a public request URL.

1. In **OAuth & Permissions**, add the `commands` bot scope and install or
   reinstall the app to the workspace.
2. Copy the **Bot User OAuth Token** (`xoxb-...`).
3. In **Basic Information > App-Level Tokens**, create a token with the
   `connections:write` scope and copy the resulting `xapp-...` token.
4. In **Socket Mode**, enable Socket Mode.
5. Copy `.env.example` to `.env`, set `SLACK_BOT_TOKEN` and
   `SLACK_APP_TOKEN`, then run:

   ```sh
   npm start
   ```

Slash commands do not need Request URLs while Socket Mode is enabled.
