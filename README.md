# Speed Write Drill

A practice tool for the TCS NQT "Rewrite Passage" round: read an AI-generated paragraph for 30 seconds, it disappears, you get 90 seconds to rewrite it from memory, then it's graded on vocabulary relevancy, sentence completeness, and content coverage.

Runs entirely client-side — no backend, no build step. Powered by [Groq](https://groq.com) for fast, free-tier passage generation and grading.

## 

## Files

* `index.html` — page structure and setup form
* `styles.css` — all styling
* `script.js` — timers, Groq API calls, scoring logic

## 

## Using it

1. Open `index.html` in a browser (or host it — see below).
2. Get a free Groq API key at [console.groq.com/keys](https://console.groq.com/keys).
3. Paste the key in, optionally set a topic, and hit **Generate passage \& start**.
4. Read for 30s, rewrite for 90s, get scored.

The key is only kept in the page's memory for that tab — it's never stored or sent anywhere except directly to Groq's API. Since this is a static site with no server, **each person needs their own free Groq key** — don't bake your key into the code before sharing it.

## 

## Notes

* The model dropdown is populated live from Groq's `/models` endpoint using whatever key you type in, so it always reflects what's currently active on your account — no hardcoded list to go stale. It defaults to `openai/gpt-oss-120b` when that's available, otherwise the first chat model returned. There's a "reload list" link next to the dropdown if you swap keys or want to refresh it.
* Each person practicing uses their own free Groq key, so the free-tier rate limits (requests/day, tokens/min) are per-person — one friend running drills doesn't eat into anyone else's quota.

