/**
 * Contact form spam filter
 * Rouse Photography Group
 *
 * Install: save as  functions/api/_spam-filter.js
 * (the leading underscore tells Cloudflare Pages this is a helper,
 *  not a route, so nothing new gets exposed publicly)
 *
 * Wire it into functions/api/contact.js like this:
 *
 *   import { checkSpam } from './_spam-filter.js';
 *   ...
 *   const verdict = checkSpam(payload);
 *   // verdict = { spam: true|false, score: number, reasons: [string] }
 *
 * Then branch on verdict.spam before you send the Jessie email.
 * Still write the Airtable record either way, with Status = "Spam",
 * so nothing disappears silently and you can audit the catches.
 *
 * v2 (Sept 2026): short-message penalty lowered from 3 to 2 so a brief
 * but legitimate inquiry ("Please call me") no longer trips the threshold
 * on its own. Short still contributes, and still lands as spam when
 * combined with any other signal.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

// A submission is spam at or above this score.
const SPAM_THRESHOLD = 3;

// Shorter than this (after trimming) is a weak spam signal, not proof.
const MIN_MESSAGE_LENGTH = 20;

// Instant spam. No headshot client has ever asked about these.
// Keep this list tight — anything here blocks on its own.
const HARD_BLOCK = [
  'virtual assistant',
  'virtual assistants',
  'backlink',
  'guest post',
  'link building',
  'appointment setter',
  'appointment setting',
  'cold calling',
  'lead generation',
  'data entry services',
  'dropship',
  'crypto',
];

// Services people try to sell you. Worth 2 points each.
// NOTE: "retouching" and "editing" are deliberately NOT hard blocks —
// real clients ask whether retouching is included. They only count
// when paired with a pitch phrase below.
const SERVICE_TERMS = [
  'retouching',
  'retouch service',
  'photo editing',
  'image editing',
  'clipping path',
  'background removal',
  'culling',
  'seo',
  'search engine optimization',
  'web design',
  'website redesign',
  'mobile app',
  'software development',
  'digital marketing',
  'social media management',
  'outsourcing',
  'offshore team',
];

// Outbound-pitch language. Worth 2 points each.
// This is what separates a vendor pitch from a client question.
const PITCH_TERMS = [
  'we offer',
  'we provide',
  'we specialize',
  'we help photographers',
  'our team of',
  'our company',
  'at no cost',
  'free of cost',
  'free trial',
  'test images',
  'sample edit',
  'no obligation',
  'would love to',
  'quick call',
  'hop on a call',
  'partner with you',
  'per image',
  'turnaround time',
  '24-hour delivery',
  '24 hour delivery',
  'boost your',
  'grow your business',
  'increase your sales',
  'let me know if you are interested',
  'if you are open to it',
  'best regards,',
];

// Email domains that have already sent you junk. Instant block.
// Add to this as new ones come in.
const BLOCKED_DOMAINS = [
  'vasdirect.com',
  'toptalentvas.com',
  'virtualhandsupport.com',
  'retouchingzone.com',
  'vas4hire.com',
];

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/**
 * @param {Object} payload  the parsed JSON body from the contact form
 * @returns {{spam: boolean, score: number, reasons: string[]}}
 */
export function checkSpam(payload) {
  const p = payload || {};
  const reasons = [];
  let score = 0;

  const name = str(p.name);
  const email = str(p.email).toLowerCase();
  const company = str(p.company);
  const message = str(p.message);
  const honeypot = str(p.website);

  const haystack = [name, company, message].join(' \n ').toLowerCase();

  // -- Structural checks ----------------------------------------------------

  // 1. Honeypot. Should already be handled upstream, kept here as a backstop.
  if (honeypot) {
    return { spam: true, score: 99, reasons: ['honeypot filled'] };
  }

  // 2. Blocked sender domain.
  const domain = email.split('@')[1] || '';
  if (domain && BLOCKED_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) {
    return { spam: true, score: 99, reasons: ['blocked domain: ' + domain] };
  }

  // 3. Empty or near-empty message. Worth 2, not 3 — on its own it is not
  //    enough to condemn a submission, since real people do write "call me".
  if (message.length < MIN_MESSAGE_LENGTH) {
    score += 2;
    reasons.push('message under ' + MIN_MESSAGE_LENGTH + ' characters');
  }

  // 4. Message is just a phone number or a string of digits.
  //    Still worth 3 on its own. This is what caught the VA submissions.
  if (message && /^[\d\s().+\-]+$/.test(message)) {
    score += 3;
    reasons.push('message is digits only');
  }

  // 5. Message duplicates the phone field. Classic form-filler behavior.
  const digitsOf = (s) => s.replace(/\D/g, '');
  if (message && digitsOf(p.phone || '').length >= 7 && digitsOf(message) === digitsOf(str(p.phone))) {
    score += 3;
    reasons.push('message repeats the phone number');
  }

  // -- Content checks -------------------------------------------------------

  // 6. Hard-blocked terms.
  for (const term of HARD_BLOCK) {
    if (haystack.includes(term)) {
      return { spam: true, score: 99, reasons: ['blocked term: ' + term] };
    }
  }

  // 7. Service term + pitch term together. Either alone is fine.
  const serviceHits = SERVICE_TERMS.filter((t) => haystack.includes(t));
  const pitchHits = PITCH_TERMS.filter((t) => haystack.includes(t));

  if (serviceHits.length && pitchHits.length) {
    score += 4;
    reasons.push('vendor pitch: ' + serviceHits[0] + ' + "' + pitchHits[0] + '"');
  } else if (pitchHits.length >= 2) {
    score += 2;
    reasons.push('multiple pitch phrases: ' + pitchHits.slice(0, 2).join(', '));
  }

  // 8. Links in the message. Real inquiries rarely include one.
  const links = (message.match(/https?:\/\/|www\.|\.com\b|\.net\b/gi) || []).length;
  if (links >= 2) {
    score += 2;
    reasons.push(links + ' links or domains in message');
  }

  // 9. Sender's email domain appears in their own message. Signature block.
  if (domain && message.toLowerCase().includes(domain)) {
    score += 1;
    reasons.push('sender domain repeated in message');
  }

  return { spam: score >= SPAM_THRESHOLD, score, reasons };
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}
