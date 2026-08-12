-- Run this once in your Supabase project's SQL Editor
-- (Dashboard → SQL Editor → New query → paste → Run)

-- 1. The scores table -------------------------------------------------
create table if not exists public.scores (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 24),
  topic text not null,
  score numeric not null check (score >= 0 and score <= 10),
  vocabulary_relevancy numeric check (vocabulary_relevancy between 0 and 10),
  sentence_completeness numeric check (sentence_completeness between 0 and 10),
  content_coverage numeric check (content_coverage between 0 and 10),
  structure numeric check (structure between 0 and 10),
  words_written integer check (words_written >= 0),
  created_at timestamptz not null default now()
);

-- 2. Row-level security -------------------------------------------------
-- No login system, so this is an honor-system board: anyone can insert
-- a score and anyone can read the board. RLS is still on so nobody can
-- UPDATE or DELETE other people's rows from the client.
alter table public.scores enable row level security;

create policy "public can insert scores"
  on public.scores for insert
  to anon
  with check (true);

create policy "public can read scores"
  on public.scores for select
  to anon
  using (true);

-- 3. Leaderboard view: attempts, total score, average score per person ---
drop view if exists public.leaderboard_best;

create or replace view public.leaderboard_stats as
select
  name,
  count(*)::int as attempts,
  round(sum(score)::numeric, 1) as total_score,
  round(avg(score)::numeric, 2) as avg_score
from public.scores
group by name;

grant select on public.leaderboard_stats to anon;
