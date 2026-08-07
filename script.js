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

  // ---- flow ----
  const btnStart = document.getElementById('btnStart');
  btnStart.addEventListener('click', startDrill);

  async function startDrill(){
    const apiKey = document.getElementById('apiKey').value.trim();
    const topic = document.getElementById('topic').value.trim();
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

    btnStart.disabled = true;
    btnStart.textContent = 'Generating…';

    showStage('reading');
    document.getElementById('passageBox').classList.remove('blurred');
    document.getElementById('passageBox').innerHTML = '<span class="loading-line">Generating your passage…</span>';

    const genPrompt = `You are creating practice material for the TCS NQT exam's "Rewrite Passage" round. Write a single self-contained paragraph of 100-130 words${topic ? ` on the topic of ${topic}` : ' on a random general-knowledge, workplace, technology, or current-affairs-adjacent topic (avoid anything too niche or technical)'}. Make it moderately formal, information-dense with 4-6 distinct factual or logical points a reader would need to recall, written in clear complete sentences. Output ONLY the paragraph text — no title, no quotes, no preamble, no markdown.`;

    try{
      const passage = await callGroq(apiKey, model, genPrompt);
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
4. score (1-10): holistic overall score a TCS grader would likely give

Respond with ONLY valid JSON, no markdown fences, no commentary, in this exact shape:
{"score": <number>, "vocabulary_relevancy": <number>, "sentence_completeness": <number>, "content_coverage": <number>, "feedback": "<2-3 sentence constructive feedback, direct and specific>", "missed_points": ["<short phrase>", "<short phrase>"]}`;

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
    document.getElementById('barVocab').style.width = pct(json.vocabulary_relevancy||0) + '%';
    document.getElementById('barSentence').style.width = pct(json.sentence_completeness||0) + '%';
    document.getElementById('barCoverage').style.width = pct(json.content_coverage||0) + '%';

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
