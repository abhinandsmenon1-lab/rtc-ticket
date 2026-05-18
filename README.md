# RTC Ticket Bot

A clean JavaScript Discord ticket bot with:
- `/panelcreate` setup wizard for admins
- Panel button: 🎟️ Open Ticket
- Claim / Unclaim / Close buttons
- `/claim`, `/unclaim`, `/close`, `/add`, `/transfer`
- Prefix commands: `*claim`, `*unclaim`, `*close`, `*add`, `*transfer`
- Transcript HTML file sent to transcript channel
- Ticket closed embed with transcript attachment

## Setup

1. Install Node.js 18+
2. Rename `.env.example` to `.env`
3. Put your bot token and client ID inside `.env`
4. Run:

```bash
npm install
npm run deploy
npm start
```

## Bot permissions needed

Invite bot with:
- Administrator OR
- Manage Channels
- Manage Roles
- Send Messages
- Embed Links
- Attach Files
- Read Message History
- Use Slash Commands

## Important

This is not Ticket Tool/Ticket V2's exact code. It is a clean custom bot made to behave like your screenshots.
