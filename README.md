<p align="center">
  <img src="icons/icon128.png" width="96" alt="Week Tally logo">
</p>

<h1 align="center">Week Tally</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/manifest-v3-green.svg" alt="Manifest V3">
  <img src="https://img.shields.io/badge/works%20in-Brave%20%7C%20Chrome-orange.svg" alt="Brave and Chrome">
</p>

<p align="center">
  Brave/Chrome extension that answers one question:<br>
  <b>"how many hours of <i>work</i> did I actually plan this week?"</b><br>
  Pick event names, set weekly targets, see progress — right inside Google Calendar.
</p>

---

## What it does

- **Track any event by name** — `work` matches `Work`, `Deep Work`, `Work: calls` (case-insensitive substring)
- **Weekly targets** — "30h of work, 3h of gym" → progress bars turn green when you hit them
- **Floating widget on calendar.google.com** — your week's progress always visible, collapsible to a pill
- **Refresh button in the widget corner** — pulls fresh numbers on the spot instead of waiting out the cache
- **History** — last 4 weeks + average per tracked event in the popup
- No OAuth, no API keys — reads your calendar's **secret iCal URL**. No background tracking, no analytics.

| Popup | Widget on Google Calendar |
|---|---|
| ![Popup with progress cards](screenshots/popup.png) | ![Floating widget](screenshots/widget.png) |

## Install in Brave

1. Open `brave://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** (or drag this folder onto the page)
4. Select this folder

Same steps work in Chrome at `chrome://extensions`.

## Connect your calendar (once)

1. Open [Google Calendar](https://calendar.google.com) → ⚙ **Settings**
2. Click your calendar in the left sidebar → **Integrate calendar**
3. Copy **"Secret address in iCal format"** (keep it private — it grants read access)
4. Click the extension icon → paste the URL → **Connect**
5. Add tracked events: name + optional hours/week target

Multiple calendars? Add more URLs — they're merged.

### No "Secret address"? (Google Workspace)

Some Workspace admins hide the secret iCal address (you'll only see *Public* fields under "Integrate calendar", and the public one returns 404). Click **"Use page-reading mode instead"** in the popup — the extension then reads events directly from the calendar grid as you browse calendar.google.com. No URLs, no admin needed. Trade-off: it only sees weeks you actually view, so history fills in as you browse; "this week" works immediately.

## How it works

- Fetches your secret `.ics` feed and parses it with [ical.js](https://github.com/kewisch/ical.js)
- Expands recurring events properly: cancelled instances (EXDATE) don't count, moved instances count at their new time, all-day events are skipped (they're not time blocks)
- Weeks run Monday–Sunday; "this week" includes upcoming scheduled hours
- Settings sync via `chrome.storage.sync`; the widget refreshes every 30 minutes

## Notion Calendar

If you use **Notion Calendar in the browser** (`calendar.notion.so`), the same widget appears there — fed by Google Calendar data (Notion Calendar is a view over the same calendars):

- **Follows the week you're viewing** — parsed from Notion's tab title ("8 – 14 Jun 2026 · Notion Calendar")
- **Auto-fetches missing weeks**: navigating to a week with no data makes the background worker silently open that exact week on calendar.google.com, scan it, and close the tab — the widget fills in seconds later
- Live-updates whenever any Google Calendar tab refreshes the shared cache, with a freshness label

The Notion Calendar **desktop app** can't be supported — browser extensions cannot inject into Electron apps.

## Development & testing

```bash
bun install                # or npm install
bunx playwright install chromium

bun run test               # 13 offline checks: recurrence math (cancelled/moved
                           # instances, all-day exclusion), popup render, widget render
bun run icons              # regenerate extension icons
bun run shots              # regenerate README screenshots
```

## Caveats

- Google refreshes secret iCal feeds with a few hours' lag — an event you added minutes ago may not show yet
- The widget reflects *scheduled* time, not attended time — it counts what's on the calendar
- Hours are bucketed by the week the event *starts* in (a Sun 23:00–Mon 02:00 block counts fully toward Sunday's week)

## License

[MIT](LICENSE)
