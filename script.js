// =============================================================================
// Restart — frontend/script.js
//
// ─── AI Focus Mode: Endpoint Configuration ───────────────────────────────────
//
//  LOCAL DEVELOPMENT
//    While developing locally, set API_BASE to an empty string.
//    Focus Mode will be unavailable without the Lambda backend running,
//    but every other feature (Brain Boost, Breathing, Facts, Tips, Activities)
//    works entirely offline with no network needed.
//
//  PRODUCTION (after deploying Lambda + API Gateway)
//    Replace the empty string below with the Invoke URL from API Gateway.
//    Example:
//      const API_BASE = "https://abc123xyz.execute-api.us-east-1.amazonaws.com";
//
//    The frontend will then call:  POST  API_BASE + "/focus-mode"
//    The Gemini API key lives ONLY in Lambda environment variables —
//    it is never present in this file or anywhere in the browser.
//
// =============================================================================

const API_BASE = "https://vi3s03g6uf.execute-api.us-east-1.amazonaws.com/prod";   // ← Replace with your API Gateway Invoke URL after deployment

// ── Helpers ───────────────────────────────────────
const $ = id => document.getElementById(id);
const rand = arr => arr[Math.floor(Math.random() * arr.length)];

function showEl(id) { $(id).style.display = 'block'; }
function hideEl(id) { $(id).style.display = 'none';  }

function openOverlay(id) {
  $(id).classList.add('visible');
  document.body.style.overflow = 'hidden';
}
function closeOverlay(id) {
  $(id).classList.remove('visible');
  document.body.style.overflow = '';
}

// ── Close overlay on outside click ───────────────
document.querySelectorAll('.card-overlay').forEach(ov => {
  ov.addEventListener('click', e => {
    if (e.target !== ov) return;
    const id = ov.id;
    if (id === 'overlay-breath')   stopBreathing();
    if (id === 'overlay-activity') clearTimeout(window._actTimer);
    closeOverlay(id);
  });
});


// =============================================================================
// 1. AI FOCUS MODE
//    Sends { topic } to the secure Lambda backend.
//    The backend calls Gemini and returns { plan }.
//    No API key ever touches this file.
// =============================================================================

function showFocusStep(step) {
  ['focus-step-input', 'focus-step-loading', 'focus-step-result', 'focus-step-error']
    .forEach(id => hideEl(id));
  showEl(step);
}

// Open modal
$('btn-focus').addEventListener('click', () => {
  showFocusStep('focus-step-input');
  $('focus-topic').value = '';
  openOverlay('overlay-focus');
  setTimeout(() => $('focus-topic').focus(), 350);
});

// Close / navigation buttons
$('focus-close').addEventListener('click',       () => closeOverlay('overlay-focus'));
$('focus-done').addEventListener('click',        () => closeOverlay('overlay-focus'));
$('focus-error-close').addEventListener('click', () => closeOverlay('overlay-focus'));

$('focus-error-retry').addEventListener('click', () => {
  showFocusStep('focus-step-input');
  setTimeout(() => $('focus-topic').focus(), 100);
});

$('focus-try-again').addEventListener('click', () => {
  showFocusStep('focus-step-input');
  $('focus-topic').value = '';
  setTimeout(() => $('focus-topic').focus(), 100);
});

// Allow Enter key to submit
$('focus-topic').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitFocus();
});

$('focus-submit').addEventListener('click', submitFocus);

/**
 * submitFocus()
 *
 * Sends the topic to our Lambda-backed endpoint.
 * The request body is:  { "topic": "..." }
 * The expected response is:  { "plan": "STEP1: ...\nSTEP2: ...\nSTEP3: ...\nNEXT: ..." }
 */
async function submitFocus() {
  const topic = $('focus-topic').value.trim();

  // Basic client-side validation
  if (!topic) {
    $('focus-topic').focus();
    $('focus-topic').style.borderColor = 'var(--warm)';
    setTimeout(() => { $('focus-topic').style.borderColor = ''; }, 1200);
    return;
  }

  // Guard: if API_BASE hasn't been configured yet, show a clear dev message
  if (!API_BASE) {
    $('focus-error-msg').innerHTML =
      'The AI backend is not configured yet.<br>' +
      'Deploy the Lambda function and set <code>API_BASE</code> in <code>script.js</code>.<br>' +
      'See <code>backend/lambda/focusMode.js</code> for full deployment instructions.';
    showFocusStep('focus-step-error');
    return;
  }

  showFocusStep('focus-step-loading');

  try {
    // ── POST to the Lambda-backed API Gateway endpoint ──────────────────────
    const response = await fetch(`${API_BASE}/focus-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Only the topic is sent — no API key, no secrets
      body: JSON.stringify({ topic }),
    });

    // Handle non-2xx HTTP responses returned by Lambda / API Gateway
    if (!response.ok) {
      let serverMsg = `Server responded with HTTP ${response.status}.`;
      try {
        const errBody = await response.json();
        if (errBody?.error) serverMsg = errBody.error;
      } catch { /* body wasn't JSON */ }
      throw new Error(serverMsg);
    }

    const data = await response.json();

    // Lambda returns { plan: "STEP1: ...\nSTEP2: ...\n..." }
    if (!data?.plan) {
      throw new Error('The server returned an empty plan. Please try again.');
    }

    renderFocusResult(topic, data.plan);

  } catch (err) {
    // Show a friendly error — never expose internal server details to the UI
    $('focus-error-msg').textContent =
      err.message || 'Could not reach the AI backend. Please check your connection.';
    showFocusStep('focus-step-error');
  }
}

/**
 * renderFocusResult(topic, raw)
 *
 * Parses the structured text returned by the Lambda function and builds
 * the result card DOM. Format expected:
 *   STEP1: Take three slow breaths.
 *   STEP2: Look away from the screen for 15 seconds.
 *   STEP3: Write your next small study action.
 *   NEXT:  Review the binary search algorithm implementation.
 */
function renderFocusResult(topic, raw) {
  const steps = [];
  let next = '';

  raw.split('\n').forEach(line => {
    const stepMatch = line.match(/^STEP\d:\s*(.+)/i);
    const nextMatch = line.match(/^NEXT:\s*(.+)/i);
    if (stepMatch) steps.push(stepMatch[1].trim());
    if (nextMatch) next = nextMatch[1].trim();
  });

  // Graceful fallback: if Gemini didn't follow the format exactly, use raw lines
  if (steps.length === 0) {
    const lines = raw
      .split('\n')
      .map(l => l.replace(/^[\d\-\.\*•]+\s*/, '').trim())
      .filter(Boolean);
    steps.push(...lines.slice(0, 3));
    if (lines.length > 3) next = lines[3];
  }

  // Render topic label
  $('focus-result-topic').textContent = topic;

  // Render steps
  const body = $('focus-result-body');
  body.innerHTML = '';

  steps.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'ai-step';
    div.innerHTML = `
      <div class="ai-step-num">${i + 1}</div>
      <div class="ai-step-text">${escHtml(s)}</div>
    `;
    body.appendChild(div);
  });

  // Render "next step" callout
  if (next) {
    const ns = document.createElement('div');
    ns.className = 'ai-next-step';
    ns.innerHTML = `<strong>Next Step</strong>${escHtml(next)}`;
    body.appendChild(ns);
  }

  showFocusStep('focus-step-result');
}

/** Escape HTML special characters to prevent XSS from AI-generated content. */
function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// =============================================================================
// 2. RESTART (random body/mind activity)
// =============================================================================

function doRestart() {
  const act = rand(activities);
  $('act-icon').textContent  = act.icon;
  $('act-title').textContent = act.title;
  $('act-body').textContent  = act.instruction;
  $('act-completion').classList.remove('show');
  $('act-completion').querySelector('p').textContent = '';
  $('act-done-btn').style.display  = 'block';
  $('act-close-btn').style.display = 'none';

  // Animate the countdown bar
  const bar = $('act-timer-bar');
  bar.style.transition = 'none';
  bar.style.width = '100%';
  requestAnimationFrame(() => {
    bar.style.transition = `width ${act.duration}s linear`;
    bar.style.width = '0%';
  });

  // Auto-complete after activity duration
  clearTimeout(window._actTimer);
  window._actTimer = setTimeout(() => {
    $('act-completion').querySelector('p').textContent =
      '✓ ' + act.completion + ' Now go back to studying.';
    $('act-completion').classList.add('show');
    $('act-done-btn').style.display  = 'none';
    $('act-close-btn').style.display = 'block';
  }, act.duration * 1000);

  openOverlay('overlay-activity');
}

$('restart-btn').addEventListener('click', doRestart);
$('btn-activity').addEventListener('click', doRestart);

$('act-done-btn').addEventListener('click', () => {
  $('act-completion').querySelector('p').textContent =
    '✓ Great! Your mind is reset. Now go back to studying.';
  $('act-completion').classList.add('show');
  $('act-done-btn').style.display  = 'none';
  $('act-close-btn').style.display = 'block';
});

$('act-close-btn').addEventListener('click', () => {
  clearTimeout(window._actTimer);
  closeOverlay('overlay-activity');
});


// =============================================================================
// 3. QUICK FACT
// =============================================================================

let lastFact = '';

function showFact() {
  let f;
  do { f = rand(facts); } while (f === lastFact);
  lastFact = f;
  const el = $('fact-text');
  el.style.opacity = '0';
  setTimeout(() => {
    el.textContent = '\u201C' + f + '\u201D';
    el.style.opacity = '1';
    el.style.transition = 'opacity 0.25s';
  }, 150);
}

$('btn-fact').addEventListener('click', () => { showFact(); openOverlay('overlay-fact'); });
$('fact-next').addEventListener('click', showFact);
$('fact-close').addEventListener('click', () => closeOverlay('overlay-fact'));


// =============================================================================
// 4. BRAIN BOOST  (sessionStorage lock: once per browser session)
// =============================================================================

$('btn-brain').addEventListener('click', () => {
  if (sessionStorage.getItem('brainDone')) {
    $('puzzle-q').textContent     = '';
    $('puzzle-options').innerHTML = '';
    $('puzzle-explanation').style.display = 'none';
    hideEl('puzzle-done-btn');
    showEl('puzzle-already');
    showEl('puzzle-already-close');
    openOverlay('overlay-brain');
    return;
  }
  hideEl('puzzle-already');
  hideEl('puzzle-already-close');
  showEl('puzzle-done-btn');
  loadPuzzle();
  openOverlay('overlay-brain');
});

let currentPuzzle  = null;
let puzzleAnswered = false;

function loadPuzzle() {
  currentPuzzle  = rand(puzzles);
  puzzleAnswered = false;
  $('puzzle-q').textContent            = currentPuzzle.question;
  $('puzzle-explanation').style.display = 'none';
  $('puzzle-explanation').textContent   = '';
  $('puzzle-done-btn').textContent      = 'Done';

  const opts = $('puzzle-options');
  opts.innerHTML = '';
  currentPuzzle.options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className   = 'puzzle-opt';
    btn.textContent = opt;
    btn.addEventListener('click', () => checkAnswer(opt, btn));
    opts.appendChild(btn);
  });
}

function checkAnswer(selected, btn) {
  if (puzzleAnswered) return;
  puzzleAnswered = true;

  document.querySelectorAll('.puzzle-opt').forEach(b => {
    b.disabled = true;
    if (b.textContent === currentPuzzle.answer) b.classList.add('correct');
  });
  if (selected !== currentPuzzle.answer) btn.classList.add('wrong');

  $('puzzle-explanation').textContent   = currentPuzzle.explanation;
  $('puzzle-explanation').style.display = 'block';
  sessionStorage.setItem('brainDone', '1');
  $('puzzle-done-btn').textContent = 'Go back to studying →';
}

$('puzzle-done-btn').addEventListener('click',      () => closeOverlay('overlay-brain'));
$('puzzle-already-close').addEventListener('click', () => closeOverlay('overlay-brain'));


// =============================================================================
// 5. BREATHING RESET
// =============================================================================

const phases = [
  { label: 'Inhale', duration: 4, scale: 1.5 },
  { label: 'Hold',   duration: 2, scale: 1.5 },
  { label: 'Exhale', duration: 6, scale: 1.0 },
  { label: 'Hold',   duration: 2, scale: 1.0 },
];
const TOTAL_CYCLES = 3;
let breathTimeout = null;

function startBreathing() {
  clearTimeout(breathTimeout);

  const circle   = $('breath-circle');
  const label    = $('breath-label');
  const phase    = $('breath-phase');
  const dots     = document.querySelectorAll('.breath-dot');
  const endMsg   = $('breath-end');
  const startBtn = $('breath-start');

  endMsg.style.display = 'none';
  startBtn.textContent = 'Stop';
  startBtn.onclick     = stopBreathing;

  let cycle = 0, phaseIdx = 0;
  dots.forEach(d => { d.className = 'breath-dot'; });

  function runPhase() {
    const p = phases[phaseIdx];
    label.textContent           = p.label;
    phase.textContent           = p.duration + 's';
    circle.style.transition     = `transform ${p.duration}s ease-in-out`;
    circle.style.transform      = `scale(${p.scale})`;

    breathTimeout = setTimeout(() => {
      phaseIdx++;
      if (phaseIdx >= phases.length) {
        phaseIdx = 0;
        cycle++;
        dots.forEach((d, i) => {
          d.className = 'breath-dot' + (i < cycle ? ' done' : '');
        });
        if (cycle >= TOTAL_CYCLES) {
          stopBreathing();
          endMsg.style.display = 'block';
          label.textContent    = 'Done ✓';
          phase.textContent    = 'Well done';
          return;
        }
      }
      runPhase();
    }, p.duration * 1000);
  }
  runPhase();
}

function stopBreathing() {
  clearTimeout(breathTimeout);
  const circle = $('breath-circle');
  circle.style.transition = 'transform 0.5s ease';
  circle.style.transform  = 'scale(1)';
  $('breath-label').textContent = 'Ready';
  $('breath-phase').textContent = '';
  const startBtn = $('breath-start');
  startBtn.textContent = 'Start Breathing';
  startBtn.onclick     = startBreathing;
}

$('btn-breath').addEventListener('click', () => {
  stopBreathing();
  $('breath-end').style.display = 'none';
  document.querySelectorAll('.breath-dot').forEach(d => { d.className = 'breath-dot'; });
  openOverlay('overlay-breath');
});
// $('breath-start').addEventListener('click', startBreathing);
$('breath-start').onclick = startBreathing;
$('breath-close').addEventListener('click', () => {
  stopBreathing();
  closeOverlay('overlay-breath');
});


// =============================================================================
// 6. STUDY TIP
// =============================================================================

let lastTip = null;

function showTip() {
  let t;
  do { t = rand(tips); } while (t === lastTip);
  lastTip = t;
  $('tip-title').textContent = t.title;
  $('tip-body').textContent  = t.body;
}

$('btn-tip').addEventListener('click', () => { showTip(); openOverlay('overlay-tip'); });
$('tip-next').addEventListener('click', showTip);
$('tip-close').addEventListener('click', () => closeOverlay('overlay-tip'));
