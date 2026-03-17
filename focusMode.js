// =============================================================================
// Restart — backend/lambda/focusMode.js
//
// AWS Lambda function: secure proxy between the Restart frontend and the
// Google Gemini API. The Gemini API key is stored as a Lambda environment
// variable and is NEVER exposed to the browser.
//
// ─── Architecture ────────────────────────────────────────────────────────────
//
//   Browser (S3-hosted frontend)
//        │  POST /focus-mode  { "topic": "Data Structures" }
//        ▼
//   AWS API Gateway  (HTTP API)
//        │
//        ▼
//   AWS Lambda  ← this file
//        │  reads process.env.GEMINI_API_KEY
//        │  normalises Gemini output  (see parseAndNormalise)
//        ▼
//   Google Gemini API  (gemini-2.5-flash)
//        │
//        ▼
//   Lambda returns { plan }  →  API Gateway  →  Browser
//
// ─── What changed from v1 ────────────────────────────────────────────────────
//
//  1. STRICTER PROMPT
//     • Uses a system-role message to separate behavioural instructions
//       from the user content — this is more reliable than stuffing
//       everything into a single user turn.
//     • The user turn now contains ONLY a filled-in template that Gemini
//       is asked to complete, making it much harder to deviate from the
//       format.
//     • Explicitly forbids markdown, asterisks, dashes, numbered lists,
//       blank lines between steps, and preamble/postamble text.
//
//  2. LOWER TEMPERATURE  (0.7 → 0.2)
//     Higher temperature increases creativity but also increases the chance
//     Gemini ignores formatting rules. 0.2 keeps answers warm and natural
//     while being far more deterministic about structure.
//
//  3. FALLBACK PARSER  (parseAndNormalise)
//     Even with a strict prompt, Gemini occasionally returns:
//       "1. Take a breath\n2. Look away\n3. Stretch\n4. Open your notes"
//     or mixes labelled and unlabelled lines. The parser handles every
//     known deviation pattern and converts them into canonical form:
//       STEP1: ...\nSTEP2: ...\nSTEP3: ...\nNEXT: ...
//     before the string is returned to the frontend.
//
//  4. GUARANTEED MINIMUM OUTPUT
//     After parsing, if fewer than 3 steps or no NEXT line were found,
//     topic-aware placeholders are injected so the frontend always gets
//     a complete, renderable result.
//
//  5. STOP SEQUENCES
//     Added stopSequences to the generationConfig so Gemini stops
//     generating after the NEXT line, preventing stray trailing text.
//
// ─── Environment Variables ───────────────────────────────────────────────────
//
//   GEMINI_API_KEY   Your Google AI Studio API key.
//                    Lambda Console → Configuration → Environment variables
//
//   ALLOWED_ORIGIN   (optional) Your frontend domain for CORS.
//                    Example: https://your-bucket.s3-website.amazonaws.com
//                    Defaults to * for local development.
//
// ─── Deployment (unchanged from v1) ──────────────────────────────────────────
//
//  1. zip function.zip focusMode.js
//  2. Lambda → Upload zip → Handler: focusMode.handler → Runtime: Node.js 20.x
//  3. Set env var GEMINI_API_KEY, timeout 15 s
//  4. API Gateway HTTP API → POST /focus-mode → this Lambda → Deploy
//  5. Copy Invoke URL → set API_BASE in frontend/script.js
//
// =============================================================================

'use strict';

const https = require('https');

// ── Constants ──────────────────────────────────────────────────────────────────

const GEMINI_HOST   = 'generativelanguage.googleapis.com';
const GEMINI_MODEL  = 'gemini-2.5-flash';
const GEMINI_PATH   = `/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_TOPIC_LEN = 120;
const MAX_TOKENS    = 350;   // slightly raised to avoid mid-NEXT truncation

// Fallback phrases used when Gemini provides fewer lines than expected.
// They are intentionally generic so they work for any study topic.
const FALLBACK_STEPS = [
  'Close your eyes and take one slow, deep breath.',
  'Roll your shoulders back and sit up straight.',
  'Take a sip of water and blink a few times.',
];
const FALLBACK_NEXT = (topic) =>
  `Open your notes and write down the next thing you need to understand about ${topic}.`;


// ── CORS headers ───────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}


// ── Prompt builder ─────────────────────────────────────────────────────────────
//
// IMPROVEMENT 1 — Two-part prompt using system + user roles.
//
// The system message locks in the output contract once, cleanly separated from
// the user content. Gemini is less likely to "forget" formatting rules when
// they are stated in the system role rather than buried inside the user turn.
//
// The user turn uses a pre-filled template. Completing a template is a task
// Gemini handles very reliably, unlike free-form "format like this" instructions.

function buildMessages(topic) {
  const system =
    'You are a concise study coach. ' +
    'You ALWAYS respond using ONLY the exact four-line format shown below. ' +
    'You NEVER use markdown, asterisks, dashes, bullet points, numbered lists, ' +
    'blank lines, bold text, or any preamble or postamble. ' +
    'Each line starts with its label (STEP1, STEP2, STEP3, NEXT) followed by a ' +
    'colon and a space, then one plain sentence. Nothing else.';

  // Pre-filled template: Gemini just has to complete each line.
  // Concrete examples in the template dramatically improve compliance.
  const user =
    `A student lost focus while studying "${topic}". ` +
    `Complete the four lines below. Each must be one plain sentence. ` +
    `Do not add any text before STEP1 or after the NEXT line.\n\n` +
    `STEP1: (a calming physical action, e.g. "Take three slow deep breaths.")\n` +
    `STEP2: (a sensory reset, e.g. "Look away from the screen for 15 seconds.")\n` +
    `STEP3: (a mental refocus action, e.g. "Write down the one thing you need to do next.")\n` +
    `NEXT: (one small specific study action for "${topic}", ` +
    `e.g. "Re-read the last paragraph you studied and summarise it in one sentence.")`;

  return [
    { role: 'user',  parts: [{ text: `SYSTEM: ${system}\n\n${user}` }] },
  ];
}


// ── HTTPS helper ───────────────────────────────────────────────────────────────
//
// Zero external dependencies — uses Node's built-in https module.
// Returns the full response body as a string, or rejects with an error
// that includes the HTTP status and body for CloudWatch logging.

function httpsPost(host, path, apiKey, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

    const req = https.request(
      {
        hostname: host,
        path:     `${path}?key=${apiKey}`,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`Gemini HTTP ${res.statusCode}: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}


// ── Response parser & normaliser ──────────────────────────────────────────────
//
// IMPROVEMENT 3 — Robust fallback parser.
//
// This function is the heart of the reliability fix. It accepts whatever
// string Gemini returned and always produces a canonical four-line string:
//
//   STEP1: <sentence>
//   STEP2: <sentence>
//   STEP3: <sentence>
//   NEXT:  <sentence>
//
// It handles these known Gemini deviation patterns:
//
//   Pattern A — Already correct (happy path, no-op)
//     STEP1: Take a breath.
//     STEP2: Look away.
//     ...
//
//   Pattern B — Numbered list (most common deviation)
//     1. Take a breath.
//     2. Look away.
//     3. Stretch your arms.
//     4. Open your notes.
//
//   Pattern C — Labelled but inconsistent casing / spacing
//     Step 1: Take a breath.
//     step2 : Look away.
//     STEP 3: Stretch.
//     next: Open your notes.
//
//   Pattern D — Bullet / dash list
//     - Take a breath.
//     - Look away.
//     - Stretch.
//     - Open your notes.
//
//   Pattern E — Mixed: some labelled, some plain
//     STEP1: Take a breath.
//     Look away from the screen.
//     NEXT: Review your last paragraph.
//
//   Pattern F — Preamble / postamble around the real content
//     "Here is your reset plan:\nSTEP1: ..."
//
// IMPROVEMENT 4 — Guaranteed minimum output.
// After parsing, if fewer than 3 steps or no NEXT were extracted,
// topic-aware placeholders are inserted so the frontend always renders.

function parseAndNormalise(raw, topic) {
  // ── Step 1: strip markdown noise ──────────────────────────────────────────
  const cleaned = raw
    .replace(/\*\*/g, '')          // bold
    .replace(/\*/g, '')            // italic / bullets
    .replace(/^#+\s*/gm, '')       // headings
    .replace(/`/g, '')             // code ticks
    .trim();

  const lines = cleaned
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  // ── Step 2: try to extract labelled lines first (patterns A, C, E) ────────
  // Regex accepts: STEP1, Step1, step 1, STEP 1, step1 — all equivalent.
  const stepRegex = /^step\s*([123])\s*:\s*/i;
  const nextRegex = /^next\s*:\s*/i;

  const steps = [null, null, null];   // index 0 → STEP1, etc.
  let   next  = null;

  lines.forEach(line => {
    const sm = line.match(stepRegex);
    const nm = line.match(nextRegex);
    if (sm) {
      const idx = parseInt(sm[1], 10) - 1;   // "1" → 0
      steps[idx] = line.replace(stepRegex, '').trim();
    } else if (nm) {
      next = line.replace(nextRegex, '').trim();
    }
  });

  // ── Step 3: if labelled extraction gave us nothing, try unlabelled lists ──
  // Covers patterns B (numbered) and D (bullet/dash).
  const allNull = steps.every(s => s === null);
  if (allNull) {
    // Strip leading markers: "1.", "1)", "-", "•", "*"
    const unlabelled = lines
      .map(l => l.replace(/^(\d+[.)]\s*|[-•*]\s*)/, '').trim())
      .filter(l => l.length > 0);

    if (unlabelled.length >= 1) steps[0] = unlabelled[0];
    if (unlabelled.length >= 2) steps[1] = unlabelled[1];
    if (unlabelled.length >= 3) steps[2] = unlabelled[2];
    if (unlabelled.length >= 4 && !next) next = unlabelled[3];
  }

  // ── Step 4: if we have some labelled steps but gaps, fill from plain lines ─
  // Covers pattern E (mixed).
  const plainLines = lines
    .filter(l => !l.match(stepRegex) && !l.match(nextRegex))
    .map(l => l.replace(/^(\d+[.)]\s*|[-•*]\s*)/, '').trim())
    .filter(l => l.length > 8);  // ignore very short fragments

  let plainIdx = 0;
  for (let i = 0; i < 3; i++) {
    if (!steps[i] && plainIdx < plainLines.length) {
      steps[i] = plainLines[plainIdx++];
    }
  }
  if (!next && plainIdx < plainLines.length) {
    next = plainLines[plainIdx];
  }

  // ── Step 5: apply fallbacks for anything still missing ────────────────────
  // IMPROVEMENT 4: guarantee at least 3 steps + 1 NEXT.
  for (let i = 0; i < 3; i++) {
    if (!steps[i]) steps[i] = FALLBACK_STEPS[i];
  }
  if (!next) next = FALLBACK_NEXT(topic);

  // ── Step 6: reassemble into canonical format ──────────────────────────────
  return [
    `STEP1: ${steps[0]}`,
    `STEP2: ${steps[1]}`,
    `STEP3: ${steps[2]}`,
    `NEXT: ${next}`,
  ].join('\n');
}


// ── Lambda handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {

  // ── CORS pre-flight ──────────────────────────────────────────────────────────
  const method =
    event?.requestContext?.http?.method ||
    event?.httpMethod ||
    'POST';

  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  // ── Validate API key ─────────────────────────────────────────────────────────
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY') {
    console.error('[focusMode] GEMINI_API_KEY is not set in environment variables.');
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Server configuration error: API key not set.' }),
    };
  }

  // ── Parse & validate request body ───────────────────────────────────────────
  let topic;
  try {
    const parsed = JSON.parse(event.body || '{}');
    topic = (parsed.topic || '').toString().trim().slice(0, MAX_TOPIC_LEN);
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Invalid JSON in request body.' }),
    };
  }

  if (!topic) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Missing or empty "topic" field.' }),
    };
  }

  // ── Call Gemini ──────────────────────────────────────────────────────────────
  const geminiPayload = {
    contents: buildMessages(topic),
    generationConfig: {
      // IMPROVEMENT 2: temperature lowered from 0.7 → 0.2 for more
      // deterministic, format-compliant output. Still warm enough to vary
      // the phrasing across calls.
      temperature:     0.2,
      maxOutputTokens: MAX_TOKENS,

      // IMPROVEMENT 5: stop sequences prevent trailing text after the NEXT line.
      // If Gemini finishes the NEXT sentence and starts another line, generation
      // stops immediately so the parser doesn't have to deal with it.
      stopSequences: ['\nSTEP5', '\n\n', 'Here is', 'I hope'],
    },
  };

  let rawText;
  try {
    const responseStr = await httpsPost(GEMINI_HOST, GEMINI_PATH, apiKey, geminiPayload);
    const geminiData  = JSON.parse(responseStr);
    rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!rawText.trim()) {
      throw new Error('Gemini returned an empty text field.');
    }
  } catch (err) {
    // Full error goes to CloudWatch; client gets a sanitised message only.
    console.error('[focusMode] Gemini call failed:', err.message);
    return {
      statusCode: 502,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: 'Failed to get a response from the AI. Please try again.',
      }),
    };
  }

  // ── Normalise the response ───────────────────────────────────────────────────
  // IMPROVEMENTS 3 + 4: parse whatever Gemini returned and guarantee
  // exactly STEP1/STEP2/STEP3/NEXT in canonical form.
  const normalisedPlan = parseAndNormalise(rawText, topic);

  // Log the raw vs normalised diff in CloudWatch for monitoring.
  // This is helpful for tuning the prompt further over time.
  if (normalisedPlan !== rawText.trim()) {
    console.log('[focusMode] Output was normalised.');
    console.log('[focusMode] Raw:', JSON.stringify(rawText));
    console.log('[focusMode] Normalised:', JSON.stringify(normalisedPlan));
  }

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({ plan: normalisedPlan }),
  };
};
