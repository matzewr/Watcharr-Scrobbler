# Watcharr Scrobbler (Firefox + Chrome)

A browser extension (Firefox and Chrome) that works like the
[Universal Trakt Scrobbler](https://github.com/trakt-tools/universal-trakt-scrobbler) –
but **only for your own, self-hosted [Watcharr](https://github.com/sbondCo/Watcharr)-instance**.

**Current status:** **Netflix** and **Amazon Prime Video** are integrated as services.

<br>

## What it does

- Automatically detects what is currently playing on Netflix or Amazon Prime
  Video (movie or series, including season & episode).
- Searches for the title via your Watcharr instance (TMDB search) and adds it to your watchlist.
- While you are watching, the entry remains **WATCHING**.
- Once a movie or episode reaches the configurable threshold,
  it is marked as watched in Watcharr (**FINISHED**).
- For series, the individual **episode** is marked as watched – Watcharr
  automatically updates the series status (“Automate Show Statuses”).
- **History page:** Import your previous viewing history (Netflix or Amazon
  Prime Video) in a controlled way – with comparison, match correction, and
  selective import (movies as watched series episodes individually).

<br>

## Installation

> **Note regarding the `<all_urls>` permission:** Since your Watcharr instance can use any
> self-hosted URL, the extension requires a very broad
> host permission. This is intentional.

<br>

## Setup

1. Open the extension settings (Popup → **Settings**).
2. Enter the **Watcharr URL** (base URL, e.g. `https://watcharr.example.com`,
   without `/api`).
3. Enter your username & password and click **“Save & Connect”**.
   - The password is **not stored**. It is only used for logging in;
     only the JWT token is stored.
   - If your Watcharr server has a **Jellyfin** or **Plex** host configured,
     those login methods are offered automatically in the settings (the add-on
     asks the server via `GET /api/auth/available`). Jellyfin uses username &
     password, Plex opens a plex.tv popup for the OAuth login.
4. Optional: Adjust the scrobbling threshold (e.g. 90% if only the ending should count).
5. Open Netflix or Amazon Prime Video and get started 🍿

You can see the status and progress at any time in the **Popup**.

<br>

## History import

The **History page** (Popup → **“History”**) gives you full
Control similar to Universal Trakt Scrobbler: a **side-by-side comparison** of each
watched title (Netflix or Amazon Prime Video – the service is selected
automatically from the open tab) with the automatically found **Watcharr match**,
including **match correction** and **selective import**. No separate
synchronization is required – the page loads the history directly from the open
service tab.

<br>

## Troubleshooting

> **Note:** The Watcharr API can currently only import exact viewing dates for
> movies/series (not per episode). The history is therefore transferred correctly
> in terms of what was watched.

<br>

## AI Disclosure

> **AI-generated:** This project was created entirely by AI. I haven’t yet had time to review the code in detail myself. A thorough personal review is planned. However, the extension currently appears to be working without any errors.
