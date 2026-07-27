SlackTCG
========
A trading card game in Slack where you interact with a bot to open packs and see your collection. You can trade with others, collect cards with rare modifiers, and form an extensive collection!

Card Rarities: Common 60%, Rare 25%, Epic 10%, Legendary 4%, Mythical 1%

Modifier Rarities: Normal 96%, Gold 3%, Shiny 0.9%, Rainbow 0.1%

Each card is a non-bot member of the Slack channel where the pack is opened,
using that member's first and last name.

# How to use each command

`/slacktcg-ping` — Check if the SlackTCG bot is online and view its latency.

`/slacktcg-pack` — Open your daily pack to receive five random cards

`/slacktcg-help` — View a list of all available commands and learn how to use them.

`/slacktcg-inventory` — View your card collection.

`/slacktcg-trade @user <card>` — Trade one of your cards to another user by entering their username and the member's first and last name, including the modifier if the card has one (for a shiny Jane Doe card, `Jane Doe-shiny`).


![alt text](https://stardance.hackclub.com/rails/active_storage/blobs/proxy/eyJfcmFpbHMiOnsiZGF0YSI6MjA1MTM0LCJwdXIiOiJibG9iX2lkIn19--36ed88260394e82bd99a9ad94690a0affbe238c8/Screenshot%202026-07-25%20161904.png)

## OAuth installation and Socket Mode

SlackTCG receives commands through Socket Mode and serves a public OAuth install
URL so it can be installed in multiple workspaces.

1. In **Basic Information > App-Level Tokens**, create a token with the
   `connections:write` scope and copy the resulting `xapp-...` token.
2. In **Socket Mode**, enable Socket Mode.
3. Copy `.env.example` to `.env` and set the app token, OAuth client
   credentials, state secret, and public server URL.
4. Under **OAuth & Permissions**, add this redirect URL:
   `https://your-server.example/slack/oauth_redirect`.
5. Ensure `SLACK_INSTALLATION_STORE_PATH` points to persistent private storage,
   then run:

   ```sh
   npm start
   ```

The install URL is `https://your-server.example/slack/install`. It requests the
`commands`, `users:read`, `channels:read`, `groups:read`, `im:read`, and
`mpim:read` bot scopes. Slash commands do not need Request URLs while Socket
Mode is enabled.
