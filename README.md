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

## OAuth and deployment

SlackTCG uses Slack OAuth v2 and stores a separate installation for every
workspace. Copy `.env.example` to `.env` and provide:

- `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, and `SLACK_CLIENT_SECRET` from the
  Slack app's Basic Information page.
- `SLACK_STATE_SECRET`, a long random secret used to protect the OAuth flow.
- `PUBLIC_BASE_URL`, the HTTPS origin where this service is deployed, without a
  trailing slash.

The production OAuth endpoints on Hack Club Nest are:

- Install URL: `https://rachat.hackclub.app/slack/install`
- Redirect URL: `https://rachat.hackclub.app/slack/oauth_redirect`
- Slack request URL: `https://rachat.hackclub.app/slack/events`

Add the Redirect URL under **OAuth & Permissions** in the Slack app settings.
Set every slash command's Request URL to the Slack request URL. The production
value of `SLACK_INSTALLATION_STORE_PATH` must point at persistent, private
storage; OAuth tokens are written there at install time and the directory is
excluded from Git.

Do not set `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, or incoming webhook URLs.
Each workspace must authorize the app through the Install URL.
