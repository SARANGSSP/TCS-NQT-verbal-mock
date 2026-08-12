(function () {
  const READ_SECONDS = 30;
  const WRITE_SECONDS = 90;
  const RING_CIRC = 2 * Math.PI * 32;
  const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

  // ---- Supabase leaderboard config ----
  // These come from config.js, which Vercel generates at build time from
  // your project's SUPABASE_URL / SUPABASE_ANON_KEY environment variables
  // (see build-config.js + vercel.json). Nothing to edit here.
  const SUPABASE_URL = window.SUPABASE_URL || '';
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';
  const LS_PLAYER_NAME = 'swd_player_name';

  let supabase = null;
  try {
    if (window.supabase && SUPABASE_URL.startsWith('http') && SUPABASE_ANON_KEY) {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
  } catch (e) { supabase = null; }

  const PREFERRED_DEFAULT_MODEL = 'openai/gpt-oss-120b';
  // Model ids that exist on Groq but aren't plain chat models (audio, moderation, TTS, etc.)
  // — these show up in /models but would just error out if picked here.
  const MODEL_ID_EXCLUDE = /whisper|tts|guard|orpheus|prompt-guard/i;

  // High-frequency TCS NQT "Rewrite Passage" topic themes, based on commonly reported
  // patterns from the verbal ability section.
  const NQT_TOPICS = [
    'Workplace communication and etiquette',
    'Time management and productivity',
    'Teamwork and collaboration',
    'Leadership and decision making',
    'Artificial intelligence and automation',
    'Cybersecurity and data privacy',
    'Remote work and hybrid workplaces',
    'Environmental sustainability and climate change',
    'Renewable and clean energy',
    'Digital transformation in business',
    'E-commerce and online retail',
    'Social media and its impact on society',
    'Financial literacy and personal finance',
    'Entrepreneurship and startups',
    'Higher education and skill development',
    'Health, wellness and work-life balance',
    'Diversity and inclusion at the workplace',
    'Customer service and client relations',
    'Globalisation and the world economy',
    'Innovation and emerging technology trends',
  ];
  const RANDOM_VALUE = '__random__';
  const LS_USED_PASSAGES = 'swd_used_passages';   // recently generated passages (dedupe)
  const LS_USED_TOPICS = 'swd_used_topics';       // recently picked random topics
  const HISTORY_CAP = 25;
  const TOPIC_HISTORY_CAP = Math.max(3, Math.ceil(NQT_TOPICS.length * 0.6));

  function loadJSONList(key) {
    try {
      const raw = localStorage.getItem(key);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveJSONList(key, arr, cap) {
    try { localStorage.setItem(key, JSON.stringify(arr.slice(-cap))); } catch (e) { /* storage unavailable, ignore */ }
  }
  function normalizeForCompare(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/).slice(0, 20).join(' ');
  }
  function pickRandomTopic() {
    const usedTopics = loadJSONList(LS_USED_TOPICS);
    let pool = NQT_TOPICS.filter(t => !usedTopics.includes(t));
    if (!pool.length) pool = NQT_TOPICS.slice(); // exhausted — reset the cycle
    const topic = pool[Math.floor(Math.random() * pool.length)];
    const updated = usedTopics.filter(t => t !== topic);
    updated.push(topic);
    saveJSONList(LS_USED_TOPICS, updated, TOPIC_HISTORY_CAP);
    return topic;
  }

  const stages = {
    setup: document.getElementById('stage-setup'),
    reading: document.getElementById('stage-reading'),
    writing: document.getElementById('stage-writing'),
    scoring: document.getElementById('stage-scoring'),
    result: document.getElementById('stage-result'),
    fitb: document.getElementById('stage-fitb'),
    fitbResult: document.getElementById('stage-fitb-result'),
  };
  function showStage(name) {
    Object.values(stages).forEach(s => s.classList.remove('active'));
    stages[name].classList.add('active');
    if (name === 'reading') {
      document.body.classList.add('reading-active');
    } else {
      document.body.classList.remove('reading-active');
    }
    const hintsBox = document.getElementById('hintsBox');
    if (name === 'writing') {
      hintsBox.classList.add('visible');
    } else {
      hintsBox.classList.remove('visible');
    }
  }

  let originalPassage = '';
  let currentTopic = '';
  let readInterval = null, writeInterval = null;

  function setError(el, msg) {
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  // ---- fetch the current chat-capable model list for this key ----
  async function fetchModels(apiKey) {
    const res = await fetch(GROQ_MODELS_URL, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.error?.message || ''; } catch (e) { }
      throw new Error(`Could not load model list (${res.status}). ${detail}`);
    }
    const data = await res.json();
    const ids = (data.data || [])
      .map(m => m.id)
      .filter(id => id && !MODEL_ID_EXCLUDE.test(id))
      .sort();
    if (!ids.length) throw new Error('No chat models available on this key.');
    return ids;
  }

  const modelSelect = document.getElementById('model');
  const apiKeyInput = document.getElementById('apiKey');
  const reloadModelsLink = document.getElementById('reloadModels');
  let modelsLoadedForKey = '';

  async function loadModelsIntoSelect() {
    const apiKey = apiKeyInput.value.trim();
    setError(document.getElementById('setupError'), '');
    if (!apiKey) {
      modelSelect.disabled = true;
      modelSelect.innerHTML = '<option value="">Enter API key, then load models →</option>';
      modelsLoadedForKey = '';
      return;
    }
    if (apiKey === modelsLoadedForKey) return; // already loaded for this exact key

    modelSelect.disabled = true;
    modelSelect.innerHTML = '<option value="">Loading models…</option>';
    try {
      const ids = await fetchModels(apiKey);
      modelSelect.innerHTML = '';
      ids.forEach(id => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        modelSelect.appendChild(opt);
      });
      if (ids.includes(PREFERRED_DEFAULT_MODEL)) {
        modelSelect.value = PREFERRED_DEFAULT_MODEL;
      }
      modelSelect.disabled = false;
      modelsLoadedForKey = apiKey;
    } catch (err) {
      modelSelect.innerHTML = '<option value="">Could not load models</option>';
      modelSelect.disabled = true;
      modelsLoadedForKey = '';
      setError(document.getElementById('setupError'), err.message);
    }
  }

  apiKeyInput.addEventListener('blur', loadModelsIntoSelect);
  reloadModelsLink.addEventListener('click', () => {
    modelsLoadedForKey = ''; // force refetch even if key unchanged
    loadModelsIntoSelect();
  });

  // ---- Groq chat completions call (OpenAI-compatible schema) ----
  async function callGroq(apiKey, model, prompt) {
    const res = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.error?.message || ''; } catch (e) { }
      throw new Error(`Groq request failed (${res.status}). ${detail}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Empty response from Groq.');
    return text.trim();
  }

  function stripFences(text) {
    return text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  }

  // ---- ring helpers ----
  function initRing(progressEl) {
    progressEl.setAttribute('stroke-dasharray', RING_CIRC);
    progressEl.setAttribute('stroke-dashoffset', 0);
  }
  function updateRing(progressEl, numEl, wrapEl, remaining, total) {
    const frac = remaining / total;
    progressEl.setAttribute('stroke-dashoffset', RING_CIRC * (1 - frac));
    numEl.textContent = remaining;
    wrapEl.classList.remove('warn', 'critical');
    if (remaining <= Math.ceil(total * 0.15)) wrapEl.classList.add('critical');
    else if (remaining <= Math.ceil(total * 0.4)) wrapEl.classList.add('warn');
  }

  initRing(document.getElementById('readRingProgress'));
  initRing(document.getElementById('writeRingProgress'));
  initRing(document.getElementById('fitbRingProgress'));

  // ---- populate topic dropdown ----
  const topicSelect = document.getElementById('topic');
  (function populateTopics() {
    const randomOpt = document.createElement('option');
    randomOpt.value = RANDOM_VALUE;
    randomOpt.textContent = '🎲 Random (recommended)';
    topicSelect.appendChild(randomOpt);
    NQT_TOPICS.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      topicSelect.appendChild(opt);
    });
    topicSelect.value = RANDOM_VALUE;
  })();

  // ---- mode switch (Rewrite Passage vs Fill in the Blanks) ----
  let currentMode = 'rewrite';
  const modeTabRewrite = document.getElementById('modeTabRewrite');
  const modeTabFitb = document.getElementById('modeTabFitb');
  function setMode(mode) {
    currentMode = mode;
    modeTabRewrite.classList.toggle('active', mode === 'rewrite');
    modeTabFitb.classList.toggle('active', mode === 'fitb');
    btnStart.textContent = mode === 'fitb' ? 'Generate 25 blanks & start' : 'Generate passage & start';
    setError(document.getElementById('setupError'), '');
  }
  modeTabRewrite.addEventListener('click', () => setMode('rewrite'));
  modeTabFitb.addEventListener('click', () => setMode('fitb'));

  // ---- flow ----
  const btnStart = document.getElementById('btnStart');
  btnStart.addEventListener('click', () => {
    if (currentMode === 'fitb') startFitbDrill();
    else startDrill();
  });

  function buildGenPrompt(topic, avoidList) {
    const avoidBlock = avoidList.length
      ? `\n\nDo NOT reuse any of these passages you (or another request) already generated for this reader — write something with a genuinely different angle, examples, and opening sentence, even if the topic is the same:\n${avoidList.map((p, i) => `${i + 1}. """${p}"""`).join('\n')}`
      : '';
    return `You are creating practice material for the TCS NQT exam's "Rewrite Passage" round. Write a single self-contained paragraph of 100-130 words on the topic of "${topic}". Make it moderately formal, information-dense with 4-6 distinct factual or logical points a reader would need to recall, written in clear complete sentences with a brief opening/context sentence, a body of key points, and a short concluding sentence that wraps up the idea. Also remember that the reader only has 30 seconds to read the complete paragraph so it caanot be longer than 5-6 lines. Output ONLY the paragraph text — no title, no quotes, no preamble, no markdown.${avoidBlock}`;
  }

  async function generateUniquePassage(apiKey, model, topic) {
    const used = loadJSONList(LS_USED_PASSAGES);
    const usedNormalized = used.map(normalizeForCompare);
    const avoidList = used.slice(-5); // keep the prompt short — last 5 is plenty of signal

    const MAX_ATTEMPTS = 3;
    let passage = '';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      passage = await callGroq(apiKey, model, buildGenPrompt(topic, avoidList));
      if (!usedNormalized.includes(normalizeForCompare(passage))) break;
      // duplicate of something this user already saw — try again
    }

    used.push(passage);
    saveJSONList(LS_USED_PASSAGES, used, HISTORY_CAP);
    return passage;
  }

  async function startDrill() {
    const apiKey = document.getElementById('apiKey').value.trim();
    const topicValue = document.getElementById('topic').value;
    const model = document.getElementById('model').value;
    setError(document.getElementById('setupError'), '');

    if (!apiKey) {
      setError(document.getElementById('setupError'), 'Enter your Groq API key first.');
      return;
    }
    if (!model) {
      setError(document.getElementById('setupError'), 'Load and pick a model first (click "reload list" if it hasn\'t loaded).');
      return;
    }

    const topic = (!topicValue || topicValue === RANDOM_VALUE) ? pickRandomTopic() : topicValue;
    currentTopic = topic;

    btnStart.disabled = true;
    btnStart.textContent = 'Generating…';

    showStage('reading');
    document.getElementById('passageBox').classList.remove('blurred');
    document.getElementById('passageBox').innerHTML = '<span class="loading-line">Generating your passage…</span>';

    try {
      const passage = await generateUniquePassage(apiKey, model, topic);
      originalPassage = passage;
      document.getElementById('passageBox').textContent = passage;
      runReadTimer();
    } catch (err) {
      showStage('setup');
      setError(document.getElementById('setupError'), err.message);
      btnStart.disabled = false;
      btnStart.textContent = 'Generate passage & start';
    }
  }

  function runReadTimer() {
    let remaining = READ_SECONDS;
    const progressEl = document.getElementById('readRingProgress');
    const numEl = document.getElementById('readRingNum');
    const wrapEl = document.getElementById('readTimerWrap');
    updateRing(progressEl, numEl, wrapEl, remaining, READ_SECONDS);

    readInterval = setInterval(() => {
      remaining--;
      updateRing(progressEl, numEl, wrapEl, Math.max(remaining, 0), READ_SECONDS);
      if (remaining <= 0) {
        clearInterval(readInterval);
        beginWriting();
      }
    }, 1000);
  }

  function extractKeywords(passage) {
    const words = passage.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'']/g, "").split(/\s+/);
    const stopwords = new Set([
      'the', 'and', 'that', 'with', 'from', 'this', 'these', 'their', 'there', 'about',
      'which', 'would', 'should', 'could', 'their', 'they', 'them', 'will', 'have', 'has',
      'had', 'been', 'were', 'was', 'are', 'context', 'passage', 'candidate', 'original',
      'topic', 'first', 'second', 'third', 'after', 'before', 'between', 'under', 'through',
      'during', 'without', 'because', 'although', 'though', 'since', 'until', 'while'
    ]);
    const candidates = [];
    const seen = new Set();
    words.forEach(w => {
      const clean = w.toLowerCase().trim();
      if (clean.length >= 6 && !stopwords.has(clean) && !seen.has(clean) && !/^\d+$/.test(clean)) {
        seen.add(clean);
        candidates.push(w);
      }
    });
    candidates.sort((a, b) => b.length - a.length);
    while (candidates.length < 3) {
      candidates.push('NQT Drill');
    }
    return candidates.slice(0, 3);
  }

  function beginWriting() {
    showStage('writing');
    const ta = document.getElementById('rewriteInput');
    ta.value = '';
    document.getElementById('wordCount').textContent = '0 words';
    ta.focus();
    ta.addEventListener('input', updateWordCount);

    const hintsBox = document.getElementById('hintsBox');
    const hint1 = document.getElementById('hint1');
    const hint2 = document.getElementById('hint2');
    const hint3 = document.getElementById('hint3');

    // Reset hints UI
    hintsBox.classList.remove('visible');
    hint1.classList.remove('reveal');
    hint2.classList.remove('reveal');
    hint3.classList.remove('reveal');
    hint1.textContent = '';
    hint2.textContent = '';
    hint3.textContent = '';

    const keywords = extractKeywords(originalPassage);

    let remaining = WRITE_SECONDS;
    const progressEl = document.getElementById('writeRingProgress');
    const numEl = document.getElementById('writeRingNum');
    const wrapEl = document.getElementById('writeTimerWrap');
    updateRing(progressEl, numEl, wrapEl, remaining, WRITE_SECONDS);

    writeInterval = setInterval(() => {
      remaining--;
      updateRing(progressEl, numEl, wrapEl, Math.max(remaining, 0), WRITE_SECONDS);

      // Reveal keywords based on remaining time (total: 90s)
      // 30s elapsed -> remaining = 60s
      if (remaining === 60) {
        hintsBox.classList.add('visible');
        hint1.textContent = keywords[0];
        hint1.classList.add('reveal');
      }
      // 45s elapsed -> remaining = 45s
      if (remaining === 45) {
        hint2.textContent = keywords[1];
        hint2.classList.add('reveal');
      }
      // 60s elapsed -> remaining = 30s
      if (remaining === 30) {
        hint3.textContent = keywords[2];
        hint3.classList.add('reveal');
      }

      if (remaining <= 0) {
        clearInterval(writeInterval);
        finishWriting();
      }
    }, 1000);
  }

  function updateWordCount() {
    const val = document.getElementById('rewriteInput').value.trim();
    const count = val ? val.split(/\s+/).length : 0;
    document.getElementById('wordCount').textContent = `${count} word${count === 1 ? '' : 's'}`;
  }

  document.getElementById('btnGiveUp').addEventListener('click', () => {
    clearInterval(writeInterval);
    finishWriting();
  });

  async function finishWriting() {
    const rewrite = document.getElementById('rewriteInput').value.trim();
    showStage('scoring');
    setError(document.getElementById('runError'), '');

    const apiKey = document.getElementById('apiKey').value.trim();
    const model = document.getElementById('model').value;

    const scorePrompt = `You are grading an exam candidate's attempt at TCS NQT's "Rewrite Passage" round: they read a paragraph for 30 seconds, then had 90 seconds to reproduce it from memory in their own words.

ORIGINAL PASSAGE:
"""${originalPassage}"""

CANDIDATE'S REWRITE:
"""${rewrite || '(the candidate submitted nothing)'}"""

Score the rewrite strictly on:
1. vocabulary_relevancy (1-10): how well the candidate's word choices match or relate to the original's key vocabulary and terminology
2. sentence_completeness (1-10): are sentences grammatically complete and well-formed, not fragments
3. content_coverage (1-10): how many of the original's key points or facts were retained
4. structure (1-10): does the rewrite have a clear opening/context sentence, a body that lays out the key points in a logical order, and a short concluding sentence — versus just a loose dump of half-related facts
5. score (1-10): holistic overall score a TCS grader would likely give, factoring in all of the above

Respond with ONLY valid JSON, no markdown fences, no commentary, in this exact shape:
{"score": <number>, "vocabulary_relevancy": <number>, "sentence_completeness": <number>, "content_coverage": <number>, "structure": <number>, "feedback": "<2-3 sentence constructive feedback, direct and specific>", "missed_points": ["<short phrase>", "<short phrase>"]}`;

    try {
      const raw = await callGroq(apiKey, model, scorePrompt);
      const json = JSON.parse(stripFences(raw));
      renderResult(json, rewrite);
    } catch (err) {
      showStage('result');
      document.getElementById('scoreNum').textContent = '–';
      setError(document.getElementById('runError'), 'Could not grade this attempt: ' + err.message);
    }
  }

  function pct(v) { return Math.max(0, Math.min(100, (v / 10) * 100)); }

  function renderResult(json, rewrite) {
    showStage('result');
    setError(document.getElementById('runError'), '');

    document.getElementById('scoreNum').textContent = json.score ?? '–';
    document.getElementById('mVocab').textContent = json.vocabulary_relevancy ?? '–';
    document.getElementById('mSentence').textContent = json.sentence_completeness ?? '–';
    document.getElementById('mCoverage').textContent = json.content_coverage ?? '–';
    document.getElementById('mStructure').textContent = json.structure ?? '–';
    document.getElementById('barVocab').style.width = pct(json.vocabulary_relevancy || 0) + '%';
    document.getElementById('barSentence').style.width = pct(json.sentence_completeness || 0) + '%';
    document.getElementById('barCoverage').style.width = pct(json.content_coverage || 0) + '%';
    document.getElementById('barStructure').style.width = pct(json.structure || 0) + '%';

    const wc = rewrite ? rewrite.trim().split(/\s+/).filter(Boolean).length : 0;
    document.getElementById('mWords').textContent = wc;

    document.getElementById('feedbackText').textContent = json.feedback || 'No feedback returned.';
    const missedList = document.getElementById('missedList');
    missedList.innerHTML = '';
    (json.missed_points || []).forEach(p => {
      const li = document.createElement('li');
      li.textContent = p;
      missedList.appendChild(li);
    });

    document.getElementById('origText').textContent = originalPassage;
    document.getElementById('yourText').textContent = rewrite || '(nothing submitted)';

    lastResultForSubmit = {
      score: json.score,
      vocabulary_relevancy: json.vocabulary_relevancy,
      sentence_completeness: json.sentence_completeness,
      content_coverage: json.content_coverage,
      structure: json.structure,
      wordsWritten: wc,
    };
    currentAttemptPosted = false;
    loadLeaderboard();
    if (localStorage.getItem(LS_PLAYER_NAME)) {
      submitScore(true);
    } else {
      setLbStatus('Enter your name below to join the leaderboard — future scores post automatically.');
    }
  }

  // ---- leaderboard ----
  const playerNameInput = document.getElementById('playerName');
  const btnSubmitScore = document.getElementById('btnSubmitScore');
  const lbStatus = document.getElementById('lbStatus');
  const lbLists = document.querySelectorAll('.lb-list');

  playerNameInput.value = localStorage.getItem(LS_PLAYER_NAME) || '';

  function setLbStatus(msg, cls) {
    lbStatus.textContent = msg;
    lbStatus.className = 'lb-status' + (cls ? ' ' + cls : '');
  }

  function renderLeaderboardHtml(html) {
    lbLists.forEach(el => { el.innerHTML = html; });
  }

  async function loadLeaderboard() {
    if (!supabase) {
      renderLeaderboardHtml('<div class="lb-empty">Leaderboard not configured yet.</div>');
      return;
    }
    renderLeaderboardHtml('<div class="lb-empty">Loading leaderboard…</div>');
    try {
      const { data, error } = await supabase
        .from('leaderboard_stats')
        .select('name, attempts, total_score, avg_score')
        .order('avg_score', { ascending: false })
        .limit(10);
      if (error) throw error;
      if (!data || !data.length) {
        renderLeaderboardHtml('<div class="lb-empty">No scores posted yet — be the first.</div>');
        return;
      }
      const html = data.map((row, i) => `
        <div class="lb-row">
          <div class="lb-row-main">
            <span class="lb-rank">#${i + 1}</span>
            <span class="lb-name">${escapeHtml(row.name)}</span>
            <span class="lb-score">${Number(row.avg_score).toFixed(2)} <small>avg</small></span>
          </div>
          <div class="lb-sub">${row.attempts} attempt${row.attempts === 1 ? '' : 's'} · total ${Number(row.total_score).toFixed(1)}</div>
        </div>
      `).join('');
      renderLeaderboardHtml(html);
    } catch (err) {
      renderLeaderboardHtml('<div class="lb-empty">Could not load leaderboard.</div>');
    }
  }

  loadLeaderboard();

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  let lastResultForSubmit = null;
  let currentAttemptPosted = false;

  async function submitScore(auto) {
    const typedName = playerNameInput.value.trim();
    const name = typedName || localStorage.getItem(LS_PLAYER_NAME) || '';

    if (!name) {
      if (!auto) setLbStatus('Enter a name first, then post.', 'err');
      else setLbStatus('Enter your name below to join the leaderboard — future scores post automatically.');
      return;
    }
    if (!supabase) {
      if (!auto) setLbStatus('Leaderboard not configured yet.', 'err');
      return;
    }
    if (!lastResultForSubmit || currentAttemptPosted) {
      return;
    }

    localStorage.setItem(LS_PLAYER_NAME, name);
    playerNameInput.value = name;
    btnSubmitScore.disabled = true;
    setLbStatus(auto ? 'Posting your score…' : 'Posting…');
    try {
      const { error } = await supabase.from('scores').insert({
        name: name,
        topic: currentTopic || 'general',
        score: lastResultForSubmit.score ?? 0,
        vocabulary_relevancy: lastResultForSubmit.vocabulary_relevancy ?? null,
        sentence_completeness: lastResultForSubmit.sentence_completeness ?? null,
        content_coverage: lastResultForSubmit.content_coverage ?? null,
        structure: lastResultForSubmit.structure ?? null,
        words_written: lastResultForSubmit.wordsWritten ?? null,
      });
      if (error) throw error;
      currentAttemptPosted = true;
      setLbStatus(`Posted automatically as ${name}.`, 'ok');
      loadLeaderboard();
    } catch (err) {
      setLbStatus('Could not post score: ' + err.message, 'err');
    } finally {
      btnSubmitScore.disabled = false;
    }
  }

  btnSubmitScore.addEventListener('click', () => submitScore(false));

  document.getElementById('compareToggle').addEventListener('click', function () {
    const box = document.getElementById('compareBox');
    box.classList.toggle('show');
    this.textContent = box.classList.contains('show') ? 'hide original vs. your rewrite' : 'show original vs. your rewrite';
  });

  document.getElementById('btnAgain').addEventListener('click', () => {
    clearInterval(readInterval);
    clearInterval(writeInterval);
    lastResultForSubmit = null;
    currentAttemptPosted = false;
    setLbStatus('');
    document.getElementById('compareBox').classList.remove('show');
    document.getElementById('compareToggle').textContent = 'show original vs. your rewrite';
    btnStart.disabled = false;
    btnStart.textContent = 'Generate passage & start';
    showStage('setup');
  });

  // Disable copy/cut/contextmenu/selectstart/dragstart globally during reading stage
  ['copy', 'cut', 'contextmenu', 'selectstart', 'dragstart'].forEach(evt => {
    document.addEventListener(evt, e => {
      if (document.body.classList.contains('reading-active')) {
        e.preventDefault();
      }
    });
  });

  // Block keyboard copy/cut/select-all commands (Ctrl+C, Cmd+C, etc.) during reading stage
  document.addEventListener('keydown', e => {
    if (document.body.classList.contains('reading-active')) {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && (e.key === 'c' || e.key === 'C' || e.key === 'x' || e.key === 'X' || e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
      }
    }
  });

  // Disable copy/cut/contextmenu/selectstart/dragstart on passageBox specifically to be extra safe
  const passageBox = document.getElementById('passageBox');
  ['copy', 'cut', 'contextmenu', 'selectstart', 'dragstart'].forEach(evt => {
    passageBox.addEventListener(evt, e => e.preventDefault());
  });

  // Disable paste/drop on rewriteInput
  const rewriteInput = document.getElementById('rewriteInput');
  ['paste', 'drop'].forEach(evt => {
    rewriteInput.addEventListener(evt, e => e.preventDefault());
  });

  // =========================================================
  // ---- Fill in the Blanks (contextual, no options) round ----
  // =========================================================
  const FITB_QUESTION_SECONDS = 25;
  const FITB_TOTAL_QUESTIONS = 25;

  let fitbQuestions = [];   // [{sentence, answer, acceptable}]
  let fitbAnswers = [];     // user-typed answers, same length/order
  let fitbIndex = 0;
  let fitbInterval = null;

  function buildFitbGenPrompt(topic) {
    return `Generate exactly ${FITB_TOTAL_QUESTIONS} sentences for a TCS NQT "Fill in the Blank" verbal ability drill on the general theme of "${topic}" (vary the specific subject matter of each sentence — don't make every sentence literally about the theme, just keep them plausible NQT verbal-ability sentences). This year's format removed the original multiple-choice options, so the candidate must infer the missing word purely from context.

For each sentence, remove exactly one contextually important word or short phrase (an adjective, verb, connector, or noun whose identity must be inferred from the surrounding meaning) and mark its position with "____" (four underscores).

Return ONLY valid JSON, no markdown fences, no commentary, in this exact shape:
[{"sentence": "The panel was impressed by the candidate's ____ approach to the case study.", "answer": "meticulous", "acceptable": ["thorough", "careful", "rigorous"]}, ...]

Rules:
- Exactly ${FITB_TOTAL_QUESTIONS} items in the array, no more, no fewer.
- "sentence" contains exactly one "____" marker.
- "answer" is the single best original word or short phrase.
- "acceptable" lists 2-4 other words/phrases that would also fit the context correctly.
- Vary sentence topics, structures, and blanked part-of-speech across all ${FITB_TOTAL_QUESTIONS} items — no repeated sentences or near-duplicates.
- Each sentence is 12-24 words, one line, moderately formal register.`;
  }

  async function generateFitbQuestions(apiKey, model, topic) {
    const raw = await callGroq(apiKey, model, buildFitbGenPrompt(topic));
    const parsed = JSON.parse(stripFences(raw));
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('Model did not return any questions.');
    return parsed.filter(q => q && typeof q.sentence === 'string' && q.sentence.includes('____'));
  }

  async function startFitbDrill() {
    const apiKey = document.getElementById('apiKey').value.trim();
    const topicValue = document.getElementById('topic').value;
    const model = document.getElementById('model').value;
    setError(document.getElementById('setupError'), '');

    if (!apiKey) {
      setError(document.getElementById('setupError'), 'Enter your Groq API key first.');
      return;
    }
    if (!model) {
      setError(document.getElementById('setupError'), 'Load and pick a model first (click "reload list" if it hasn\'t loaded).');
      return;
    }

    const topic = (!topicValue || topicValue === RANDOM_VALUE) ? pickRandomTopic() : topicValue;

    btnStart.disabled = true;
    btnStart.textContent = 'Generating…';

    showStage('fitb');
    document.getElementById('fitbSentenceBox').innerHTML = '<span class="loading-line">Generating your 25 questions…</span>';
    document.getElementById('fitbAnswerInput').value = '';

    try {
      fitbQuestions = await generateFitbQuestions(apiKey, model, topic);
      if (fitbQuestions.length < 5) throw new Error('Not enough usable questions came back — try again.');
      fitbAnswers = new Array(fitbQuestions.length).fill('');
      fitbIndex = 0;
      btnStart.disabled = false;
      btnStart.textContent = 'Generate 25 blanks & start';
      showFitbQuestion();
    } catch (err) {
      showStage('setup');
      setError(document.getElementById('setupError'), err.message);
      btnStart.disabled = false;
      btnStart.textContent = 'Generate 25 blanks & start';
    }
  }

  function renderFitbSentence(sentence) {
    const parts = sentence.split('____');
    const box = document.getElementById('fitbSentenceBox');
    box.innerHTML = '';
    parts.forEach((part, i) => {
      box.appendChild(document.createTextNode(part));
      if (i < parts.length - 1) {
        const span = document.createElement('span');
        span.className = 'blank-marker';
        span.textContent = '____';
        box.appendChild(span);
      }
    });
  }

  function showFitbQuestion() {
    clearInterval(fitbInterval);
    const q = fitbQuestions[fitbIndex];
    document.getElementById('fitbProgressLabel').textContent = `Question ${fitbIndex + 1} of ${fitbQuestions.length}`;
    renderFitbSentence(q.sentence);
    const input = document.getElementById('fitbAnswerInput');
    input.value = '';
    input.disabled = false;
    input.focus();

    let remaining = FITB_QUESTION_SECONDS;
    const progressEl = document.getElementById('fitbRingProgress');
    const numEl = document.getElementById('fitbRingNum');
    const wrapEl = document.getElementById('fitbTimerWrap');
    updateRing(progressEl, numEl, wrapEl, remaining, FITB_QUESTION_SECONDS);

    fitbInterval = setInterval(() => {
      remaining--;
      updateRing(progressEl, numEl, wrapEl, Math.max(remaining, 0), FITB_QUESTION_SECONDS);
      if (remaining <= 0) {
        clearInterval(fitbInterval);
        advanceFitb();
      }
    }, 1000);
  }

  function advanceFitb() {
    fitbAnswers[fitbIndex] = document.getElementById('fitbAnswerInput').value.trim();
    fitbIndex++;
    if (fitbIndex < fitbQuestions.length) {
      showFitbQuestion();
    } else {
      gradeFitb();
    }
  }

  document.getElementById('btnFitbNext').addEventListener('click', () => {
    clearInterval(fitbInterval);
    advanceFitb();
  });
  document.getElementById('fitbAnswerInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearInterval(fitbInterval);
      advanceFitb();
    }
  });

  function buildFitbGradePrompt(items) {
    return `You are grading a candidate's attempt at a TCS NQT-style "Fill in the Blank" contextual vocabulary round. For each item, the candidate had ${FITB_QUESTION_SECONDS} seconds to read one sentence with a missing word and type the missing word/phrase purely from context — no options were given.

Mark an answer correct if it fits the sentence's meaning and grammar well — matching the original "answer", one of the "acceptable" alternatives, or any other word/phrase you judge genuinely fits the context and part of speech, even if not listed. Be lenient on minor spelling slips but strict on wrong meaning, wrong part of speech, or a blank left empty.

ITEMS (JSON array, in order):
${JSON.stringify(items)}

Respond with ONLY valid JSON, no markdown fences, no commentary, in this exact shape:
{"score": <integer 0-${items.length}>, "results": [{"correct": <true or false>, "note": "<if incorrect, a very short reason under 12 words; empty string if correct>"}], "overall_feedback": "<2-3 sentence summary of patterns in what tripped the candidate up>"}

"results" must contain exactly ${items.length} items, in the same order as ITEMS.`;
  }

  async function gradeFitb() {
    showStage('scoring');
    document.getElementById('scoringLoadingText').textContent = 'Checking your 25 answers against context…';
    setError(document.getElementById('runError'), '');

    const apiKey = document.getElementById('apiKey').value.trim();
    const model = document.getElementById('model').value;

    const items = fitbQuestions.map((q, i) => ({
      sentence: q.sentence,
      answer: q.answer,
      acceptable: q.acceptable || [],
      userAnswer: fitbAnswers[i] || ''
    }));

    try {
      const raw = await callGroq(apiKey, model, buildFitbGradePrompt(items));
      const json = JSON.parse(stripFences(raw));
      renderFitbResult(json, items);
    } catch (err) {
      showStage('setup');
      setMode('fitb');
      setError(document.getElementById('setupError'), 'Could not grade this set: ' + err.message);
    }
  }

  function renderFitbResult(json, items) {
    showStage('fitbResult');

    const results = Array.isArray(json.results) ? json.results : [];
    const score = (typeof json.score === 'number') ? json.score : results.filter(r => r && r.correct).length;
    document.getElementById('fitbScoreNum').textContent = score;

    const feedbackBox = document.getElementById('fitbFeedbackBox');
    const feedbackText = document.getElementById('fitbFeedbackText');
    if (json.overall_feedback) {
      feedbackText.textContent = json.overall_feedback;
      feedbackBox.style.display = 'block';
    } else {
      feedbackBox.style.display = 'none';
    }

    const review = document.getElementById('fitbReview');
    review.innerHTML = '';
    items.forEach((item, i) => {
      const r = results[i] || {};
      const correct = !!r.correct;
      const div = document.createElement('div');
      div.className = 'fitb-item ' + (correct ? 'correct' : 'incorrect');

      const num = document.createElement('div');
      num.className = 'fitb-q-num';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = correct ? 'Correct' : 'Missed';
      num.append(`Q${i + 1}`, tag);
      div.appendChild(num);

      const sentenceEl = document.createElement('div');
      sentenceEl.className = 'fitb-sentence-render';
      sentenceEl.textContent = item.sentence.replace('____', `[${item.answer}]`);
      div.appendChild(sentenceEl);

      const yourAnswerEl = document.createElement('div');
      yourAnswerEl.className = 'fitb-your-answer';
      const yourAnswerB = document.createElement('b');
      yourAnswerB.textContent = item.userAnswer || '(blank)';
      yourAnswerEl.append('Your answer: ', yourAnswerB);
      div.appendChild(yourAnswerEl);

      if (!correct && r.note) {
        const noteEl = document.createElement('div');
        noteEl.className = 'fitb-note';
        noteEl.textContent = r.note;
        div.appendChild(noteEl);
      }

      review.appendChild(div);
    });
  }

  document.getElementById('btnFitbAgain').addEventListener('click', () => {
    clearInterval(fitbInterval);
    fitbQuestions = [];
    fitbAnswers = [];
    fitbIndex = 0;
    setMode('fitb');
    showStage('setup');
  });

})();
