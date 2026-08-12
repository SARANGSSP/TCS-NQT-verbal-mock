// Run automatically by Vercel at deploy time (see vercel.json's buildCommand).
// Reads SUPABASE_URL / SUPABASE_ANON_KEY from the project's Environment
// Variables and writes them into a plain config.js the static site can load
// with a normal <script> tag. There's no bundler here, so this is the
// simplest way to get server-side env vars into client-side code.
const fs = require('fs');

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_ANON_KEY || '';

if (!url || !key) {
  console.warn(
    'SUPABASE_URL / SUPABASE_ANON_KEY not set — leaderboard will show ' +
    '"not configured" until they are added in Vercel Project Settings → ' +
    'Environment Variables.'
  );
}

const content =
  `window.SUPABASE_URL = ${JSON.stringify(url)};\n` +
  `window.SUPABASE_ANON_KEY = ${JSON.stringify(key)};\n`;

fs.writeFileSync('config.js', content);
console.log('Generated config.js from environment variables.');
