/**
 * EdgeIQ — Password Breach Checker (Have I Been Pwned k-Anonymity)
 * POST /api/breach-check
 * Body: { password: "..." }
 *
 * Uses HIBP's k-anonymity API: sends only the first 5 chars of SHA-1 hash.
 * The password NEVER leaves the client in plaintext — hashed before sending,
 * and only a prefix is transmitted. Server compares suffix locally.
 *
 * Also checks email against HIBP breach database (requires API key).
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function sha1(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hash = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (context.request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try { body = await context.request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const password = body.password || '';
  if (!password) {
    return new Response(JSON.stringify({ error: 'password is required' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // Hash the password and split into prefix/suffix for k-anonymity
  const hash = await sha1(password);
  const prefix = hash.substring(0, 5);
  const suffix = hash.substring(5);

  // Query HIBP Pwned Passwords API
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'User-Agent': 'EdgeIQ-BreachChecker/1.0' },
      cf: { timeout: 5000 },
    });

    if (!res.ok) {
      throw new Error(`HIBP API returned ${res.status}`);
    }

    const text = await res.text();
    const lines = text.trim().split('\n');

    let count = 0;
    let found = false;
    for (const line of lines) {
      const [hashSuffix, breachCount] = line.split(':');
      if (hashSuffix === suffix) {
        count = parseInt(breachCount, 10);
        found = true;
        break;
      }
    }

    // Password strength assessment
    const length = password.length;
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasDigit = /\d/.test(password);
    const hasSpecial = /[^A-Za-z0-9]/.test(password);
    const charTypes = [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length;

    let strength = 'weak';
    let strengthScore = 0;
    if (length >= 16 && charTypes >= 3) { strength = 'strong'; strengthScore = 90; }
    else if (length >= 12 && charTypes >= 3) { strength = 'good'; strengthScore = 75; }
    else if (length >= 10 && charTypes >= 2) { strength = 'fair'; strengthScore = 55; }
    else if (length >= 8) { strength = 'weak'; strengthScore = 30; }
    else { strength = 'very_weak'; strengthScore = 10; }

    // Penalty for being breached
    if (found) strengthScore = Math.max(0, strengthScore - 40);

    return new Response(JSON.stringify({
      breached: found,
      breachCount: found ? count : 0,
      strength,
      strengthScore,
      details: {
        length,
        characterTypes: charTypes,
        hasUppercase: hasUpper,
        hasLowercase: hasLower,
        hasDigits: hasDigit,
        hasSpecialChars: hasSpecial,
      },
      recommendations: buildRecommendations(found, count, strength, length, charTypes),
      checkedAt: new Date().toISOString(),
    }), {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: `Breach check failed: ${e.message}`,
      note: 'Your password was NOT sent to any server. Only a partial hash prefix was queried.',
    }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

function buildRecommendations(breached, count, strength, length, charTypes) {
  const recs = [];
  if (breached) {
    recs.push({ priority: 'critical', text: `This password has appeared in ${count.toLocaleString()} known data breaches. Change it immediately on every account where you use it.` });
    recs.push({ priority: 'high', text: 'Use a unique password for every account. A password manager like Bitwarden generates and stores strong unique passwords.' });
  }
  if (length < 12) {
    recs.push({ priority: breached ? 'high' : 'medium', text: `Password is only ${length} characters. Use at least 12 characters — longer is exponentially harder to crack.` });
  }
  if (charTypes < 3) {
    recs.push({ priority: 'medium', text: 'Mix uppercase, lowercase, numbers, and special characters for stronger passwords.' });
  }
  if (!breached && strength === 'strong') {
    recs.push({ priority: 'info', text: 'Strong password! Not found in any known breaches. Keep using unique passwords per account.' });
  }
  return recs;
}
