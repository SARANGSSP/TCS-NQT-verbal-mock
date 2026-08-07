(function(){
  const READ_SECONDS = 30;
  const WRITE_SECONDS = 90;
  const RING_CIRC = 2 * Math.PI * 32;
  const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
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

  function loadJSONList(key){
    try{
      const raw = localStorage.getItem(key);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    }catch(e){ return []; }
  }
  function saveJSONList(key, arr, cap){
    try{ localStorage.setItem(key, JSON.stringify(arr.slice(-cap))); }catch(e){ /* storage unavailable, ignore */ }
  }
  function normalizeForCompare(text){
    return text.toLowerCase().replace(/[^a-z0-9\s]/g,'').trim().split(/\s+/).slice(0,20).join(' ');
  }
  function pickRandomTopic(){
    const usedTopics = loadJSONList(LS_USED_TOPICS);
    let pool = NQT_TOPICS.filter(t => !usedTopics.includes(t));
    if(!pool.length) pool = NQT_TOPICS.slice(); // exhausted — reset the cycle
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
  };
  function showStage(name){
    Object.values(stages).forEach(s => s.classList.remove('active'));
    stages[name].classList.add('active');
  }

  let originalPassage = '';
  let readInterval = null, writeInterval = null;

  function setError(el, msg){
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  // ---- fetch the current chat-capable model list for this key ----
  async function fetchModels(apiKey){
    const res = await fetch(GROQ_MODELS_URL, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if(!res.ok){
      let detail = '';
      try{ const j = await res.json(); detail = j.error?.message || ''; }catch(e){}
      throw new Error(`Could not load model list (${res.status}). ${detail}`);
    }
    const data = await res.json();
    const ids = (data.data || [])
      .map(m => m.id)
      .filter(id => id && !MODEL_ID_EXCLUDE.test(id))
      .sort();
    if(!ids.length) throw new Error('No chat models available on this key.');
    return ids;
  }

  const modelSelect = document.getElementById('model');
  const apiKeyInput = document.getElementById('apiKey');
  const reloadModelsLink = document.getElementById('reloadModels');
  let modelsLoadedForKey = '';

  async function loadModelsIntoSelect(){
    const apiKey = apiKeyInput.value.trim();
    setError(document.getElementById('setupError'), '');
    if(!apiKey){
      modelSelect.disabled = true;
      modelSelect.innerHTML = '<option value="">Enter API key, then load models →</option>';
      modelsLoadedForKey = '';
      return;
    }
    if(apiKey === modelsLoadedForKey) return; // already loaded for this exact key

    modelSelect.disabled = true;
    modelSelect.innerHTML = '<option value="">Loading models…</option>';
    try{
      const ids = await fetchModels(apiKey);
      modelSelect.innerHTML = '';
      ids.forEach(id => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        modelSelect.appendChild(opt);
      });
      if(ids.includes(PREFERRED_DEFAULT_MODEL)){
        modelSelect.value = PREFERRED_DEFAULT_MODEL;
      }
      modelSelect.disabled = false;
      modelsLoadedForKey = apiKey;
    }catch(err){
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
  async function callGroq(apiKey, model, prompt){
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
    if(!res.ok){
      let detail = '';
      try{ const j = await res.json(); detail = j.error?.message || ''; }catch(e){}
      throw new Error(`Groq request failed (${res.status}). ${detail}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    if(!text) throw new Error('Empty response from Groq.');
    return text.trim();
  }

  function stripFences(text){
    return text.replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
  }

  // ---- ring helpers ----
  function initRing(progressEl){
    progressEl.setAttribute('stroke-dasharray', RING_CIRC);
    progressEl.setAttribute('stroke-dashoffset', 0);
  }
  function updateRing(progressEl, numEl, wrapEl, remaining, total){
    const frac = remaining / total;
    progressEl.setAttribute('stroke-dashoffset', RING_CIRC * (1 - frac));
    numEl.textContent = remaining;
    wrapEl.classList.remove('warn','critical');
    if(remaining <= Math.ceil(total*0.15)) wrapEl.classList.add('critical');
    else if(remaining <= Math.ceil(total*0.4)) wrapEl.classList.add('warn');
  }

  initRing(document.getElementById('readRingProgress'));
  initRing(document.getElementById('writeRingProgress'));

  // ---- populate topic dropdown ----
  const topicSelect = document.getElementById('topic');
  (function populateTopics(){
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

  // ---- flow ----
  const btnStart = document.getElementById('btnStart');
  btnStart.addEventListener('click', startDrill);

  function buildGenPrompt(topic, avoidList){
    const avoidBlock = avoidList.length
      ? `\n\nDo NOT reuse any of these passages you (or another request) already generated for this reader — write something with a genuinely different angle, examples, and opening sentence, even if the topic is the same:\n${avoidList.map((p,i) => `${i+1}. """${p}"""`).join('\n')}`
      : '';
    return `You are creating practice material for the TCS NQT exam's "Rewrite Passage" round. Write a single self-contained paragraph of 100-130 words on the topic of "${topic}". Make it moderately formal, information-dense with 4-6 distinct factual or logical points a reader would need to recall, written in clear complete sentences with a brief opening/context sentence, a body of key points, and a short concluding sentence that wraps up the idea. Output ONLY the paragraph text — no title, no quotes, no preamble, no markdown.${avoidBlock}`;
  }

  async function generateUniquePassage(apiKey, model, topic){
    const used = loadJSONList(LS_USED_PASSAGES);
    const usedNormalized = used.map(normalizeForCompare);
    const avoidList = used.slice(-5); // keep the prompt short — last 5 is plenty of signal

    const MAX_ATTEMPTS = 3;
    let passage = '';
    for(let attempt = 0; attempt < MAX_ATTEMPTS; attempt++){
      passage = await callGroq(apiKey, model, buildGenPrompt(topic, avoidList));
      if(!usedNormalized.includes(normalizeForCompare(passage))) break;
      // duplicate of something this user already saw — try again
    }

    used.push(passage);
    saveJSONList(LS_USED_PASSAGES, used, HISTORY_CAP);
    return passage;
  }

  async function startDrill(){
    const apiKey = document.getElementById('apiKey').value.trim();
    const topicValue = document.getElementById('topic').value;
    const model = document.getElementById('model').value;
    setError(document.getElementById('setupError'), '');

    if(!apiKey){
      setError(document.getElementById('setupError'), 'Enter your Groq API key first.');
      return;
    }
    if(!model){
      setError(document.getElementById('setupError'), 'Load and pick a model first (click "reload list" if it hasn\'t loaded).');
      return;
    }

    const topic = (!topicValue || topicValue === RANDOM_VALUE) ? pickRandomTopic() : topicValue;

    btnStart.disabled = true;
    btnStart.textContent = 'Generating…';

    showStage('reading');
    document.getElementById('passageBox').classList.remove('blurred');
    document.getElementById('passageBox').innerHTML = '<span class="loading-line">Generating your passage…</span>';

    try{
      const passage = await generateUniquePassage(apiKey, model, topic);
      originalPassage = passage;
      document.getElementById('passageBox').textContent = passage;
      runReadTimer();
    }catch(err){
      showStage('setup');
      setError(document.getElementById('setupError'), err.message);
      btnStart.disabled = false;
      btnStart.textContent = 'Generate passage & start';
    }
  }

  function runReadTimer(){
    let remaining = READ_SECONDS;
    const progressEl = document.getElementById('readRingProgress');
    const numEl = document.getElementById('readRingNum');
    const wrapEl = document.getElementById('readTimerWrap');
    updateRing(progressEl, numEl, wrapEl, remaining, READ_SECONDS);

    readInterval = setInterval(() => {
      remaining--;
      updateRing(progressEl, numEl, wrapEl, Math.max(remaining,0), READ_SECONDS);
      if(remaining <= 0){
        clearInterval(readInterval);
        beginWriting();
      }
    }, 1000);
  }

  function beginWriting(){
    showStage('writing');
    const ta = document.getElementById('rewriteInput');
    ta.value = '';
    document.getElementById('wordCount').textContent = '0 words';
    ta.focus();
    ta.addEventListener('input', updateWordCount);

    let remaining = WRITE_SECONDS;
    const progressEl = document.getElementById('writeRingProgress');
    const numEl = document.getElementById('writeRingNum');
    const wrapEl = document.getElementById('writeTimerWrap');
    updateRing(progressEl, numEl, wrapEl, remaining, WRITE_SECONDS);

    writeInterval = setInterval(() => {
      remaining--;
      updateRing(progressEl, numEl, wrapEl, Math.max(remaining,0), WRITE_SECONDS);
      if(remaining <= 0){
        clearInterval(writeInterval);
        finishWriting();
      }
    }, 1000);
  }

  function updateWordCount(){
    const val = document.getElementById('rewriteInput').value.trim();
    const count = val ? val.split(/\s+/).length : 0;
    document.getElementById('wordCount').textContent = `${count} word${count===1?'':'s'}`;
  }

  document.getElementById('btnGiveUp').addEventListener('click', () => {
    clearInterval(writeInterval);
    finishWriting();
  });

  async function finishWriting(){
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

    try{
      const raw = await callGroq(apiKey, model, scorePrompt);
      const json = JSON.parse(stripFences(raw));
      renderResult(json, rewrite);
    }catch(err){
      showStage('result');
      document.getElementById('scoreNum').textContent = '–';
      setError(document.getElementById('runError'), 'Could not grade this attempt: ' + err.message);
    }
  }

  function pct(v){ return Math.max(0, Math.min(100, (v/10)*100)); }

  function renderResult(json, rewrite){
    showStage('result');
    setError(document.getElementById('runError'), '');

    document.getElementById('scoreNum').textContent = json.score ?? '–';
    document.getElementById('mVocab').textContent = json.vocabulary_relevancy ?? '–';
    document.getElementById('mSentence').textContent = json.sentence_completeness ?? '–';
    document.getElementById('mCoverage').textContent = json.content_coverage ?? '–';
    document.getElementById('mStructure').textContent = json.structure ?? '–';
    document.getElementById('barVocab').style.width = pct(json.vocabulary_relevancy||0) + '%';
    document.getElementById('barSentence').style.width = pct(json.sentence_completeness||0) + '%';
    document.getElementById('barCoverage').style.width = pct(json.content_coverage||0) + '%';
    document.getElementById('barStructure').style.width = pct(json.structure||0) + '%';

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
  }

  document.getElementById('compareToggle').addEventListener('click', function(){
    const box = document.getElementById('compareBox');
    box.classList.toggle('show');
    this.textContent = box.classList.contains('show') ? 'hide original vs. your rewrite' : 'show original vs. your rewrite';
  });

  document.getElementById('btnAgain').addEventListener('click', () => {
    clearInterval(readInterval);
    clearInterval(writeInterval);
    document.getElementById('compareBox').classList.remove('show');
    document.getElementById('compareToggle').textContent = 'show original vs. your rewrite';
    btnStart.disabled = false;
    btnStart.textContent = 'Generate passage & start';
    showStage('setup');
  });

})();
