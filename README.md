# Speed Write Drill

A practice tool for two TCS NQT verbal ability rounds:

* **Rewrite Passage** — read an AI-generated paragraph for 30 seconds, it disappears, you get 90 seconds to rewrite it from memory, then it's graded on vocabulary relevancy, sentence completeness, and content coverage.
* **Fill in the Blanks** — this year's format dropped the multiple-choice options, so you get 25 contextual fill-in-the-blank sentences, one at a time (25s each), and your answers are graded by AI against the sentence's context rather than a fixed answer key.

Runs entirely client-side — no backend, no build step (besides the optional leaderboard config, see below). Powered by [Groq](https://groq.com) for fast, free-tier passage/question generation and grading.

## 

## Files

* `index.html` — page structure and setup form
* `styles.css` — all styling
* `script.js` — timers, Groq API calls, scoring logic, leaderboard
* `leaderboard-setup.sql` — one-time Supabase table/view/RLS setup
* `build-config.js` + `vercel.json` — injects Supabase env vars into a `config.js` the browser can read (see leaderboard setup below)
* `config.example.js` — template for testing the leaderboard locally without Vercel

## 

## Using it

1. Open `index.html` in a browser (or host it — see below).
2. Get a free Groq API key at [console.groq.com/keys](https://console.groq.com/keys).
3. Paste the key in, optionally set a topic, and hit **Generate passage \& start**.
4. Read for 30s, rewrite for 90s, get scored.

The key is only kept in the page's memory for that tab — it's never stored or sent anywhere except directly to Groq's API. Since this is a static site with no server, **each person needs their own free Groq key** — don't bake your key into the code before sharing it.

## 

## Setting up the leaderboard (optional)

The app works fully without this — the leaderboard panel just shows "not configured" until you connect a Supabase project. Takes about 5 minutes:

1. Create a free project at [supabase.com](https://supabase.com).
2. In your project, go to **SQL Editor → New query**, paste in the contents of `leaderboard-setup.sql` (included in this repo), and click **Run**. This creates the `scores` table, a `leaderboard_stats` view (attempts, total score, average score per person), and row-level security policies that let anyone post a score and anyone read the board, but not edit or delete other people's rows.
3. Go to **Project Settings → API**. Copy the **Project URL** and the **anon public** key.
4. In your **Vercel** project: **Settings → Environment Variables**, add:
   * `SUPABASE_URL` = your Project URL
   * `SUPABASE_ANON_KEY` = your anon public key
5. Redeploy (or just push a commit — Vercel picks the env vars up on the next build).

How this actually gets to the browser: this is a plain static site with no bundler, so a small build step (`build-config.js`, wired up via `vercel.json`) runs on every Vercel deploy and writes those two env vars into a `config.js` file that `index.html` loads before `script.js`. Nothing to paste into the code by hand, and nothing secret ends up committed to the repo — the anon key is meant to be public/client-side anyway; the RLS policies from step 2 are what actually control what it's allowed to do.

**Testing locally** (without deploying to Vercel): copy `config.example.js` to `config.js` and fill in your own values. `config.js` is gitignored so it won't get committed.

It's an honor-system board (no login) — anyone can type any name the first time they post a score, and it's remembered in their browser after that for automatic future posts. That's fine for a friend group, not something to rely on for anything competitive/official.

Currently the leaderboard only tracks **Rewrite Passage** scores — Fill in the Blanks results aren't posted to it.

## 

## Notes

* The model dropdown is populated live from Groq's `/models` endpoint using whatever key you type in, so it always reflects what's currently active on your account — no hardcoded list to go stale. It defaults to `openai/gpt-oss-120b` when that's available, otherwise the first chat model returned. There's a "reload list" link next to the dropdown if you swap keys or want to refresh it.
* Each person practicing uses their own free Groq key, so the free-tier rate limits (requests/day, tokens/min) are per-person — one friend running drills doesn't eat into anyone else's quota.

