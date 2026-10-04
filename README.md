# ChannelOnly – Channel Filter & Recommendation Blocker (v2.2)

See only the channels you choose on youtube.com. With filtering off, or before you add any
channel, YouTube is completely normal.

## When filtering is on (and you've added at least one channel)
- Home shows "From your channels": latest uploads from your channels (no Shorts).
- Watch page sidebar shows more from your channels; videos from other channels send you home.
- Search and playlists show only your channels. Your channels' pages work normally.
- Hidden: left drawer, notifications bell, home chips, end screens, up-next countdown, Shorts shelves.
- Subscriptions, history, trending and Shorts pages redirect home.

## Adding channels
- Turn filtering off, open any channel or video, click "Add to ChannelOnly" (bottom-right).
- Or paste youtube.com/@name, @name, or a UC… channel ID on the settings page.

## Privacy
Your channel list stays in chrome.storage.local. The only network requests are YouTube's public
RSS feeds for your channels. No analytics, no developer servers.

## Files
manifest.json · background.js (RSS feed) · yt-probe.js (reads YouTube's page data) ·
yt-filter.js (filtering, routing, add button) · yt-filter.css · options.html/js · common.css · icons/
