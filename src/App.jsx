import React, { useState, useEffect, useMemo, useRef } from 'react';
import mqtt from 'mqtt';
import {
  ClipboardPaste,
  Plus,
  Undo2,
  Trash2,
  Copy,
  Check,
  X,
  LayoutGrid,
  History,
  Lock,
  Unlock,
  Sun,
  Moon,
  Wrench,
  Flame,
  ArrowLeft,
  Sparkles,
  Share2,
  Download,
  Image as ImageIcon,
  AlertTriangle,
  Wifi,
  RefreshCw,
} from 'lucide-react';

const CATEGORIES = ['DB', 'SG', 'FD', 'GB', 'GL', 'DS'];
const PARSER_VERSION = 'v6';
const DEFAULT_SYNC_ROOM = 'sunny-live-8899';
const STORAGE_KEYS = {
  ENTRIES: 'sunny_tracker_entries_v1',
  CATEGORY: 'sunny_tracker_active_category_v1',
  LOCKED: 'sunny_tracker_is_locked_v1',
  DRAFT: 'sunny_tracker_draft_v1',
  COLUMNS: 'sunny_tracker_columns_v1',
  THEME: 'sunny_tracker_theme_v1',
  BATCH_SOURCES: 'sunny_tracker_batch_sources_v1',
};

/**
 * Normalizes a 1-2 digit token into 1..100 ("00" -> 100). Returns null if invalid.
 */
function normalizeJodiNumber(token) {
  const n = parseInt(token, 10);
  if (Number.isNaN(n)) return null;
  if (token === '00' || n === 100) return 100;
  if (n >= 1 && n <= 99) return n;
  return null;
}

/**
 * Extracts valid 1..100 numbers from a string of digits separated by spaces/punctuation.
 * Ignores 3+ digit numbers (like 111, 999 haruf or phone numbers).
 */
function extractJodiList(str) {
  const tokens = str.match(/\d+/g) || [];
  const nums = [];
  for (const tok of tokens) {
    if (tok.length >= 4 && tok.length % 2 === 0 && tok.length <= 12) {
      for (let idx = 0; idx < tok.length; idx += 2) {
        const n = normalizeJodiNumber(tok.slice(idx, idx + 2));
        if (n !== null) nums.push(n);
      }
      continue;
    }
    if (tok.length > 3 || (tok.length === 3 && tok !== '100')) continue;
    const n = normalizeJodiNumber(tok);
    if (n !== null) nums.push(n);
  }
  return nums;
}

/**
 * Returns the reversed 2-digit number (e.g. 34 -> 43, 01 -> 10),
 * or null for doubles (11, 22..99) and 100/00 which have no palat.
 */
function getPalatNumber(num) {
  if (num === 100 || num < 1 || num > 99) return null;
  const padded = String(num).padStart(2, '0');
  if (padded[0] === padded[1]) return null;
  return parseInt(padded[1] + padded[0], 10);
}

/**
 * Parses Haruf lines:
 * - "111/400 haruf bahar" -> digit 1 Bahar (01,11..91) @ 400/10 = ₹40 each
 * - "999 AB into 100" -> digit 9 Andar & Bahar @ 100/10 = ₹10 each
 * - "A2.3(300)" -> digits 2,3 Andar @ 300/10 = ₹30 each
 * - "7.AB.(50)" -> digit 7 Andar & Bahar @ 50/10 = ₹5 each
 */
function tryParseHarufLine(line, defaultSide = 'B', forceHaruf = false) {
  if (!/\d/.test(line)) return null;
  const hasHarufWord =
    /(?:\b|(?<=\d))(?:haruf|harf|harup|haroop|harap|hrf|bahar|bahr|andar|ander)\b/i.test(line) ||
    /(?:हरूफ|हरफ|बाहर|अंदर|अन्दर)/.test(line);
  const hasABToken =
    /(?:^|[\s.,(/]|\d)(?:AB|BA|A\s*\/\s*B|B\s*\/\s*A)(?:$|[\s.,)/=(])/i.test(line);
  const hasAttachedSide =
    /(?:^|[\s.,])(?:[AB][\s.,]*\d|\d[\s.,]*[AB])(?:$|[\s.,(/\d])/i.test(line) ||
    /(\d)\1{2,}\s*[AB]\s*\d+/i.test(line);
  // 3+ repeated identical digits (e.g. "222=100", "1111 into 400") without A/B defaults to Bahar Haruf
  const hasRepeatedHarufDigits = /\b(\d)\1{2,}/.test(line);
  const isSingleDigitHaruf = forceHaruf && /^\s*\d\s*[*×x=/\-\s.]+\d+(?:\.\d+)?\s*$/i.test(line);
  if (!hasHarufWord && !hasABToken && !hasAttachedSide && !hasRepeatedHarufDigits && !isSingleDigitHaruf) return null;

  const hasAB =
    /(?:^|[\s.,(/]|\d)(?:ab|ba|a\s*\/\s*b|b\s*\/\s*a)(?:$|[\s.,)/=(])/i.test(line) ||
    /(?:^|[\s.,])(?:ab|ba)[\s.,]*\d/i.test(line) ||
    (/\b(?:andar|ander)\b/i.test(line) && /\b(?:bahar|bahr)\b/i.test(line)) ||
    (/(?:अंदर|अन्दर)/.test(line) && /बाहर/.test(line));
  let hasA =
    hasAB ||
    /\b(?:andar|ander)\b/i.test(line) ||
    /(?:अंदर|अन्दर)/.test(line) ||
    /(?:^|[\s.,])a[\s.,]*\d|\d[\s.,]*a(?:$|[\s.,(/\d])/i.test(line);
  let hasB =
    hasAB ||
    /\b(?:bahar|bahr)\b/i.test(line) ||
    /बाहर/.test(line) ||
    /(?:^|[\s.,])b[\s.,]*\d|\d[\s.,]*b(?:$|[\s.,(/\d])/i.test(line);
  const hadExplicitSide = hasA || hasB;
  // If neither Andar nor Bahar is specified, use defaultSide ('B' by default, or 'A'/'AB' from context)
  if (!hadExplicitSide) {
    if (defaultSide === 'AB') {
      hasA = true;
      hasB = true;
    } else if (defaultSide === 'A') {
      hasA = true;
      hasB = false;
    } else {
      hasA = false;
      hasB = true;
    }
  }

  // Extract total haruf amount and divide by 10 (e.g. 400 -> ₹40 per jodi, 100 -> ₹10)
  let amt = 0;
  let digitPart = line;
  const parenAmt = line.match(/\(\s*@?\s*₹?\s*(\d+(?:\.\d+)?)\s*(?:into|in|rs|₹)?\s*\)?/i);
  const intoAmt = line.match(/(?:into|intu|ento|in|rs\.?|inr|r|₹|@|=|×|x|\*|-)\s*[.=*:₹\s]*(\d+(?:\.\d+)?)/i);
  const slashAmt = line.match(/\/\s*₹?\s*(\d+(?:\.\d+)?)(?:\s*(?:haruf|harf|harup|haroop|harap|hrf|bahar|bahr|andar|ander|ab|ba|a|b))?\s*$/i);
  const dotSepHaruf = line.match(/^(\d)\1{2,}[.\s]+(\d+(?:\.\d+)?)/);

  if (parenAmt) {
    amt = parseFloat(parenAmt[1]);
    digitPart = line.slice(0, parenAmt.index);
  } else if (intoAmt) {
    amt = parseFloat(intoAmt[1]);
    digitPart = line.slice(0, intoAmt.index);
  } else if (slashAmt) {
    amt = parseFloat(slashAmt[1]);
    digitPart = line.slice(0, slashAmt.index);
  } else if (dotSepHaruf) {
    digitPart = dotSepHaruf[1];
    amt = parseFloat(dotSepHaruf[2]);
  } else {
    const trailingAmt = line.match(/(\d+(?:\.\d+)?)\s*(?:₹|rs\.?|inr|\/-|रुपये|रुपए)?\s*$/i);
    if (trailingAmt) {
      amt = parseFloat(trailingAmt[1]);
      digitPart = line.slice(0, trailingAmt.index);
    }
  }

  if (!amt || amt <= 0) return [];
  const perJodi = amt / 10;

  // Extract unique haruf digits per numeric token (so "111" -> [1], "2.3" -> [2, 3])
  const digitTokens = digitPart.match(/\d+/g) || [];
  const digits = [];
  for (const tok of digitTokens) {
    for (const ch of new Set(tok.split(''))) {
      digits.push(parseInt(ch, 10));
    }
  }
  if (digits.length === 0) return [];

  const out = [];
  for (const d of digits) {
    if (hasA) {
      for (let k = 0; k <= 9; k++) {
        out.push({ number: d === 0 && k === 0 ? 100 : d * 10 + k, amount: perJodi });
      }
    }
    if (hasB) {
      for (let k = 0; k <= 9; k++) {
        out.push({ number: k === 0 && d === 0 ? 100 : k * 10 + d, amount: perJodi });
      }
    }
  }
  return out;
}

/**
 * Parses Crossing & Joda Cut (JC) lines:
 * - "jc" / "joda cut": all 2-digit combinations excluding doubles (d1 !== d2)
 * - "crossing" / "cwj" / "cwz": all 2-digit combinations including doubles (N x N)
 * Examples: "2346789= 5 in jc", "123 crossing 10", "123 (10) cwj", "123 cwz 20"
 */
function tryParseCrossingLine(line) {
  if (!/\d/.test(line)) return null;
  const isJodaCut = /\b(?:jc|j\.c|joda\s*cut|jode\s*cat|jodi\s*cut)\b/i.test(line);
  const hasExplicitCrossing = /\b(?:cwj|cwz|crocing|crossing)\b/i.test(line);
  const hasHarufHint =
    /\b(?:haruf|harf|harup|haroop|harap|hrf|bahar|bahr|andar|ander|ab|ba)\b/i.test(line) ||
    /(?:हरूफ|हरफ|बाहर|अंदर|अन्दर)/.test(line);
  const lineWithoutAmts = line
    .replace(/\(\s*@?\s*\d+(?:\.\d+)?\s*(?:\*|into|intu|ento|in|rs|r)?\s*\)/gi, ' ')
    .replace(/(?:@|into|intu|ento|in|rs|r|=|\*|×|x)\s*\d+(?:\.\d+)?/gi, ' ');
  const stuckTokens = lineWithoutAmts.match(/\b\d{4,9}\b/g) || [];
  // Only treat stuck tokens as Crossing when all 4+ digits are unique AND it's the sole number token on the line (e.g. 1469@10, 8350@15),
  // so comma/dot-separated jodi lists like "8223,,3298,,40,47,7442" are never misread as Crossing.
  const otherJodiTokens = (lineWithoutAmts.match(/\b\d{2,3}\b/g) || []).length;
  const hasStuckCrossingDigits =
    !hasHarufHint &&
    stuckTokens.length === 1 &&
    otherJodiTokens === 0 &&
    stuckTokens.some((tok) => new Set(tok.split('')).size >= 4 && !/^[1-9]\d?00+$/.test(tok));
  const isFullCrossing = hasExplicitCrossing || (!isJodaCut && hasStuckCrossingDigits);
  if (!isJodaCut && !isFullCrossing) return null;

  const normLine = line
    .replace(/[₹]/g, ' ')
    .replace(
      /(\d+(?:\.\d+)?)\s*(?:into|intu|ento|intoo|rs\.?|inr|rupe)\s*[/\-.,]*\s*$/i,
      ' into $1'
    )
    .trim();

  let amt = 0;
  let digitPart = normLine;

  const parenAmt = normLine.match(
    /\(\s*@?\s*(\d+(?:\.\d+)?)\s*(?:into|intu|ento|in|rs|jc|j\.c|joda\s*cut|jode\s*cat|jodi\s*cut|crossing|cwj|cwz)?\s*\)/i
  );
  const eqOrIntoAmt = normLine.match(
    /(?:=|into|intu|ento|in|rs|r|@|×|x)\s*[.=*:\s]*(\d+(?:\.\d+)?)/i
  );
  const afterKwAmt = normLine.match(
    /\b(?:jc|j\.c|joda\s*cut|jode\s*cat|jodi\s*cut|cwj|cwz|crocing|crossing)\b\s*[.=*:\s]*(\d+(?:\.\d+)?)/i
  );

  if (parenAmt) {
    amt = parseFloat(parenAmt[1]);
    digitPart = normLine.slice(0, parenAmt.index);
  } else if (eqOrIntoAmt) {
    amt = parseFloat(eqOrIntoAmt[1]);
    digitPart = normLine.slice(0, eqOrIntoAmt.index);
  } else if (afterKwAmt) {
    amt = parseFloat(afterKwAmt[1]);
    digitPart = normLine.slice(0, afterKwAmt.index);
  } else {
    const trailingAmt = normLine.match(/(\d+(?:\.\d+)?)\s*$/);
    if (trailingAmt) {
      amt = parseFloat(trailingAmt[1]);
      digitPart = normLine.slice(0, trailingAmt.index);
    }
  }

  if (!amt || amt <= 0) return [];

  const digits = [...new Set((digitPart.match(/\d/g) || []).map(Number))];
  if (digits.length === 0) return [];

  const out = [];
  for (const d1 of digits) {
    for (const d2 of digits) {
      if (isJodaCut && d1 === d2) continue;
      out.push({ number: d1 === 0 && d2 === 0 ? 100 : d1 * 10 + d2, amount: amt });
    }
  }
  return out;
}

/**
 * Parses real-world WhatsApp number/amount patterns:
 * - Strips WhatsApp timestamps, <Media omitted>, phone numbers, Total/Balance lines
 * - Supports "00" as 100
 * - Supports Palat ("with palat", "palt k sath", "wp", "plt", "into 30 palt 20") — doubles/100 are not reversed
 * - Supports Haruf ("111/400 haruf bahar", "999 AB into 100", "A2.3(300)", "7.AB.(50)") at amount / 10 per jodi
 * - Supports single pairs, multi-number groups, inline groups, and multi-line blocks
 */
function analyzeWhatsAppText(raw) {
  const results = [];
  const normalResults = [];
  const specialPreviews = [];
  const failed = [];
  const lineBreakdown = [];
  if (!raw || !raw.trim()) {
    return { results, normalResults, specialPreviews, failed, lineBreakdown };
  }

  const lines = raw.split(/\r?\n|;|\|/);
  let pendingNumbers = [];
  let pendingRawLines = [];
  let pendingLineRefs = [];
  let lastBatchNums = [];
  let lastBatchAmt = 0;
  let pendingHarufSide = null; // 'A' | 'B' | 'AB' | null
  let recentDefaultHarufs = []; // [{ digit, perJodi }] for trailing "A/B" line expansion

  const pushEntries = (nums, straightAmt, palatAmt) => {
    lastBatchNums = [...nums];
    lastBatchAmt = straightAmt;
    for (const n of nums) {
      results.push({ number: n, amount: straightAmt });
      normalResults.push({ number: n, amount: straightAmt });
      if (palatAmt > 0) {
        const rev = getPalatNumber(n);
        if (rev !== null) {
          results.push({ number: rev, amount: palatAmt });
          normalResults.push({ number: rev, amount: palatAmt });
        }
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i].trim();
    let line = originalLine;
    if (!line) continue;

    const lbEntry = {
      lineNo: lineBreakdown.length + 1,
      raw: originalLine,
      count: 0,
      total: 0,
      status: 'skipped',
      note: '',
    };
    lineBreakdown.push(lbEntry);
    const startResIdx = results.length;
    const startPendingCount = pendingNumbers.length;
    const startFailedCount = failed.length;
    try {

    // 1. Strip WhatsApp copy-paste & export timestamp + sender prefix:
    //    - "[22/11, 4:07 am] tg 3: 72.78.79.70.... into25"
    //    - "03/11/26, 4:01 am - Sunny: 00=50"
    line = line
      .replace(
        /^\[\d{1,2}\/\d{1,2}(?:\/\d{2,4})?,\s*\d{1,2}:\d{2}(?::\d{2})?(?:[\s\u00a0\u202f]*[ap]m)?\]\s*[^:]+:\s*/i,
        ''
      )
      .replace(
        /^\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}(?:[\s\u00a0\u202f]*[ap]m)?\s*-\s*[^:]+:\s*/i,
        ''
      )
      .trim();
    if (!line) continue;

    // Skip WhatsApp system lines, media, deleted messages, phone numbers, last time alerts
    if (
      /^\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}/.test(line) ||
      /<Media omitted>/i.test(line) ||
      /This message was deleted/i.test(line) ||
      /last\s*time/i.test(line) ||
      /paytm|phonepe|gpay|qr code|scanner/i.test(line) ||
      /\b\d{10}\b/.test(line)
    ) {
      continue;
    }

    // Skip Total / Balance / Grand Total lines (only when the line doesn't contain actual bet groups like "(200)" or "jc")
    const hasInlineBetSyntax = /\(\s*\d+|\bjc\b|\bse\b|\binto\b|\bintu\b/i.test(line);
    if (
      /^(?:total|tot|tol|ttl|tlt|tt\d*|t\d+|t|gt|all\s*total|hisab|balance|blnce|grand\s*total|टोटल|कुल)\b/i.test(
        line
      ) ||
      (/^\*?\(?\d+\s*₹?\]?\)*\s*[+\-*/=]*$/.test(line) &&
        !(pendingNumbers.length > 0 && /^\d{4,16}$/.test(line) && line.length % 2 === 0 && line.length / 2 === pendingNumbers.length) &&
        (/[₹*()+=]/.test(line) ||
          (line.replace(/\D/g, '').length >= 3 && line.trim() !== '100'))) ||
      (!hasInlineBetSyntax && (/\b\d{3,}\s*[-+]\s*\d+\s*=|\d+\s*\+\s*\d+\s*=/.test(line) || /\b\d+\s*\+\+/.test(line))) ||
      /^\s*[+]+\d+/.test(line)
    ) {
      pendingNumbers = [];
      pendingRawLines = [];
      continue;
    }

    // Strip trailing/leading total & balance clauses like "टोटल 100", "Total = 200", "210,total=410++...", "*2000--340=1660+++*"
    // Also strip game tags (gb, gali, ds, fd, fb, sg, db, gzb, gaziyabad, फरीदाबाद, दिसावर) anywhere & normalize "in to" -> "into"
    line = line
      .replace(/\*?\s*\d{3,}\s*--?\s*\d+\s*=\s*\d+\+{2,}\*?/gi, ' ')
      .replace(
        /[,\s=]*(?:\b\d+[,\s]*)?(?:टोटल|कुल|grand\s*total|total|tot|tol|ttl|tlt|sum|\bto\.)\s*[-:=*>₹.\s]*\d+(?:\.\d+)?(?:\s*(?:₹|rs\.?|inr|\/-|रुपये|रुपए))?.*$/gi,
        ' '
      )
      .replace(
        /\b\d+(?:\.\d+)?\s*(?:टोटल|कुल|grand\s*total|total|tot|tol|ttl|tlt)\b/gi,
        ' '
      )
      .replace(/\bin\s+to\b/gi, 'into')
      .replace(/(\d+)\s*ki\b/gi, ' into $1 ')
      .replace(/(?:फरीदाबाद|दिसावर|गाजियाबाद|गली|श्री\s*गणेश|दिल्ली\s*बाजार)/g, ' ')
      .replace(
        /\b(?:gb|gl|gali|ds|disawar|desawar|fd|fbd|fb|faridabad|sg|shree?\s*ganesh(?:\s+m)?|db|delhi\s*baza+r|gzb|gzbd|gazi[ya]*bad|ghaziabad)\b/gi,
        ' '
      )
      .replace(
        /(\d)(?:gb|gl|gali|ds|disawar|desawar|fd|fbd|fb|faridabad|sg|shree?\s*ganesh(?:\s+m)?|db|delhi\s*baza+r|gzb|gzbd|gazi[ya]*bad|ghaziabad)\s*$/i,
        '$1'
      )
      .replace(
        /^(?:gb|gl|gali|ds|disawar|desawar|fd|fbd|fb|faridabad|sg|shree?\s*ganesh(?:\s+m)?|db|delhi\s*baza+r|gzb|gzbd|gazi[ya]*bad|ghaziabad)(?=\d)/i,
        ''
      )
      .replace(/'/g, ' ')
      .replace(/^[,.\]\s=]+/, '')
      .trim();
    if (!line) continue;

    // Skip standalone 3+ digit total left after stripping game/total words (e.g. "Gaziyabad 150", "Faridabad. 450", "Fb]=190")
    if (/^\d{3,}$/.test(line) && pendingNumbers.length === 0) {
      continue;
    }

    // Extract inline Haruf tokens when mixed on the same line with normal bracket groups (e.g. "33(400)A3(150)" or "37(350)A3.2(250)A4(150)")
    const inlineHarufRe = /(?<=^|[\s.,)])((?:AB|BA|[AB])[\s.]*\d+(?:[\s.]*\d+)*\s*\(\s*\d+(?:\.\d+)?\s*\))/gi;
    if (/\(\s*\d+(?:\.\d+)?\s*\)/.test(line) && inlineHarufRe.test(line)) {
      inlineHarufRe.lastIndex = 0;
      let strippedLine = line;
      let hm;
      while ((hm = inlineHarufRe.exec(line)) !== null) {
        const hTok = hm[1].trim();
        const hEntries = tryParseHarufLine(hTok);
        if (hEntries && hEntries.length > 0) {
          results.push(...hEntries);
          const hTotal = hEntries.reduce((s, x) => s + x.amount, 0);
          specialPreviews.push({
            kind: 'haruf',
            raw: hTok,
            count: hEntries.length,
            perAmt: hEntries[0].amount,
            total: hTotal,
            items: [...hEntries].sort((a, b) => a.number - b.number),
          });
          strippedLine = strippedLine.replace(hTok, ' ').trim();
        }
      }
      line = strippedLine;
      if (!line) continue;
    }

    // Multi-segment JC + "A se B=amt" range on one line (e.g. "3957=10//120 jc  2468=10//120 jc.  89 se 98=10//100")
    if (/\b\d{1,2}\s+se\s+\d{1,2}\s*=|\b(?:jc|joda\s*cut)\b/i.test(line)) {
      const segs = [];
      let handledMulti = false;
      for (const jm of line.matchAll(/(\d{3,9})\s*=\s*(\d+(?:\.\d+)?)(?:\/\/\d+)?\s*(?:jc|joda\s*cut)\b/gi)) {
        const jcRes = tryParseCrossingLine(`${jm[1]}=${jm[2]} jc`);
        if (jcRes && jcRes.length > 0) {
          handledMulti = true;
          segs.push(...jcRes);
        }
      }
      for (const rm of line.matchAll(/\b(\d{1,2})\s+se\s+(\d{1,2})\s*=\s*(\d+(?:\.\d+)?)(?:\/\/\d+)?/gi)) {
        const a = parseInt(rm[1], 10);
        const b = parseInt(rm[2], 10);
        const amt = parseFloat(rm[3]);
        if (amt > 0 && b >= a && b - a <= 50) {
          handledMulti = true;
          for (let n = a; n <= b; n++) {
            const norm = normalizeJodiNumber(String(n));
            if (norm !== null) segs.push({ number: norm, amount: amt });
          }
        }
      }
      if (handledMulti && segs.length > 0) {
        pendingNumbers = [];
        pendingRawLines = [];
        results.push(...segs);
        continue;
      }
    }

    // Check for Joda Cut (JC) or Full Crossing (crossing / cwj / cwz)
    const crossingEntries = tryParseCrossingLine(line);
    if (crossingEntries !== null) {
      pendingNumbers = [];
      pendingRawLines = [];
      if (crossingEntries.length > 0) {
        results.push(...crossingEntries);
        const cTotal = crossingEntries.reduce((s, x) => s + x.amount, 0);
        const isJcExplicit = /\b(?:jc|j\.c|joda\s*cut|jode\s*cat|jodi\s*cut)\b/i.test(line);
        const digitsUsed = [...new Set(crossingEntries.map((x) => String(x.number === 100 ? '00' : x.number).padStart(2, '0')).join('').split('').map(Number))];
        specialPreviews.push({
          kind: 'crossing',
          raw: originalLine,
          isJodaCut: isJcExplicit,
          digits: digitsUsed,
          count: crossingEntries.length,
          perAmt: crossingEntries[0].amount,
          total: cTotal,
          items: [...crossingEntries].sort((a, b) => a.number - b.number),
        });
      } else {
        failed.push({ rawLine: originalLine, reason: 'क्रॉसिंग/JC में अंक या अमाउंट नहीं मिला' });
      }
      continue;
    }

    // Handle standalone Haruf side lines ("A/B", "AB", "A", "B", "Andar Bahar") before or after Haruf lines
    if (!/\d/.test(line)) {
      const sideOnlyMatch = line.match(/^(?:ab|ba|a\s*\/\s*b|b\s*\/\s*a|andar\s*bahar|अंदर\s*बाहर|a|b|andar|ander|bahar|bahr|अंदर|बाहर)$/i);
      if (sideOnlyMatch) {
        const sLow = line.toLowerCase();
        const isABSide = /ab|ba|\/|andar.*bahar|अंदर.*बाहर/.test(sLow);
        const isASide = !isABSide && /^(?:a|andar|ander|अंदर)$/i.test(sLow);
        const resolvedSide = isABSide ? 'AB' : isASide ? 'A' : 'B';
        if (recentDefaultHarufs.length > 0 && (resolvedSide === 'AB' || resolvedSide === 'A')) {
          // Previously parsed Haruf lines defaulted to Bahar ('B'); if trailing line says A/B, add the missing Andar ('A') side
          for (const hMeta of recentDefaultHarufs) {
            const extra = [];
            for (let k = 0; k <= 9; k++) {
              extra.push({ number: hMeta.digit === 0 && k === 0 ? 100 : hMeta.digit * 10 + k, amount: hMeta.perJodi });
            }
            results.push(...extra);
            specialPreviews.push({
              kind: 'haruf',
              raw: `${hMeta.digit} (Andar from A/B)`,
              count: extra.length,
              perAmt: hMeta.perJodi,
              total: extra.reduce((s, x) => s + x.amount, 0),
              items: [...extra].sort((a, b) => a.number - b.number),
            });
          }
          recentDefaultHarufs = [];
          continue;
        }
        pendingHarufSide = resolvedSide;
        continue;
      }
    }

    // Check for Haruf line (A=Andar, B=Bahar, AB=Both, amount/10 per jodi)
    // Also split multi-side Haruf on the same line (e.g. "A /111/100    B. /111/100")
    const multiHarufParts = line.split(/(?=(?:^|\s)[AB]\s*[./]\s*\d+)/i).map((s) => s.trim()).filter(Boolean);
    const harufPartsToTry = multiHarufParts.length > 1 ? multiHarufParts : [line];
    let handledAsHaruf = false;
    for (const hPart of harufPartsToTry) {
      const harufEntries = tryParseHarufLine(hPart, pendingHarufSide || 'B', Boolean(pendingHarufSide));
      if (harufEntries !== null) {
        handledAsHaruf = true;
        pendingNumbers = [];
        pendingRawLines = [];
        if (harufEntries.length > 0) {
          results.push(...harufEntries);
          const hTotal = harufEntries.reduce((s, x) => s + x.amount, 0);
          specialPreviews.push({
            kind: 'haruf',
            raw: harufPartsToTry.length > 1 ? hPart : originalLine,
            count: harufEntries.length,
            perAmt: harufEntries[0].amount,
            total: hTotal,
            items: [...harufEntries].sort((a, b) => a.number - b.number),
          });
          // If this line had no explicit A/B and no pendingHarufSide, remember it in case a trailing "A/B" follows
          const hadOwnSide =
            /(?:^|[\s.,(/]|\d)(?:ab|ba|a\s*\/\s*b|b\s*\/\s*a)(?:$|[\s.,)/=(])/i.test(hPart) ||
            /\b(?:andar|ander|bahar|bahr)\b/i.test(hPart) ||
            /(?:अंदर|बाहर)/.test(hPart) ||
            /(?:^|[\s.,])(?:[AB][\s.,]*\d|\d[\s.,]*[AB])(?:$|[\s.,(/\d])/i.test(hPart);
          if (!hadOwnSide && !pendingHarufSide) {
            const dSet = new Set(
              harufEntries.map((x) => {
                const s = String(x.number === 100 ? '00' : x.number).padStart(2, '0');
                return parseInt(s[1], 10);
              })
            );
            for (const d of dSet) {
              recentDefaultHarufs.push({ digit: d, perJodi: harufEntries[0].amount });
            }
          }
        } else {
          failed.push({ rawLine: originalLine, reason: 'हरूफ में अंक या अमाउंट नहीं मिला' });
        }
      }
    }
    if (handledAsHaruf) continue;
    recentDefaultHarufs = [];
    pendingHarufSide = null;

    // Detect Palat modifiers on this line before cleaning
    let separatePalatAmt = null;
    let hasSamePalat = false;
    line = line.replace(/\.{2,}$/, '').trim();

    const sepPalatMatch = line.match(
      /(?:\b|(?<=\d))(?:with\s+)?(?:palat|palti|palt|plt|ptl|p)(?:\b|(?=\d|\())\s*(?:into|intu|ento|in|rs|@|=|×|x)?\s*[.=*:\s(]*(\d+(?:\.\d+)?)\)?(?:\s*(?:into|intu|ento|rs))?/i
    );
    const hasPalatKeyword =
      /(?:\b|(?<=\d))(?:with\s+palat|palt\s*k\s*sath|palat\s*ke\s*sath|palat|palti|palt|plt|ptl|wp)(?:\b|(?=\d))/i.test(line) ||
      Boolean(sepPalatMatch);

    if (hasPalatKeyword) {
      if (sepPalatMatch) {
        const beforePalat = line.slice(0, sepPalatMatch.index);
        if (/(?:into|intu|ento|in|rs|r|@|=|\(|\*|\/)\s*\d+/i.test(beforePalat)) {
          separatePalatAmt = parseFloat(sepPalatMatch[1]);
          line = beforePalat.trim();
        } else if (!/\d/.test(beforePalat) && pendingNumbers.length === 0 && lastBatchNums.length > 0) {
          const pAmt = parseFloat(sepPalatMatch[1]);
          if (pAmt > 0) {
            for (const n of lastBatchNums) {
              const rev = getPalatNumber(n);
              if (rev !== null) results.push({ number: rev, amount: pAmt });
            }
          }
          continue;
        } else {
          hasSamePalat = true;
          line = line.replace(/(?:\b|(?<=\d))(?:with\s+)?(?:palat|palti|palt|plt|ptl)(?:\b|(?=\d))/gi, 'into').trim();
        }
      } else {
        hasSamePalat = true;
        line = line
          .replace(/(?:\b|(?<=\d))(?:with\s+palat|palt\s*k\s*sath|palat\s*ke\s*sath|palat|palti|palt|plt|ptl|wp)(?:\b|(?=\d))/gi, ' ')
          .trim();
        if (!line && lastBatchNums.length > 0 && lastBatchAmt > 0) {
          for (const n of lastBatchNums) {
            const rev = getPalatNumber(n);
            if (rev !== null) results.push({ number: rev, amount: lastBatchAmt });
          }
          continue;
        }
      }
    }

    // 2. Clean common noise words & currency symbols
    const dividerAmtMatch = line.match(/^\d?\s*_{3,}\s*\d?\s+(\d+(?:\.\d+)?)$/);
    if (dividerAmtMatch && pendingNumbers.length > 0) {
      const amt = parseFloat(dividerAmtMatch[1]);
      const combined = [...pendingNumbers];
      pendingNumbers = [];
      pendingRawLines = [];
      if (amt > 0) {
        pushEntries(combined, amt, separatePalatAmt ?? (hasSamePalat ? amt : 0));
      }
      continue;
    }

    const repeatedAmtMatch = line.match(
      /^\s*(\d+(?:\.\d+)?)\s*[.\-_*=,\s]{2,}\1(?:\s*(?:into|intu|ento|intoo|rs\.?|inr|₹))?\s*$/i
    );
    if (repeatedAmtMatch && pendingNumbers.length > 0) {
      const amt = parseFloat(repeatedAmtMatch[1]);
      const combined = [...pendingNumbers];
      pendingNumbers = [];
      pendingRawLines = [];
      if (amt > 0) {
        pushEntries(combined, amt, separatePalatAmt ?? (hasSamePalat ? amt : 0));
      }
      continue;
    }

    if (/^game\s*[.\s:=]*\d+(?:\.\d+)?\s*(?:rs\.?|inr|₹|\/-)?\s*$/i.test(line)) {
      continue;
    }

    let cleaned = line
      .replace(/[₹]/g, ' ')
      .replace(
        /(^|[\s,=*\-/.])(\d+(?:\.\d+)?)[,\s.*]*(?:into|intu|ento|intoo|nitu|rs\.?|inr|rupe|rupay|rupy)\s*[/\-.,]*\s*$/i,
        '$1 into $2'
      )
      .replace(/\bF\b|\bm\b/gi, ' ')
      .replace(/\b(?:rs\.?|inr)(?!\s*[.=*:\s,(]*\d)\b|\b(?:rupy|ru|ki|ka|me|mai|mein|se|tak|ok|okk|ookk|clear)\b/gi, ' ')
      .replace(/\/-/g, ' ')
      .replace(/\]/g, ')')
      .replace(/\)+/g, ')')
      .replace(/\(+/g, '(')
      // Strip trailing "=lineTotal" or "Rs=340"
      .replace(/\s*\brs\s*=\s*\d+(?:\.\d+)?\s*$/i, '')
      // Strip trailing "=lineTotal" when an amount operator (into/@/*/paren) already precedes it (e.g. "17 71 into 50=100", "(83 38)*15=60", "94*@50=50")
      .replace(/^(.+?(?:into|intu|ento|intoo|in|@|\*|\))\s*[.=*:\s]*\d+(?:\.\d+)?)\s*=\s*\d+(?:\.\d+)?\s*$/i, '$1')
      // Normalize "(nums)*amt" into "nums into amt"
      .replace(/^\(([\d\s.,/_+\-\\*]+)\)\s*\*\s*(\d+(?:\.\d+)?)\s*$/, '$1 into $2')
      // Strip orphan trailing "into" with no amount after it (e.g. "39.93.49.94..into")
      .replace(/[.\s]*(?:into|intu|ento|intoo)\s*$/i, '')
      // Normalize "into (370" / "into.(10" -> "into 370" / "into 10" so parenGroups never eats it
      .replace(/\b(into|intu|ento|intoo|rupe|rupay|rs|@)\s*[.=*:\s]*\(\s*(\d+(?:\.\d+)?)\s*\)?\s*$/gi, ' $1 $2')
      .replace(/\.+$/, '')
      .trim();

    if (!cleaned) continue;

    // 2a. Multiple "nums ... R/rs ... amt" segments on one line (e.g. "F,, 95,,,R,,,50" or "68.rs.125. 18.81.rs 75")
    if (/\b(?:R|rs)\b/i.test(cleaned)) {
      const rMatches = [...cleaned.matchAll(/([\d\s.,]+?)\s*[.,\s]*\b(?:R|rs)\b\s*[,.\s]*(\d+(?:\.\d+)?)/gi)];
      if (rMatches.length >= 2) {
        pendingNumbers = [];
        pendingRawLines = [];
        for (const rm of rMatches) {
          const nums = extractJodiList(rm[1]);
          const amt = parseFloat(rm[2]);
          if (nums.length > 0 && amt > 0) {
            pushEntries(nums, amt, separatePalatAmt ?? (hasSamePalat ? amt : 0));
          }
        }
        continue;
      }
    }

    // 2b. Multiple inline "num=amt" pairs on a single line (e.g. "02=10 12=10 ... 92=10")
    // Skip chained "59=99=09=75" or "11=61=71===35" so sepMatch assigns the last amount to all numbers
    const isChainedEquals = /\d\s*=+\s*\d+\s*=+\s*\d/.test(cleaned);
    const inlinePairs = isChainedEquals ? [] : [...cleaned.matchAll(/\b(\d{1,3})\s*=\s*(\d+(?:\.\d+)?)\b/g)];
    if (inlinePairs.length >= 2 && /^[\d\s=.,]+$/.test(cleaned)) {
      pendingNumbers = [];
      pendingRawLines = [];
      for (const pair of inlinePairs) {
        const num = normalizeJodiNumber(pair[1]);
        const amt = parseFloat(pair[2]);
        if (num !== null && amt > 0) {
          pushEntries([num], amt, separatePalatAmt ?? (hasSamePalat ? amt : 0));
        }
      }
      continue;
    }

    // 2c. Handle repeated "101010,,101010,,1010" or paired "10101030" amount-only lines when previous line had pending jodis
    if (/^(?:10){2,}(?:[,.\s]+(?:10){2,})*$/.test(cleaned) && pendingNumbers.length > 0) {
      const combined = [...pendingNumbers];
      pendingNumbers = [];
      pendingRawLines = [];
      pushEntries(combined, 10, separatePalatAmt ?? (hasSamePalat ? 10 : 0));
      continue;
    }
    if (/^\d{4,16}$/.test(cleaned) && cleaned.length % 2 === 0 && pendingNumbers.length > 0 && cleaned.length / 2 === pendingNumbers.length) {
      const pairedAmts = cleaned.match(/.{2}/g).map((x) => parseInt(x, 10));
      if (pairedAmts.every((a) => a > 0)) {
        for (let pi = 0; pi < pendingNumbers.length; pi++) {
          pushEntries([pendingNumbers[pi]], pairedAmts[pi], separatePalatAmt ?? (hasSamePalat ? pairedAmts[pi] : 0));
        }
        pendingNumbers = [];
        pendingRawLines = [];
        continue;
      }
    }

    // 3. Inline "(amount)" groups (supports (10*), (30r), (100rs into), (200 nitu), (100)=200, 26=(100), (20.), and unclosed trailing "(300")
    const parenGroups = [...cleaned.matchAll(/([\d\s.,/_+\-\\*!&=]+?)\(\s*@?\s*(\d+(?:\.\d+)?)\s*\.?\s*(?:(?:\*|into|intu|ento|nitu|in|rs|r)\s*)*(?:\)|$)/gi)];
    if (parenGroups.length > 0) {
      let addedHere = false;
      for (const grp of parenGroups) {
        const nums = extractJodiList(grp[1]);
        const amt = parseFloat(grp[2]);
        const combined = [...pendingNumbers, ...nums];
        pendingNumbers = [];
        pendingRawLines = [];
        if (amt > 0 && combined.length > 0) {
          pushEntries(combined, amt, separatePalatAmt ?? (hasSamePalat ? amt : 0));
          addedHere = true;
        }
      }
      if (!addedHere && /\d/.test(line)) {
        failed.push({ rawLine: originalLine, reason: 'ब्रैकेट ग्रुप से जोड़ी या अमाउंट नहीं निकला' });
      }
      continue;
    }

    // 4. "nums ... into/intu/ento/in/R/rupe/@/× amount" (also supports "into (370", "into.(10", "Rs,10", "=into=35")
    const intoMatch = cleaned.match(
      /^(.*?)(?:into|intu|ento|intoo|nitu|int|in|rupe|rupay|rs|r|@|×|x)\s*[.=*:\s,(]*(\d+(?:\.\d+)?)\)?\s*$/i
    );
    if (intoMatch && !/^\d{1,3}\s*[-:=*#>x×/]+\s*\d+$/.test(cleaned)) {
      const nums = extractJodiList(intoMatch[1]);
      const amt = parseFloat(intoMatch[2]);
      const combined = [...pendingNumbers, ...nums];
      pendingNumbers = [];
      pendingRawLines = [];
      if (amt > 0 && combined.length > 0) {
        pushEntries(combined, amt, separatePalatAmt ?? (hasSamePalat ? amt : 0));
        continue;
      }
    }

    // Lookahead: if line is a multi-number list (e.g. "60*48*75*21*13" or "76=71=26=21=20=70" or "20.70.15") followed later by an amount line, buffer it instead of treating the last number as amount
    let deferToBuffer = false;
    const isDotOnlyJodiList = /^\d{2}(?:\.\d{2}){2,}$/.test(cleaned);
    const eqCount = (cleaned.match(/=/g) || []).length;
    if (isDotOnlyJodiList) {
      deferToBuffer = true;
    } else if (!/(?:\*\*|#|@|×)/.test(cleaned) && /^[\d\s.,/_+\-\\*=]+$/.test(cleaned) && eqCount !== 1) {
      const candidateNums = extractJodiList(cleaned);
      // Do not defer a simple single "num * amt" pair (like "05*50") just because a later line has "(20)"
      const isSingleStarPair = /^\d{1,3}\s*\*\s*\d+(?:\.\d+)?$/.test(cleaned);
      if (candidateNums.length >= 2 && !isSingleStarPair) {
        for (let k = i + 1; k < lines.length; k++) {
          const nxt = lines[k].trim();
          if (!nxt) continue;
          if (/^(?:total|tot|tol|ttl|tt|t|gt|टोटल|कुल)\b/i.test(nxt)) break;
          if (/(?:into|intu|ento|intoo|nitu|in|rs|r)\s*[.=*:\s,(]*\d+|\d+\s*(?:into|intu|ento|intoo|nitu)|#\s*\d+|\(\s*@?\s*\d+\s*(?:into|in|rs)?\s*(?:\)|$)/i.test(nxt)) {
            deferToBuffer = true;
            break;
          }
          if (!/^[\d\s.,/_+\-\\*=]+$/.test(nxt)) break;
        }
      }
    }

    // 5. Separator match (never treat ".NN" in a pure 2-digit dot list as a decimal rupee amount)
    const sepMatch = !deferToBuffer && cleaned.match(
      /^([\d\s.,/_+\-\\*=*#]+?)\s*(?:=\/+|=+|\*\*|\*|\/\/|\.\s*\/\s*\+|\/\+|\/|#|:|---|--|-|\+|,{2,}|\.+|@|×|x)\s*(\d+(?:\.\d+)?)$/i
    );
    if (sepMatch) {
      const nums = extractJodiList(sepMatch[1]);
      const amt = parseFloat(sepMatch[2]);
      const combined = [...pendingNumbers, ...nums];
      pendingNumbers = [];
      pendingRawLines = [];
      if (amt > 0 && combined.length > 0) {
        pushEntries(combined, amt, separatePalatAmt ?? (hasSamePalat ? amt : 0));
        continue;
      }
    }

    // 6. Simple single pair "23 100"
    const nextLine = (lines[i + 1] || '').trim();
    const nextIsAmountOnly =
      /^(?:into|intu|ento|intoo|int|in|rs|r|@|×|x)\s*[.=*:\s]*\d+/i.test(nextLine) ||
      /^\(\s*@?\s*(?:into|intu|ento|in|rs)?\s*\d+(?:\.\d+)?\s*(?:into|in|rs)?\s*\)$/i.test(nextLine);
    const singleSpaceMatch = !deferToBuffer && !nextIsAmountOnly && cleaned.match(/^(\d{1,3})\s+(\d+(?:\.\d+)?)$/);
    if (singleSpaceMatch) {
      const num = normalizeJodiNumber(singleSpaceMatch[1]);
      const amt = parseFloat(singleSpaceMatch[2]);
      if (num !== null && amt > 0) {
        const combined = [...pendingNumbers, num];
        pendingNumbers = [];
        pendingRawLines = [];
        pushEntries(combined, amt, separatePalatAmt ?? (hasSamePalat ? amt : 0));
        continue;
      }
    }

    // 7. Buffer pure number lines for next line's "into X"
    const strippedWords = cleaned.replace(/[\p{L}\p{M}]+/gu, ' ').trim();
    if (strippedWords && /^[\d\s.,/_+\-\\*=!&:]+$/.test(strippedWords)) {
      const buffered = extractJodiList(strippedWords);
      if (buffered.length > 0) {
        pendingNumbers.push(...buffered);
        pendingRawLines.push(originalLine);
        pendingLineRefs.push({ lbIndex: lineBreakdown.length - 1, numCount: buffered.length });
        continue;
      }
    }

    // Line had digits but matched no known pattern -> record as failed pattern
    if (/\d/.test(line)) {
      failed.push({ rawLine: originalLine, reason: 'पैटर्न पार्स नहीं हो सका' });
    }
    } finally {
      const addedItems = results.slice(startResIdx);
      if (addedItems.length > 0) {
        lbEntry.count = addedItems.length;
        lbEntry.total = addedItems.reduce((s, x) => s + x.amount, 0);
        lbEntry.status = 'parsed';
        if (pendingLineRefs.length > 0 && pendingNumbers.length === 0) {
          for (const ref of pendingLineRefs) {
            if (lineBreakdown[ref.lbIndex]) {
              lineBreakdown[ref.lbIndex].status = 'included';
              lineBreakdown[ref.lbIndex].note = `${ref.numCount} nos → below`;
            }
          }
          pendingLineRefs = [];
        }
      } else if (pendingNumbers.length > startPendingCount) {
        lbEntry.status = 'buffered';
        lbEntry.note = `${pendingNumbers.length - startPendingCount} nos (pending)`;
      } else if (failed.length > startFailedCount) {
        lbEntry.status = 'failed';
      } else if (pendingNumbers.length === 0 && pendingLineRefs.length > 0) {
        pendingLineRefs = [];
      }
    }
  }

  // If buffered number lines had no following amount line, record them as failed
  if (pendingNumbers.length > 0 && pendingRawLines.length > 0) {
    failed.push({
      rawLine: pendingRawLines.join(' | '),
      reason: 'नंबर के बाद अमाउंट (into/=/Rs) नहीं मिला',
    });
    for (const ref of pendingLineRefs) {
      if (lineBreakdown[ref.lbIndex]) {
        lineBreakdown[ref.lbIndex].status = 'failed';
        lineBreakdown[ref.lbIndex].note = 'No amount';
      }
    }
  }

  return { results, normalResults, specialPreviews, failed, lineBreakdown };
}

function extractDeclaredTotal(raw) {
  if (!raw) return null;
  const matches = [
    ...raw.matchAll(
      /(?:टोटल|कुल|grand\s*total|total|tot|ttl|sum|\bto\.|\bt)\s*[-:=*>₹.\s]*(\d+(?:\.\d+)?)/gi
    ),
  ];
  if (matches.length === 0) return null;
  const last = parseFloat(matches[matches.length - 1][1]);
  return Number.isFinite(last) && last > 0 ? last : null;
}

function parseWhatsAppText(raw) {
  return analyzeWhatsAppText(raw).results;
}

const THEMES = {
  dark: {
    frameBg: '#0b141a',
    frameBorder: '#222e35',
    headerBg: '#202c33',
    cardBg: '#182229',
    cardBorder: '#2a3942',
    inputBg: '#2a3942',
    textPrimary: '#e9edef',
    textSecondary: '#8696a0',
    textMuted: '#667781',
    accent: '#00a884',
    accentSoft: 'rgba(0, 168, 132, 0.16)',
    accentText: '#25d366',
    tabActiveBg: '#005c4b',
    tabActiveBorder: '#00a884',
    lockBadgeBg: 'rgba(245, 158, 11, 0.16)',
    lockBadgeBorder: '#f59e0b',
    lockBadgeText: '#fcd34d',
  },
  light: {
    frameBg: '#efeae2',
    frameBorder: '#d1d7db',
    headerBg: '#ffffff',
    cardBg: '#ffffff',
    cardBorder: '#e2e8f0',
    inputBg: '#f0f2f5',
    textPrimary: '#111b21',
    textSecondary: '#54656f',
    textMuted: '#667781',
    accent: '#00a884',
    accentSoft: 'rgba(0, 168, 132, 0.12)',
    accentText: '#008069',
    tabActiveBg: '#008069',
    tabActiveBorder: '#006e5a',
    lockBadgeBg: '#fef3c7',
    lockBadgeBorder: '#f59e0b',
    lockBadgeText: '#b45309',
  },
};

export default function App() {
  const [activeCategory, setActiveCategory] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.CATEGORY);
    return CATEGORIES.includes(saved) ? saved : 'DB';
  });

  // Default to locked on activeCategory so work stays safely in one category
  const [isLocked, setIsLocked] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.LOCKED);
    return saved === null ? true : saved === 'true';
  });

  const [entries, setEntries] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.ENTRIES);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [inputText, setInputText] = useState('');

  const [columns, setColumns] = useState(() => {
    const saved = parseInt(localStorage.getItem(STORAGE_KEYS.COLUMNS) || '5', 10);
    return saved === 10 ? 10 : 5;
  });

  const [themeMode, setThemeMode] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.THEME);
    return saved === 'light' ? 'light' : 'dark';
  });

  const [selectedBox, setSelectedBox] = useState(null);
  const [expandedJodi, setExpandedJodi] = useState(null);
  const [expandedEntryId, setExpandedEntryId] = useState(null);
  const [historyCategoryFilter, setHistoryCategoryFilter] = useState(null); // null => activeCategory | 'ALL' | cat
  const [historyWhatsAppPopup, setHistoryWhatsAppPopup] = useState(null);
  const [jodiRatePer10, setJodiRatePer10] = useState(() => {
    const n = Number(localStorage.getItem('sunny_jodi_rate_v1') || '950');
    return Number.isFinite(n) && n > 0 ? n : 950;
  });
  const [gameResults, setGameResults] = useState(() => {
    try {
      const raw = localStorage.getItem('sunny_game_results_v1');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [plHistory, setPlHistory] = useState(() => {
    try {
      const raw = localStorage.getItem('sunny_pl_history_v1');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [plTab, setPlTab] = useState('today'); // 'today' | 'final'
  const [plGameFilter, setPlGameFilter] = useState('ALL');
  const [plCopied, setPlCopied] = useState(false);
  const [batchSources, setBatchSources] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.BATCH_SOURCES);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [pendingConfirm, setPendingConfirm] = useState(null); // { results, failed, sourceLabel, rawText }
  const [quickBoxAmount, setQuickBoxAmount] = useState('');
  const [toolsView, setToolsView] = useState(null); // null | 'menu' | 'moti_jodi' | 'share_image' | 'failed_patterns'
  const [failedPatterns, setFailedPatterns] = useState(() => {
    try {
      const raw = localStorage.getItem('sunny_tracker_failed_patterns_v1');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [motiMinAmount, setMotiMinAmount] = useState(0);
  const [minAmountFilter, setMinAmountFilter] = useState(0);
  const [filterMode, setFilterMode] = useState('min'); // 'min' (>=) | 'exact' (===)
  const [splitPart, setSplitPart] = useState('selected'); // 'selected' | 'remaining'
  const [customMinFilter, setCustomMinFilter] = useState('');
  const [cutApplied, setCutApplied] = useState(false); // 0 = all, 300 = 30K (1%), 1000 = 1L (1%)
  const [chartOwnerName, setChartOwnerName] = useState(() => localStorage.getItem('sunny_tracker_owner_v1') || 'Sunny');
  const [chartImageUrl, setChartImageUrl] = useState('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);
  const [gameTarget] = useState(30000);
  const [autoPasteEnabled, setAutoPasteEnabled] = useState(
    () => localStorage.getItem('sunny_tracker_auto_paste_v1') !== 'false'
  );
  const [syncRoomId, setSyncRoomId] = useState(
    () => localStorage.getItem('sunny_tracker_sync_room_v2') || DEFAULT_SYNC_ROOM
  );
  const [syncEnabled, setSyncEnabled] = useState(
    () => localStorage.getItem('sunny_tracker_sync_v2_enabled') !== 'false'
  );
  const [syncStatus, setSyncStatus] = useState('off'); // 'off' | 'connecting' | 'live' | 'error'
  const [connectedCount, setConnectedCount] = useState(1);
  const [lastSyncTime, setLastSyncTime] = useState('');
  const peersRef = useRef(new Map());
  const [deviceId] = useState(() => {
    let id = localStorage.getItem('sunny_tracker_device_id_v1');
    if (!id) {
      id = `dev-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem('sunny_tracker_device_id_v1', id);
    }
    return id;
  });
  const deletedIdsRef = useRef((() => {
    try {
      const raw = localStorage.getItem('sunny_tracker_deleted_ids_v1');
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  })());
  const categoryClearAtRef = useRef((() => {
    try {
      const raw = localStorage.getItem('sunny_tracker_cat_clear_at_v1');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  })());
  const skipNextPushRef = useRef(false);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const [toast, setToast] = useState('');
  const [copied, setCopied] = useState(false);

  const t = THEMES[themeMode];

  // Persist every piece of state locally
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.ENTRIES, JSON.stringify(entries));
      localStorage.setItem(STORAGE_KEYS.CATEGORY, activeCategory);
      localStorage.setItem(STORAGE_KEYS.LOCKED, String(isLocked));
      localStorage.setItem(STORAGE_KEYS.DRAFT, inputText);
      localStorage.setItem(STORAGE_KEYS.COLUMNS, String(columns));
      localStorage.setItem(STORAGE_KEYS.THEME, themeMode);
      localStorage.setItem(STORAGE_KEYS.BATCH_SOURCES, JSON.stringify(batchSources));
      localStorage.setItem('sunny_jodi_rate_v1', String(jodiRatePer10));
      localStorage.setItem('sunny_game_results_v1', JSON.stringify(gameResults));
      localStorage.setItem('sunny_pl_history_v1', JSON.stringify(plHistory));
      localStorage.setItem('sunny_tracker_owner_v1', chartOwnerName);
      localStorage.setItem('sunny_tracker_failed_patterns_v1', JSON.stringify(failedPatterns));
      const backupPayload = JSON.stringify(
        {
          parserVersion: PARSER_VERSION,
          updatedAt: new Date().toISOString(),
          syncRoomId,
          totalEntries: entries.length,
          failedPatterns,
        },
        null,
        2
      );
      window.SunnyNativeBridge?.saveFailedPatternsJson?.(backupPayload);
      localStorage.setItem('sunny_tracker_auto_paste_v1', String(autoPasteEnabled));
      window.SunnyNativeBridge?.setAutoEnabled?.(autoPasteEnabled);
      localStorage.setItem('sunny_tracker_sync_room_v2', syncRoomId);
      localStorage.setItem('sunny_tracker_sync_v2_enabled', String(syncEnabled));
    } catch {
      // ignore storage quota errors
    }
  }, [entries, activeCategory, isLocked, inputText, columns, themeMode, chartOwnerName, failedPatterns, autoPasteEnabled, syncRoomId, syncEnabled]);

  // Free 4-Phone Live Sync via ntfy.sh (₹0, no account, real-time SSE + poll)
  const cleanSyncTopic = useMemo(() => {
    const cleaned = syncRoomId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return cleaned ? `sunny_jnt_${cleaned}` : '';
  }, [syncRoomId]);

  const persistSyncMeta = () => {
    try {
      localStorage.setItem('sunny_tracker_deleted_ids_v1', JSON.stringify([...deletedIdsRef.current].slice(-2000)));
      localStorage.setItem('sunny_tracker_cat_clear_at_v1', JSON.stringify(categoryClearAtRef.current));
    } catch {
      // ignore
    }
  };

  const pendingPushRef = useRef(false);

  const mergeRemoteSyncPayload = (payload) => {
    if (!payload) return false;
    if (payload.senderId) {
      const msgTs = Number(payload.sentAt) || Date.now();
      const prevTs = peersRef.current.get(payload.senderId) || 0;
      if (msgTs > prevTs) {
        peersRef.current.set(payload.senderId, msgTs);
      }
      const now = Date.now();
      let active = 1; // include self
      for (const [pid, ts] of peersRef.current.entries()) {
        if (pid !== deviceId && now - ts < 120000) active++;
      }
      setConnectedCount(active);
    }
    if (payload.type !== 'SUNNY_SYNC_V1' || payload.senderId === deviceId) return false;
    let changed = false;

    if (Array.isArray(payload.deletedIds)) {
      for (const id of payload.deletedIds) {
        if (!deletedIdsRef.current.has(id)) {
          deletedIdsRef.current.add(id);
          changed = true;
        }
      }
    }

    if (payload.categoryClearAt && typeof payload.categoryClearAt === 'object') {
      for (const cat of CATEGORIES) {
        const remoteTs = Number(payload.categoryClearAt[cat] || 0);
        const localTs = Number(categoryClearAtRef.current[cat] || 0);
        if (remoteTs > localTs) {
          categoryClearAtRef.current[cat] = remoteTs;
          changed = true;
        }
      }
    }

    const byId = new Map();
    for (const item of entriesRef.current) {
      byId.set(item.id, item);
    }
    const remoteIds = new Set();
    const prevCount = byId.size;
    if (Array.isArray(payload.entries)) {
      for (const item of payload.entries) {
        if (item && item.id) {
          remoteIds.add(item.id);
          if (!byId.has(item.id)) {
            byId.set(item.id, item);
          }
        }
      }
    }

    const filtered = [...byId.values()].filter((item) => {
      if (deletedIdsRef.current.has(item.id)) return false;
      const clearTs = Number(categoryClearAtRef.current[item.category] || 0);
      if (clearTs > 0 && Number(item.createdAt || 0) <= clearTs) return false;
      return true;
    });

    const localHasExtra = filtered.some((item) => !remoteIds.has(item.id));
    if (localHasExtra) {
      setTimeout(() => pushSyncSnapshot(filtered), 400);
    }

    if (changed || byId.size !== prevCount || filtered.length !== entriesRef.current.length) {
      filtered.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      skipNextPushRef.current = true;
      setEntries(filtered);
      persistSyncMeta();
      setLastSyncTime(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
      return true;
    }
    return false;
  };

  const mqttClientRef = useRef(null);
  const lastCatSyncAtRef = useRef(0);
  const skipNextCatPushRef = useRef(false);

  const pushSyncSnapshot = async (customEntries) => {
    if (!syncEnabled || !cleanSyncTopic) return;
    try {
      const body = JSON.stringify({
        type: 'SUNNY_SYNC_V1',
        senderId: deviceId,
        sentAt: Date.now(),
        entries: customEntries || entriesRef.current,
        deletedIds: [...deletedIdsRef.current].slice(-2000),
        categoryClearAt: categoryClearAtRef.current,
      });
      if (mqttClientRef.current && mqttClientRef.current.connected) {
        mqttClientRef.current.publish(`${cleanSyncTopic}/sync`, body, { retain: true, qos: 0 });
        pendingPushRef.current = false;
      } else {
        pendingPushRef.current = true;
      }
      setLastSyncTime(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
    } catch {
      pendingPushRef.current = true;
    }
  };

  const pullSyncHistory = async (showNotice = false) => {
    if (!cleanSyncTopic) return;
    try {
      if (mqttClientRef.current && mqttClientRef.current.connected) {
        mqttClientRef.current.publish(
          `${cleanSyncTopic}/dev/${deviceId}`,
          JSON.stringify({ type: 'SUNNY_PING_V1', senderId: deviceId, sentAt: Date.now() }),
          { retain: true, qos: 0 }
        );
        mqttClientRef.current.subscribe([`${cleanSyncTopic}/sync`, `${cleanSyncTopic}/dev/+`]);
        if (syncEnabled) setSyncStatus('live');
        if (showNotice) {
          showToast(`🔄 Sync refreshed (Connected: ${connectedCount})`);
        }
        return;
      }
      if (showNotice) showToast('कनेक्ट हो रहा है, कृपया 2 सेकंड रुकें');
    } catch {
      if (showNotice) showToast('Check internet connection');
    }
  };

  // Push local entry changes automatically when sync is ON
  useEffect(() => {
    if (!syncEnabled || !cleanSyncTopic) return;
    if (skipNextPushRef.current) {
      skipNextPushRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      pushSyncSnapshot(entries);
    }, 250);
    return () => clearTimeout(timer);
  }, [entries, syncEnabled, cleanSyncTopic]);

  // Real-time SSE listener + 24/7 native background service sync
  const prevSyncEnabledRef = useRef(syncEnabled);
  useEffect(() => {
    if (!syncEnabled || !cleanSyncTopic) {
      setSyncStatus('off');
      if (prevSyncEnabledRef.current) {
        window.SunnyNativeBridge?.stopBackgroundSync?.();
      }
      prevSyncEnabledRef.current = false;
      return;
    }
    prevSyncEnabledRef.current = true;
    setSyncStatus('connecting');
    window.SunnyNativeBridge?.startBackgroundSync?.(cleanSyncTopic, deviceId);

    window.receiveSunnySyncPayload = (rawPayload) => {
      try {
        const payload = JSON.parse(rawPayload);
        mergeRemoteSyncPayload(payload);
        setSyncStatus('live');
        return 'OK';
      } catch {
        return 'ERR';
      }
    };

    try {
      const pendingBg = window.SunnyNativeBridge?.consumePendingBackgroundSync?.();
      if (pendingBg) {
        window.receiveSunnySyncPayload(pendingBg);
      }
    } catch {
      // ignore
    }

    pullSyncHistory(false);

    const sendHeartbeat = () => {
      try {
        if (mqttClientRef.current && mqttClientRef.current.connected) {
          mqttClientRef.current.publish(
            `${cleanSyncTopic}/dev/${deviceId}`,
            JSON.stringify({ type: 'SUNNY_PING_V1', senderId: deviceId, sentAt: Date.now() }),
            { retain: true, qos: 0 }
          );
          setSyncStatus('live');
        }
      } catch {
        // ignore
      }
    };

    const client = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
      clientId: `sunny_web_${deviceId}_${Math.random().toString(16).slice(2, 6)}`,
      clean: true,
      reconnectPeriod: 3000,
      connectTimeout: 10000,
    });
    mqttClientRef.current = client;

    client.on('connect', () => {
      setSyncStatus('live');
      client.subscribe([`${cleanSyncTopic}/sync`, `${cleanSyncTopic}/dev/+`, `${cleanSyncTopic}/category`]);
      sendHeartbeat();
      setTimeout(() => {
        if (pendingPushRef.current && entriesRef.current.length > 0) {
          pushSyncSnapshot(entriesRef.current);
        }
      }, 1200);
    });

    client.on('reconnect', () => setSyncStatus('connecting'));
    client.on('error', () => setSyncStatus('error'));

    client.on('message', (_topic, messageBuf) => {
      try {
        const payload = JSON.parse(messageBuf.toString());
        if (payload && payload.type === 'SUNNY_CAT_V1') {
          if (
            payload.senderId !== deviceId &&
            CATEGORIES.includes(payload.category) &&
            Number(payload.sentAt || 0) > lastCatSyncAtRef.current
          ) {
            lastCatSyncAtRef.current = Number(payload.sentAt);
            skipNextCatPushRef.current = true;
            setActiveCategory(payload.category);
            if (typeof payload.isLocked === 'boolean') setIsLocked(payload.isLocked);
            showToast(`🔄 Switched to ${payload.category}`);
          }
          return;
        }
        if (mergeRemoteSyncPayload(payload)) {
          showToast('🟢 New data synced from another phone');
        }
      } catch {
        // ignore non-json messages
      }
    });

    const hbInterval = setInterval(() => {
      sendHeartbeat();
      const now = Date.now();
      let active = 1;
      for (const [pid, ts] of peersRef.current.entries()) {
        if (pid !== deviceId && now - ts < 120000) active++;
      }
      setConnectedCount(active);
    }, 35000);

    const handleResumeSync = () => {
      if (document.visibilityState === 'visible') {
        try {
          const pendingBg = window.SunnyNativeBridge?.consumePendingBackgroundSync?.();
          if (pendingBg) {
            window.receiveSunnySyncPayload?.(pendingBg);
          }
        } catch {
          // ignore
        }
        sendHeartbeat();
      }
    };
    document.addEventListener('visibilitychange', handleResumeSync);
    window.addEventListener('focus', handleResumeSync);

    return () => {
      clearInterval(hbInterval);
      document.removeEventListener('visibilitychange', handleResumeSync);
      window.removeEventListener('focus', handleResumeSync);
      try {
        client.end(true);
      } catch {
        // ignore
      }
      mqttClientRef.current = null;
      delete window.receiveSunnySyncPayload;
    };
  }, [syncEnabled, cleanSyncTopic]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };

  const categoryTotals = useMemo(() => {
    const map = {};
    for (const c of CATEGORIES) map[c] = 0;
    for (const e of entries) {
      if (map[e.category] !== undefined) {
        map[e.category] += e.amount;
      }
    }
    return map;
  }, [entries]);

  const grandTotal = useMemo(
    () => Object.values(categoryTotals).reduce((a, b) => a + b, 0),
    [categoryTotals]
  );

  const boxTotals = useMemo(() => {
    const totals = Array(101).fill(0);
    for (const e of entries) {
      if (e.category === activeCategory && e.number >= 1 && e.number <= 100) {
        totals[e.number] += e.amount;
      }
    }
    return totals;
  }, [entries, activeCategory]);

  // Highest to Lowest ranking ("सबसे मोटा" -> "उससे नीचे" -> "Lowest") in active category
  const { maxAmount, minAmount, highestNumbers, rankedList, tierByAmount } = useMemo(() => {
    const active = [];
    for (let i = 1; i <= 100; i++) {
      if (boxTotals[i] > 0) {
        active.push({ number: i, amount: boxTotals[i] });
      }
    }
    if (active.length === 0) {
      return {
        maxAmount: 0,
        minAmount: 0,
        highestNumbers: [],
        rankedList: [],
        tierByAmount: {},
      };
    }

    // Sort descending by amount, then ascending by number
    active.sort((a, b) => b.amount - a.amount || a.number - b.number);

    // Distinct amount levels from highest to lowest
    const uniqueAmounts = [...new Set(active.map((x) => x.amount))];
    const tierMap = {};
    uniqueAmounts.forEach((amt, idx) => {
      if (idx === 0) tierMap[amt] = 'top'; // सबसे मोटा (#1)
      else if (idx === uniqueAmounts.length - 1 && uniqueAmounts.length >= 2)
        tierMap[amt] = 'lowest'; // Lowest
      else if (idx === 1) tierMap[amt] = 'second'; // उससे नीचे (#2)
      else if (idx === 2) tierMap[amt] = 'third'; // उससे नीचे (#3)
      else tierMap[amt] = 'mid';
    });

    const max = uniqueAmounts[0];
    const min = uniqueAmounts[uniqueAmounts.length - 1];
    const topNums = active.filter((x) => x.amount === max).map((x) => x.number);

    return {
      maxAmount: max,
      minAmount: min,
      highestNumbers: topNums,
      rankedList: active,
      tierByAmount: tierMap,
    };
  }, [boxTotals]);

  const publishCategoryState = (cat, locked) => {
    if (!syncEnabled || !cleanSyncTopic) return;
    if (mqttClientRef.current && mqttClientRef.current.connected) {
      const now = Date.now();
      lastCatSyncAtRef.current = now;
      mqttClientRef.current.publish(
        `${cleanSyncTopic}/category`,
        JSON.stringify({
          type: 'SUNNY_CAT_V1',
          senderId: deviceId,
          category: cat,
          isLocked: locked,
          sentAt: now,
        }),
        { retain: true, qos: 0 }
      );
    }
  };

  // Keep 24/7 live notification + Heliboard MQTT stats updated with Locked Game, Highest Jodi & Total
  useEffect(() => {
    try {
      const catTot = categoryTotals[activeCategory] || 0;
      const top = rankedList[0];
      const topText = top
        ? `👑 ${String(top.number).padStart(2, '0')} (₹${top.amount.toLocaleString('en-IN')})`
        : '👑 —';
      const lockIcon = isLocked ? '🔒' : '🔓';
      const summary = `${lockIcon} ${activeCategory}: ₹${catTot.toLocaleString('en-IN')} • ${topText}`;
      window.SunnyNativeBridge?.updateLiveNotificationStats?.(summary);
      if (syncEnabled && cleanSyncTopic && mqttClientRef.current && mqttClientRef.current.connected) {
        mqttClientRef.current.publish(
          `${cleanSyncTopic}/stats`,
          JSON.stringify({ summary, category: activeCategory, updatedAt: Date.now() }),
          { retain: true, qos: 0 }
        );
      }
    } catch {
      // ignore
    }
  }, [activeCategory, isLocked, categoryTotals, rankedList, syncEnabled, cleanSyncTopic]);

  const categoryEntries = useMemo(() => {
    return entries
      .filter((e) => e.category === activeCategory)
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [entries, activeCategory]);

  // Entry-level 2-part split: separates individual entries (e.g. two ₹100 entries on 01 => 01=₹200 in Upper, while ₹20+₹10 on 01 => 01=₹30 in Lower)
  const cutSplitData = useMemo(() => {
    if (minAmountFilter <= 0) return null;
    const upperBoxTotals = Array(101).fill(0);
    const lowerBoxTotals = Array(101).fill(0);
    for (const ent of categoryEntries) {
      const num = ent.number;
      const amt = Number(ent.amount || 0);
      if (num < 1 || num > 100 || amt <= 0) continue;
      const matches =
        filterMode === 'exact'
          ? Math.abs(amt - minAmountFilter) < 0.01
          : amt >= minAmountFilter;
      if (matches) upperBoxTotals[num] += amt;
      else lowerBoxTotals[num] += amt;
    }
    const upperNums = [];
    const lowerNums = [];
    let upperSum = 0;
    let lowerSum = 0;
    for (let n = 1; n <= 100; n++) {
      if (upperBoxTotals[n] > 0) {
        upperNums.push(n);
        upperSum += upperBoxTotals[n];
      }
      if (lowerBoxTotals[n] > 0) {
        lowerNums.push(n);
        lowerSum += lowerBoxTotals[n];
      }
    }
    return { upperBoxTotals, lowerBoxTotals, upperNums, lowerNums, upperSum, lowerSum };
  }, [categoryEntries, minAmountFilter, filterMode]);

  const [expandedBatchId, setExpandedBatchId] = useState(null);

  const buildTransactionsFromList = (list) => {
    const groups = new Map();
    for (const ent of list) {
      const key = ent.batchId || String(ent.id).split('-')[0] || String(ent.createdAt);
      if (!groups.has(key)) {
        groups.set(key, {
          batchId: key,
          category: ent.category || activeCategory,
          time:
            ent.time ||
            new Date(ent.createdAt).toLocaleTimeString('en-IN', {
              hour: '2-digit',
              minute: '2-digit',
            }),
          createdAt: ent.createdAt || 0,
          items: [],
          totalAmount: 0,
        });
      }
      const g = groups.get(key);
      g.items.push(ent);
      g.totalAmount += Number(ent.amount || 0);
      if ((ent.createdAt || 0) > g.createdAt) g.createdAt = ent.createdAt || 0;
    }
    return [...groups.values()].sort((a, b) => b.createdAt - a.createdAt);
  };

  const historyTransactions = useMemo(
    () => buildTransactionsFromList(categoryEntries),
    [categoryEntries, activeCategory]
  );

  const effectiveHistoryCat = historyCategoryFilter || activeCategory;
  const filteredHistoryTransactions = useMemo(() => {
    if (effectiveHistoryCat === 'ALL') return buildTransactionsFromList(entries);
    if (effectiveHistoryCat === activeCategory) return historyTransactions;
    return buildTransactionsFromList(entries.filter((e) => e.category === effectiveHistoryCat));
  }, [entries, effectiveHistoryCat, activeCategory, historyTransactions]);

  const selectedBoxEntries = useMemo(() => {
    if (!selectedBox) return [];
    return entries
      .filter((e) => e.category === activeCategory && e.number === selectedBox)
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [entries, activeCategory, selectedBox]);

  // Category tab click with Lock / Unlock behavior
  const handleCategoryClick = (cat) => {
    if (cat === activeCategory) {
      // Tapping the active category toggles Lock / Unlock
      const nextLock = !isLocked;
      setIsLocked(nextLock);
      publishCategoryState(activeCategory, nextLock);
      showToast(
        nextLock
          ? `🔒 ${cat} Locked`
          : `🔓 ${cat} Unlocked — now you can switch category`
      );
      return;
    }

    if (isLocked) {
      showToast(`🔒 ${activeCategory} is Locked! Tap ${activeCategory} first to unlock`);
      return;
    }

    // Unlocked: switch to new category and auto-lock it!
    setActiveCategory(cat);
    setIsLocked(true);
    setSelectedBox(null);
    publishCategoryState(cat, true);
    showToast(`🔒 ${cat} Selected & Locked`);
  };

  // Shared helper to commit parsed entries into one or more target categories
  const commitParsedEntries = (parsed, sourceLabel = '', rawText = '', targetCats = null) => {
    if (parsed.length === 0) return false;
    const catsToCommit =
      Array.isArray(targetCats) && targetCats.length > 0 ? targetCats : [activeCategory];
    const now = Date.now();
    const timeStr = new Date(now).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const cleanSrc = rawText && rawText.trim() ? rawText.trim() : '';
    const allNewItems = [];
    const newSources = {};

    catsToCommit.forEach((cat, cIdx) => {
      const batchId = `b-${now}-${cIdx}-${Math.random().toString(36).slice(2, 6)}`;
      if (cleanSrc) newSources[batchId] = cleanSrc;
      parsed.forEach((item, idx) => {
        allNewItems.push({
          id: `${now}-${cIdx}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
          batchId,
          category: cat,
          number: item.number,
          amount: item.amount,
          time: timeStr,
          createdAt: now + cIdx * 1000 + idx,
        });
      });
    });

    if (Object.keys(newSources).length > 0) {
      setBatchSources((prev) => {
        const keys = Object.keys(prev);
        const base =
          keys.length > 400
            ? Object.fromEntries(keys.slice(-300).map((k) => [k, prev[k]]))
            : { ...prev };
        return { ...base, ...newSources };
      });
    }

    const singleCatTotal = parsed.reduce((sum, item) => sum + item.amount, 0);
    setEntries((prev) => [...prev, ...allNewItems]);
    setInputText('');

    if (catsToCommit.length > 1) {
      showToast(
        `${sourceLabel}${catsToCommit.join('+')}: ${parsed.length} Jodis each (₹${(singleCatTotal * catsToCommit.length).toLocaleString('en-IN')})`
      );
    } else if (parsed.length === 1) {
      showToast(
        `${sourceLabel}${catsToCommit[0]}: Number ${String(parsed[0].number).padStart(2, '0')} added ₹${parsed[0].amount}`
      );
    } else {
      showToast(
        `${sourceLabel}${catsToCommit[0]}: ${parsed.length} Jodis added (₹${singleCatTotal})`
      );
    }
    return true;
  };

  const recordFailedPatterns = (failedList, fallbackRaw) => {
    const now = Date.now();
    const timeStr = new Date(now).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const itemsToSave =
      failedList.length > 0
        ? failedList
        : fallbackRaw && fallbackRaw.trim()
        ? [{ rawLine: fallbackRaw.trim(), reason: 'पैटर्न समझ नहीं आया (0 Numbers जुड़े)' }]
        : [];
    if (itemsToSave.length === 0) return 0;

    const newRecords = itemsToSave.map((item) => ({
      id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
      category: activeCategory,
      time: timeStr,
      parserVersion: PARSER_VERSION,
      status: 'pending',
      senderId: deviceId,
      rawLine: item.rawLine,
      reason: item.reason,
    }));

    setFailedPatterns((prev) => {
      const next = [...newRecords, ...prev];
      return next.slice(0, 150);
    });

    // Push failed patterns to shared 4-phone backup room (₹0, no account)
    const roomClean = (syncRoomId || DEFAULT_SYNC_ROOM).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (roomClean) {
      for (const rec of newRecords) {
        fetch(`https://ntfy.sh/sunny_jnt_failed_${roomClean}`, {
          method: 'POST',
          body: JSON.stringify({ type: 'SUNNY_FAILED_V1', ...rec }),
        }).catch(() => {});
      }
    }
    return itemsToSave.length;
  };

  const pullFailedBackup = async (showNotice = true) => {
    const roomClean = (syncRoomId || DEFAULT_SYNC_ROOM).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!roomClean) return;
    try {
      const res = await fetch(`https://ntfy.sh/sunny_jnt_failed_${roomClean}/json?poll=1&since=72h`);
      const text = await res.text();
      const remoteList = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt && evt.message) {
            const p = JSON.parse(evt.message);
            if (p && p.type === 'SUNNY_FAILED_V1' && p.rawLine) {
              remoteList.push(p);
            }
          }
        } catch {
          // ignore
        }
      }
      if (remoteList.length > 0) {
        setFailedPatterns((prev) => {
          const byId = new Map(prev.map((x) => [x.id, x]));
          for (const r of remoteList) {
            if (!byId.has(r.id)) byId.set(r.id, r);
          }
          return [...byId.values()].slice(0, 200);
        });
      }
      if (showNotice) {
        showToast(remoteList.length > 0 ? `🔄 ${remoteList.length} Failed Patterns चारों फोन से सिंक हुए` : 'कोई नया Failed Patterns नहीं मिला');
      }
    } catch {
      if (showNotice) showToast('Check internet connection');
    }
  };

  const handleCopyFailedPatterns = async () => {
    if (failedPatterns.length === 0) {
      showToast('कोई Failed Patterns नहीं है');
      return;
    }
    const report = [
      '=== SUNNY TRACKER FAILED PATTERNS ===',
      ...failedPatterns.map(
        (f, i) =>
          `#${i + 1} [${f.category} | ${f.time}]\nPattern: ${f.rawLine}\nReason: ${f.reason}`
      ),
      '=====================================',
    ].join('\n---\n');
    try {
      await navigator.clipboard.writeText(report);
      setCopiedKey('FAILED_ALL');
      setTimeout(() => setCopiedKey(null), 1800);
      showToast('Failed Patterns History कॉपी हो गई — अब चैट में पेस्ट कर दें');
    } catch {
      showToast('कॉपी नहीं हो सका');
    }
  };

  const openConfirmForText = (rawText, sourceLabel = '', fromBridge = false) => {
    if (!rawText || !rawText.trim()) {
      if (!fromBridge) showToast('Paste or type WhatsApp text first');
      return;
    }
    // Ignore pure word text (e.g. "Sunny") with no digits at all, or standalone 10-digit phone numbers
    if (!/\d/.test(rawText) || /^\s*\+?\d{10,12}\s*$/.test(rawText)) {
      if (!fromBridge) {
        showToast('Enter numbers with amount (e.g. 23 100 or 23=50)');
      }
      setInputText('');
      return;
    }
    const { results, normalResults, specialPreviews, failed, lineBreakdown } =
      analyzeWhatsAppText(rawText);
    setInputText('');
    if (results.length === 0) {
      const savedCount = recordFailedPatterns(failed, rawText);
      if (fromBridge) {
        setPendingConfirm({
          isError: true,
          results: [],
          normalResults: [],
          specialPreviews: [],
          failed,
          lineBreakdown,
          sourceLabel,
          rawText,
          fromBridge: true,
        });
        return;
      }
      if (savedCount > 0) {
        showToast('Pattern not accepted — saved to Failed History (check Menu)');
      } else {
        showToast('Enter valid format: e.g. 23 100 or 23=50');
      }
      return;
    }
    const sortedResults = [...results].sort((a, b) => a.number - b.number);
    const sortedNormal = [...normalResults].sort((a, b) => a.number - b.number);
    const trimmedIncoming = rawText.trim();
    let duplicateMatch = null;
    if (trimmedIncoming) {
      const matchingBatchIds = new Set(
        Object.entries(batchSources)
          .filter(([, txt]) => (txt || '').trim() === trimmedIncoming)
          .map(([bid]) => bid)
      );
      if (matchingBatchIds.size > 0) {
        const prevItems = entries.filter((e) => matchingBatchIds.has(e.batchId));
        if (prevItems.length > 0) {
          const sameCatItems = prevItems.filter((e) => e.category === activeCategory);
          const refList = sameCatItems.length > 0 ? sameCatItems : prevItems;
          const refBid = refList[refList.length - 1].batchId;
          const refBatchItems = refList.filter((e) => e.batchId === refBid);
          duplicateMatch = {
            category: refBatchItems[0].category,
            time: refBatchItems[0].time || '',
            count: refBatchItems.length,
            total: refBatchItems.reduce((s, x) => s + Number(x.amount || 0), 0),
          };
        }
      }
    }
    setPendingConfirm({
      isError: false,
      step: 1,
      viewTab: 'numbers',
      targetCategories: [activeCategory],
      duplicateMatch,
      results: sortedResults,
      normalResults: sortedNormal,
      specialPreviews,
      failed,
      lineBreakdown,
      sourceLabel,
      rawText,
      fromBridge,
    });
  };

  // Listen for clipboard text from native Android auto-clipboard check (when Auto ON)
  useEffect(() => {
    const handleIncomingText = (text) => {
      if (!autoPasteEnabled) return 'LOCKED';
      if (typeof text === 'string' && text.trim()) {
        openConfirmForText(text, 'Auto ✓ ', true);
        return 'OK';
      }
      return 'EMPTY';
    };
    const handleBridgeClip = (ev) => handleIncomingText(ev?.detail);
    window.addEventListener('sunny_clip_received', handleBridgeClip);
    window.receiveSunnyClip = handleIncomingText;

    const pullPendingFromNative = () => {
      try {
        if (!autoPasteEnabled) return;
        if (window.SunnyNativeBridge?.consumePendingClip) {
          const pending = window.SunnyNativeBridge.consumePendingClip();
          if (pending && pending.trim()) {
            handleIncomingText(pending);
            return;
          }
        }
        if (window.SunnyNativeBridge?.readClipboardIfNew) {
          window.SunnyNativeBridge.readClipboardIfNew();
        }
      } catch {
        // ignore
      }
    };
    pullPendingFromNative();
    window.addEventListener('focus', pullPendingFromNative);
    const onVis = () => {
      if (document.visibilityState === 'visible') pullPendingFromNative();
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      window.removeEventListener('sunny_clip_received', handleBridgeClip);
      window.removeEventListener('focus', pullPendingFromNative);
      document.removeEventListener('visibilitychange', onVis);
      delete window.receiveSunnyClip;
    };
  });

  // Auto-close FAILED bridge modal after 5 seconds and return to chat
  const [failCountdown, setFailCountdown] = useState(5);
  useEffect(() => {
    if (!pendingConfirm?.isError) return;
    setFailCountdown(5);
    const interval = setInterval(() => {
      setFailCountdown((c) => (c > 1 ? c - 1 : 0));
    }, 1000);
    const timer = setTimeout(() => {
      handleCancelPendingAdd();
    }, 5000);
    return () => {
      clearInterval(interval);
      clearTimeout(timer);
    };
  }, [pendingConfirm]);

  const handleConfirmPendingAdd = () => {
    if (!pendingConfirm) return;
    const hasSpecials =
      Array.isArray(pendingConfirm.specialPreviews) &&
      pendingConfirm.specialPreviews.length > 0;
    if ((pendingConfirm.step || 1) === 1 && hasSpecials) {
      setPendingConfirm((prev) => (prev ? { ...prev, step: 2 } : null));
      return;
    }
    const { results, failed, sourceLabel, fromBridge, rawText, targetCategories } = pendingConfirm;
    commitParsedEntries(results, sourceLabel, rawText, targetCategories);
    if (failed.length > 0) {
      const savedCount = recordFailedPatterns(failed, '');
      if (savedCount > 0) {
        showToast(`${sourceLabel}${results.length} Numbers जुड़े (${savedCount} लाइन फेल History में सेव)`);
      }
    }
    setPendingConfirm(null);
    if (fromBridge && window.SunnyNativeBridge?.returnToPreviousApp) {
      setTimeout(() => window.SunnyNativeBridge.returnToPreviousApp(), 250);
    }
  };

  const toggleCrossingJodaCut = (spIndex, cutMode) => {
    setPendingConfirm((prev) => {
      if (!prev || !Array.isArray(prev.specialPreviews)) return prev;
      const nextSpecials = prev.specialPreviews.map((sp, idx) => {
        if (idx !== spIndex || sp.kind !== 'crossing') return sp;
        const digits = sp.digits || [];
        const amt = sp.perAmt;
        const items = [];
        for (const d1 of digits) {
          for (const d2 of digits) {
            if (cutMode && d1 === d2) continue;
            items.push({ number: d1 === 0 && d2 === 0 ? 100 : d1 * 10 + d2, amount: amt });
          }
        }
        items.sort((a, b) => a.number - b.number);
        return {
          ...sp,
          isJodaCut: cutMode,
          count: items.length,
          total: items.reduce((s, x) => s + x.amount, 0),
          items,
        };
      });
      const allSpecialItems = nextSpecials.flatMap((sp) => sp.items || []);
      const nextResults = [...(prev.normalResults || []), ...allSpecialItems].sort(
        (a, b) => a.number - b.number
      );
      return {
        ...prev,
        specialPreviews: nextSpecials,
        results: nextResults,
      };
    });
  };

  const handleCancelPendingAdd = () => {
    const wasBridge = pendingConfirm?.fromBridge;
    setPendingConfirm(null);
    setInputText('');
    if (wasBridge && window.SunnyNativeBridge?.returnToPreviousApp) {
      window.SunnyNativeBridge.returnToPreviousApp();
    }
  };

  const handleMarkWrongAndSaveFailed = () => {
    if (!pendingConfirm) return;
    const { rawText, fromBridge } = pendingConfirm;
    recordFailedPatterns(
      [{ rawLine: rawText.trim(), reason: 'यूज़र ने गलत पार्सिंग मार्क किया (फेल में डाला)' }],
      rawText
    );
    setPendingConfirm(null);
    setInputText('');
    showToast('⚠️ Failed Patterns History में सेव हो गया');
    if (fromBridge && window.SunnyNativeBridge?.returnToPreviousApp) {
      setTimeout(() => window.SunnyNativeBridge.returnToPreviousApp(), 250);
    }
  };

  const processInputSubmission = (sourceLabel = '') => {
    openConfirmForText(inputText, sourceLabel);
  };

  const handleAddFromInput = (e) => {
    e?.preventDefault();
    processInputSubmission('');
  };

  // Paste button: if input box already has pasted text, commit it; otherwise paste clipboard into box first (no auto-add on Ctrl+V)
  const handlePasteAndAutoAdd = async () => {
    if (inputText.trim()) {
      processInputSubmission('Pasted ✓ ');
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        showToast('Clipboard is empty');
        return;
      }
      setInputText(text);
      showToast('टेक्स्ट बॉक्स में पेस्ट हो गया — जोड़ने के लिए Paste या + दबाएं');
    } catch {
      showToast('सीधे बॉक्स में Paste (Ctrl+V) करें, फिर Paste/+ दबाएं');
    }
  };

  const handleAddToSelectedBox = (e) => {
    e.preventDefault();
    const amt = parseFloat(quickBoxAmount);
    if (!amt || amt <= 0 || !selectedBox) return;

    const now = Date.now();
    setEntries((prev) => [
      ...prev,
      {
        id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
        category: activeCategory,
        number: selectedBox,
        amount: amt,
        createdAt: now,
      },
    ]);
    setQuickBoxAmount('');
    showToast(`${activeCategory}: Numbers ${selectedBox} में ₹${amt} जुड़ा`);
  };

  const handleDeleteEntry = (id) => {
    deletedIdsRef.current.add(id);
    persistSyncMeta();
    setEntries((prev) => prev.filter((item) => item.id !== id));
    showToast('Entry deleted');
  };

  const handleDeleteBatch = (batchItems) => {
    const idSet = new Set(batchItems.map((x) => x.id));
    for (const id of idSet) deletedIdsRef.current.add(id);
    persistSyncMeta();
    const total = batchItems.reduce((s, x) => s + Number(x.amount || 0), 0);
    setEntries((prev) => prev.filter((item) => !idSet.has(item.id)));
    showToast(`Deleted ${batchItems.length} Jodis (₹${total.toLocaleString('en-IN')})`);
  };

  const handleUndoLast = () => {
    const idx = [...entries]
      .reverse()
      .findIndex((e) => e.category === activeCategory);
    if (idx === -1) {
      showToast(`${activeCategory} में कोई एंट्री नहीं है`);
      return;
    }
    const targetIndex = entries.length - 1 - idx;
    const removed = entries[targetIndex];
    deletedIdsRef.current.add(removed.id);
    persistSyncMeta();
    setEntries((prev) => prev.filter((_, i) => i !== targetIndex));
    showToast(`Undo: Numbers ${removed.number} (₹${removed.amount})`);
  };

  const handleClearCategory = () => {
    const hasAny = entries.some((e) => e.category === activeCategory);
    if (!hasAny) {
      showToast(`${activeCategory} पहले से खाली है`);
      return;
    }
    setShowClearConfirm(true);
  };

  const confirmClearCategory = () => {
    categoryClearAtRef.current[activeCategory] = Date.now();
    persistSyncMeta();
    setEntries((prev) => prev.filter((e) => e.category !== activeCategory));
    setShowClearConfirm(false);
    setSelectedBox(null);
    showToast(`✓ ${activeCategory} का सारा डेटा क्लियर हो गया`);
  };

  // Load a ₹30,000 sample game into activeCategory (adds to or replaces after confirm)
  const handleLoad30kGame = () => {
    const sampleDistribution = [
      { number: 23, amount: 8500 },
      { number: 45, amount: 6200 },
      { number: 12, amount: 4800 },
      { number: 77, amount: 3500 },
      { number: 9, amount: 2600 },
      { number: 56, amount: 1900 },
      { number: 34, amount: 1200 },
      { number: 88, amount: 800 },
      { number: 5, amount: 350 },
      { number: 61, amount: 150 },
    ]; // Total = ₹30,000

    const hasExisting = entries.some((e) => e.category === activeCategory);
    if (
      hasExisting &&
      !window.confirm(
        `${activeCategory} में पहले से डेटा है। क्या इसे हटाकर नया ₹30,000 का गेम लोड करें?`
      )
    ) {
      return;
    }

    const now = Date.now();
    const demoItems = sampleDistribution.map((item, idx) => ({
      id: `demo-${now}-${idx}`,
      category: activeCategory,
      number: item.number,
      amount: item.amount,
      createdAt: now + idx,
    }));

    setEntries((prev) => [
      ...prev.filter((e) => e.category !== activeCategory),
      ...demoItems,
    ]);
    showToast(`${activeCategory} में ₹30,000 का गेम लोड हो गया`);
  };

  const handleCopySummary = async () => {
    const lines = [`*${activeCategory} टोटल: ₹${categoryTotals[activeCategory]}*`];
    for (let i = 1; i <= 100; i++) {
      if (boxTotals[i] > 0) {
        lines.push(`${String(i).padStart(2, '0')} = ₹${boxTotals[i]}`);
      }
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      showToast('Summary copied');
    } catch {
      showToast('कॉपी नहीं हो सका');
    }
  };

  const handleCopySingleJodi = async (num, amt) => {
    const text = `${String(num).padStart(2, '0')} = ${amt}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(num);
      setTimeout(() => setCopiedKey(null), 1600);
      showToast(`कॉपी हुआ: ${text}`);
    } catch {
      showToast('कॉपी नहीं हो सका');
    }
  };

  const filteredRankedList = useMemo(() => {
    if (!motiMinAmount || motiMinAmount <= 0) return rankedList;
    return rankedList.filter((item) => item.amount >= motiMinAmount);
  }, [rankedList, motiMinAmount]);

  const handleCopyAllMotiJodi = async () => {
    if (filteredRankedList.length === 0) {
      showToast('कॉपी करने के लिए कोई जोड़ी नहीं है');
      return;
    }
    const filterTag = motiMinAmount > 0 ? ` (₹${motiMinAmount}+)` : '';
    const lines = [
      `*${activeCategory} मोटी जोड़ी${filterTag} (कुल: ₹${categoryTotals[activeCategory].toLocaleString('en-IN')})*`,
      ...filteredRankedList.map(
        (item) => `${String(item.number).padStart(2, '0')} = ${item.amount}`
      ),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopiedKey('ALL');
      setTimeout(() => setCopiedKey(null), 1800);
      showToast(`${filteredRankedList.length} जोड़ी कॉपी हो गईं`);
    } catch {
      showToast('कॉपी नहीं हो सका');
    }
  };

  // Render crisp 01-100 chart PNG on canvas with total & owner name in footer
  const buildChartImage = () => {
    const canvas = document.createElement('canvas');
    const W = 900;
    const H = 1120;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    // Background
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, W, H);

    // Top Header Banner
    ctx.fillStyle = '#131d33';
    ctx.fillRect(24, 20, W - 48, 86);
    ctx.strokeStyle = '#2c3c56';
    ctx.lineWidth = 2;
    ctx.strokeRect(24, 20, W - 48, 86);

    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(`${activeCategory} — 01 से 100 चार्ट`, 44, 62);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '16px sans-serif';
    const nowStr = new Date().toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    ctx.fillText(`Date: ${nowStr}`, 44, 90);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(`${rankedList.length} / 100 जोड़ी लगी`, W - 44, 68);
    ctx.textAlign = 'left';

    // 10x10 Grid (01 to 100)
    const startX = 24;
    const startY = 124;
    const gap = 6;
    const cols = 10;
    const boxW = (W - 48 - gap * (cols - 1)) / cols;
    const boxH = 82;

    for (let idx = 0; idx < 100; idx++) {
      const num = idx + 1;
      const amt = boxTotals[num] || 0;
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const x = startX + c * (boxW + gap);
      const y = startY + r * (boxH + gap);

      const tier = amt > 0 ? tierByAmount[amt] : null;
      let bg = '#151f32';
      let border = '#24324a';
      let numColor = '#64748b';
      let amtColor = '#475569';

      if (tier === 'top') {
        bg = '#000000';
        border = '#f59e0b';
        numColor = '#fbbf24';
        amtColor = '#fbbf24';
      } else if (tier === 'second') {
        bg = '#2c170b';
        border = '#f97316';
        numColor = '#fdba74';
        amtColor = '#fb923c';
      } else if (tier === 'third') {
        bg = '#0b2239';
        border = '#38bdf8';
        numColor = '#7dd3fc';
        amtColor = '#38bdf8';
      } else if (tier === 'lowest') {
        bg = '#2a0f1c';
        border = '#f43f5e';
        numColor = '#fda4af';
        amtColor = '#fb7185';
      } else if (amt > 0) {
        bg = '#1a2740';
        border = '#3b4f70';
        numColor = '#cbd5e1';
        amtColor = '#e2e8f0';
      }

      ctx.fillStyle = bg;
      ctx.fillRect(x, y, boxW, boxH);
      ctx.strokeStyle = border;
      ctx.lineWidth = tier === 'top' ? 2.5 : 1.5;
      ctx.strokeRect(x, y, boxW, boxH);

      // Number label
      ctx.fillStyle = numColor;
      ctx.font = 'bold 14px sans-serif';
      const label = tier === 'top' ? `★${String(num).padStart(2, '0')}` : String(num).padStart(2, '0');
      ctx.fillText(label, x + 7, y + 22);

      // Amount label
      ctx.fillStyle = amtColor;
      ctx.font = amt >= 1000 ? 'bold 16px sans-serif' : 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(amt > 0 ? `₹${amt}` : '—', x + boxW / 2, y + 60);
      ctx.textAlign = 'left';
    }

    // Stylish Bottom Footer (Total + Name)
    const footY = 1010;
    ctx.fillStyle = '#000000';
    ctx.fillRect(24, footY, W - 48, 86);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.strokeRect(24, footY, W - 48, 86);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(`Name: ${(chartOwnerName || 'Sunny').trim()}`, 46, footY + 38);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '15px sans-serif';
    ctx.fillText(`Category: ${activeCategory} • 01 से 100 चार्ट`, 46, footY + 66);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText(
      `Total: ₹${categoryTotals[activeCategory].toLocaleString('en-IN')}`,
      W - 46,
      footY + 54
    );
    ctx.textAlign = 'left';

    return canvas.toDataURL('image/png');
  };

  useEffect(() => {
    if (toolsView === 'share_image') {
      setChartImageUrl(buildChartImage());
    }
  }, [toolsView, chartOwnerName, entries, activeCategory]);

  const handleDownloadChartImage = () => {
    const url = chartImageUrl || buildChartImage();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeCategory}-01-100-chart.png`;
    a.click();
    showToast(`${activeCategory} चार्ट इमेज Download हो गई`);
  };

  const handleShareChartImage = async () => {
    const url = chartImageUrl || buildChartImage();
    if (!url) return;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const file = new File([blob], `${activeCategory}-01-100-chart.png`, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: `${activeCategory} 01-100 चार्ट`,
          text: `${activeCategory} Total: ₹${categoryTotals[activeCategory].toLocaleString('en-IN')} — ${chartOwnerName}`,
        });
        showToast('चार्ट इमेज शेयर हो गई');
        return;
      }
    } catch {
      // Fallback to download below
    }
    handleDownloadChartImage();
  };

  return (
    <div className="desktop-shell">
      <div
        className="desktop-preview-banner"
        style={{
          fontSize: '12px',
          color: '#94a3b8',
          marginBottom: '8px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <span>📱 Live Mobile Preview</span>
        <span>•</span>
        <span>Auto-Save Enabled</span>
      </div>

      <div
        className="phone-frame"
        style={{
          background: t.frameBg,
          border: `1px solid ${t.frameBorder}`,
          color: t.textPrimary,
        }}
      >
        {/* Header */}
        <header
          style={{
            padding: '10px 12px',
            background: t.headerBg,
            borderBottom: `1px solid ${t.cardBorder}`,
          }}
        >
          {/* Row 1: Title + Lock Badge + Connected + Menu */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '6px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flexWrap: 'wrap' }}>
              <h1
                style={{
                  fontSize: '15px',
                  fontWeight: 800,
                  color: t.textPrimary,
                  whiteSpace: 'nowrap',
                }}
              >
                Number Tracker
              </h1>
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: '999px',
                  background: isLocked ? t.lockBadgeBg : t.accentSoft,
                  border: `1px solid ${isLocked ? t.lockBadgeBorder : t.accent}`,
                  color: isLocked ? t.lockBadgeText : t.accentText,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '3px',
                  whiteSpace: 'nowrap',
                }}
              >
                {isLocked ? <Lock size={10} /> : <Unlock size={10} />}
                {isLocked ? `${activeCategory} Locked` : 'Unlocked'}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '6px', flexShrink: 0, alignItems: 'center' }}>
              <button
                onClick={() => setToolsView('cloud_sync')}
                title="4-Phone Live Sync Settings"
                style={{
                  background: syncEnabled
                    ? syncStatus === 'live'
                      ? '#00a884'
                      : 'rgba(245, 158, 11, 0.2)'
                    : t.inputBg,
                  color: syncEnabled
                    ? syncStatus === 'live'
                      ? '#ffffff'
                      : '#fbbf24'
                    : t.textSecondary,
                  border: `1px solid ${
                    syncEnabled ? (syncStatus === 'live' ? '#00a884' : '#f59e0b') : t.cardBorder
                  }`,
                  borderRadius: '999px',
                  padding: '4px 9px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '10px',
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                }}
              >
                <Wifi size={12} color={syncEnabled && syncStatus === 'live' ? '#ffffff' : undefined} />
                {syncEnabled ? (syncStatus === 'live' ? `Connected: ${connectedCount}` : 'Sync...') : 'Sync'}
              </button>
              <button
                onClick={() => setToolsView('menu')}
                title="Open Settings & Tools"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  background: t.inputBg,
                  color: t.textPrimary,
                  border: `1px solid ${t.cardBorder}`,
                  borderRadius: '999px',
                  padding: '4px 10px',
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <Wrench size={12} color={t.accent} />
                Settings
              </button>
            </div>
          </div>

          {/* Row 2: Active Game Total + Live Plus/Minus Status */}
          {(() => {
            const rateMult = (Number(jodiRatePer10) || 0) / 10;
            const rawActiveRes = String(gameResults?.[activeCategory] ?? '').replace(/\D/g, '').slice(0, 2);
            const hasActiveRes = rawActiveRes.length === 2;
            const activeResNum = hasActiveRes ? normalizeJodiNumber(rawActiveRes) : '';
            const activeSale = Number(categoryTotals?.[activeCategory]) || 0;
            const activeBet = hasActiveRes
              ? entries.reduce(
                  (sum, e) =>
                    e.category === activeCategory && e.number === activeResNum
                      ? sum + (Number(e.amount) || 0)
                      : sum,
                  0
                )
              : 0;
            const activeNet = hasActiveRes ? activeSale - Math.round(activeBet * rateMult) : null;

            const savedHistNet = plHistory.reduce((s, h) => s + (Number(h.net) || 0), 0);
            const now = new Date();
            const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            const todayUnsavedDelta = CATEGORIES.reduce((s, cat) => {
              const r = String(gameResults?.[cat] ?? '').replace(/\D/g, '').slice(0, 2);
              if (r.length !== 2) return s;
              const rn = normalizeJodiNumber(r);
              const sc = Number(categoryTotals?.[cat]) || 0;
              const bc = entries.reduce(
                (sum, e) => (e.category === cat && e.number === rn ? sum + (Number(e.amount) || 0) : sum),
                0
              );
              const n = sc - Math.round(bc * rateMult);
              const prev = plHistory.find((h) => h.dateKey === todayKey && h.category === cat);
              return s + (prev ? n - (Number(prev.net) || 0) : n);
            }, 0);
            const liveNet = activeNet !== null ? activeNet : savedHistNet + todayUnsavedDelta;
            const isPlus = liveNet >= 0;

            return (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '8px',
                  marginBottom: '9px',
                }}
              >
                <p style={{ fontSize: '12px', color: t.textSecondary, whiteSpace: 'nowrap' }}>
                  {activeCategory} Total:{' '}
                  <strong style={{ color: t.accent, fontSize: '13px' }}>
                    ₹{activeSale.toLocaleString('en-IN')}
                  </strong>
                </p>

                <button
                  onClick={() => setToolsView('profit_loss')}
                  title="नफा / नुकसान हिसाब देखें"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    background: isPlus
                      ? 'rgba(16, 185, 129, 0.16)'
                      : 'rgba(244, 63, 94, 0.18)',
                    color: isPlus ? '#34d399' : '#fb7185',
                    border: `1.5px solid ${isPlus ? 'rgba(16, 185, 129, 0.5)' : 'rgba(244, 63, 94, 0.55)'}`,
                    borderRadius: '999px',
                    padding: '4px 11px',
                    fontSize: '11px',
                    fontWeight: 800,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>{isPlus ? '📈' : '📉'}</span>
                  <span>
                    {activeNet !== null ? `${activeCategory}: ` : ''}
                    {isPlus ? '+₹' : '-₹'}
                    {Math.abs(liveNet).toLocaleString('en-IN')} {isPlus ? 'Plus' : 'Minus'}
                  </span>
                </button>
              </div>
            );
          })()}

          {/* 6 Category Tabs with Lock/Unlock */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(6, 1fr)',
              gap: '5px',
            }}
          >
            {CATEGORIES.map((cat) => {
              const isActive = cat === activeCategory;
              return (
                <button
                  key={cat}
                  onClick={() => handleCategoryClick(cat)}
                  style={{
                    padding: '6px 2px',
                    borderRadius: '10px',
                    border: isActive
                      ? `1.5px solid ${t.tabActiveBorder}`
                      : `1px solid ${t.cardBorder}`,
                    background: isActive ? t.tabActiveBg : t.inputBg,
                    color: isActive ? '#ffffff' : t.textSecondary,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '2px',
                    opacity: isLocked && !isActive ? 0.55 : 1,
                    transition: 'all 0.15s ease',
                  }}
                >
                  <span
                    style={{
                      fontSize: '12px',
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '2px',
                    }}
                  >
                    {cat}
                    {isActive && (isLocked ? <Lock size={10} /> : <Unlock size={10} />)}
                  </span>
                  <span
                    style={{
                      fontSize: '9px',
                      fontWeight: 600,
                      color: isActive ? '#e0f2fe' : t.textMuted,
                    }}
                  >
                    ₹{categoryTotals[cat]}
                  </span>
                </button>
              );
            })}
          </div>
        </header>

        {/* Quick Entry & WhatsApp Auto-Paste Bar */}
        <form
          onSubmit={handleAddFromInput}
          style={{
            padding: '10px 12px',
            background: t.frameBg,
            borderBottom: `1px solid ${t.cardBorder}`,
            display: 'flex',
            gap: '6px',
            alignItems: 'center',
          }}
        >
          <textarea
            rows={1}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleAddFromInput();
              }
            }}
            placeholder="Paste here..."
            style={{
              flex: 1,
              background: t.inputBg,
              border: `1px solid ${t.cardBorder}`,
              borderRadius: '10px',
              padding: '10px',
              color: t.textPrimary,
              fontSize: '12px',
              lineHeight: '1.3',
              resize: 'none',
              outline: 'none',
              overflow: 'hidden',
            }}
          />
          <button
            type="button"
            onClick={handlePasteAndAutoAdd}
            title="WhatsApp से पेस्ट करके तुरंत Add"
            style={{
              background: '#0284c7',
              border: 'none',
              color: '#ffffff',
              borderRadius: '10px',
              padding: '9px 10px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '12px',
              fontWeight: 600,
            }}
          >
            <ClipboardPaste size={15} />
            Paste
          </button>
          <button
            type="submit"
            style={{
              background: t.accent,
              border: 'none',
              color: '#ffffff',
              fontWeight: 700,
              borderRadius: '10px',
              padding: '9px 11px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '3px',
              fontSize: '12px',
            }}
          >
            <Plus size={15} />
            Add
          </button>
        </form>

        {/* Live Tier Summary Strip (सबसे मोटा -> उससे नीचे -> Lowest) */}
        {rankedList.length > 0 && (
          <div
            style={{
              padding: '7px 10px',
              background: t.headerBg,
              borderBottom: `1px solid ${t.cardBorder}`,
              display: 'flex',
              gap: '6px',
              overflowX: 'auto',
              alignItems: 'center',
            }}
          >
            {(() => {
              const first = rankedList[0];
              const second = rankedList.find((x) => x.amount < first.amount);
              const third = second
                ? rankedList.find((x) => x.amount < second.amount)
                : null;
              const lowest =
                rankedList.length > 1 ? rankedList[rankedList.length - 1] : null;

              const chips = [
                {
                  label: '👑 Highest',
                  item: first,
                  bg: t.accentSoft,
                  border: t.accent,
                  color: t.accentText,
                },
                second && {
                  label: '2nd',
                  item: second,
                  bg: t.cardBg,
                  border: t.cardBorder,
                  color: t.textSecondary,
                },
                third && {
                  label: '3rd',
                  item: third,
                  bg: t.cardBg,
                  border: t.cardBorder,
                  color: t.textSecondary,
                },
                lowest &&
                  lowest.amount !== first.amount && {
                    label: 'Lowest',
                    item: lowest,
                    bg: t.cardBg,
                    border: t.cardBorder,
                    color: t.textMuted,
                  },
              ].filter(Boolean);

              return chips.map((chip) => (
                <button
                  key={chip.label}
                  onClick={() => setSelectedBox(chip.item.number)}
                  style={{
                    background: chip.bg,
                    border: `1px solid ${chip.border}`,
                    color: chip.color,
                    borderRadius: '999px',
                    padding: '4px 10px',
                    fontSize: '10px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  <span>{chip.label}:</span>
                  <span style={{ color: t.textPrimary, fontWeight: 700 }}>
                    {String(chip.item.number).padStart(2, '0')} (₹{chip.item.amount.toLocaleString('en-IN')})
                  </span>
                </button>
              ));
            })()}
          </div>
        )}

        {/* 2-Part Cut / Split Amount System (Entry-Level Upar vs Niche with independent Copy & Back) */}
        {(() => {
          const hasFilter = minAmountFilter > 0 && cutSplitData;
          const selectedNums = hasFilter ? cutSplitData.upperNums : [];
          const remainingNums = hasFilter ? cutSplitData.lowerNums : [];
          const selectedSum = hasFilter ? cutSplitData.upperSum : 0;
          const remainingSum = hasFilter ? cutSplitData.lowerSum : 0;
          const upperLabel = filterMode === 'exact' ? `=₹${minAmountFilter} Wale` : `₹${minAmountFilter}+ Upar`;
          const lowerLabel = filterMode === 'exact' ? `≠₹${minAmountFilter} (Baki)` : `<₹${minAmountFilter} Niche`;

          const copyListWithTotal = async (list, totalsArr, sum, title) => {
            if (list.length === 0) {
              showToast('Copy के लिए कोई नंबर नहीं है');
              return;
            }
            const lines = [
              `*${activeCategory} — ${title}*`,
              ...list.map((n) => `${String(n).padStart(2, '0')} = ₹${totalsArr[n]}`),
              `----------------`,
              `Total (${list.length} Jodis): ₹${sum.toLocaleString('en-IN')}`,
            ];
            try {
              await navigator.clipboard.writeText(lines.join('\n'));
              showToast(`${title}: ${list.length}J (₹${sum.toLocaleString('en-IN')}) Copied ✓`);
            } catch {
              showToast('Copy failed');
            }
          };

          return (
            <div style={{ padding: '5px 10px 2px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder="₹ Amount (50 / 100)"
                  value={customMinFilter}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCustomMinFilter(v);
                    const n = parseFloat(v);
                    setMinAmountFilter(Number.isFinite(n) && n > 0 ? n : 0);
                    setSplitPart('selected');
                  }}
                  style={{
                    flex: 1,
                    minWidth: '110px',
                    maxWidth: '150px',
                    padding: '5px 10px',
                    borderRadius: '999px',
                    fontSize: '11px',
                    fontWeight: 700,
                    background: t.inputBg,
                    color: t.textPrimary,
                    border: `1px solid ${hasFilter ? t.accent : t.cardBorder}`,
                    outline: 'none',
                  }}
                />
                <button
                  type="button"
                  title="Switch Upar+ (>=) / Exact (=)"
                  onClick={() => setFilterMode((m) => (m === 'min' ? 'exact' : 'min'))}
                  style={{
                    padding: '5px 10px',
                    borderRadius: '999px',
                    fontSize: '10px',
                    fontWeight: 800,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    background: t.inputBg,
                    color: t.accentText,
                    border: `1px solid ${t.cardBorder}`,
                  }}
                >
                  {filterMode === 'min' ? 'Upar +' : 'Exact ='}
                </button>
                {hasFilter && (
                  <button
                    type="button"
                    onClick={() => {
                      setMinAmountFilter(0);
                      setCustomMinFilter('');
                      setSplitPart('selected');
                    }}
                    style={{
                      marginLeft: 'auto',
                      padding: '5px 11px',
                      borderRadius: '999px',
                      fontSize: '10px',
                      fontWeight: 800,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      background: '#e11d48',
                      color: '#ffffff',
                      border: 'none',
                    }}
                  >
                    ← Back
                  </button>
                )}
              </div>

              {hasFilter && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '7px',
                  }}
                >
                  {/* Part 1: Upar / Selected */}
                  <div
                    onClick={() => setSplitPart('selected')}
                    style={{
                      padding: '7px 9px',
                      borderRadius: '11px',
                      border: `1.5px solid ${splitPart === 'selected' ? t.accent : t.cardBorder}`,
                      background: splitPart === 'selected' ? t.accentSoft : t.cardBg,
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '4px' }}>
                      <span style={{ fontSize: '10px', fontWeight: 800, color: splitPart === 'selected' ? t.accentText : t.textMuted }}>
                        {upperLabel}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          copyListWithTotal(selectedNums, cutSplitData.upperBoxTotals, selectedSum, upperLabel);
                        }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '3px',
                          padding: '2px 7px',
                          borderRadius: '999px',
                          border: `1px solid ${t.accent}`,
                          background: t.inputBg,
                          color: t.accentText,
                          fontSize: '9px',
                          fontWeight: 800,
                          cursor: 'pointer',
                        }}
                      >
                        <Copy size={10} /> Copy
                      </button>
                    </div>
                    <div style={{ fontSize: '13px', fontWeight: 800, color: t.textPrimary }}>
                      {selectedNums.length}J • ₹{selectedSum.toLocaleString('en-IN')}
                    </div>
                  </div>

                  {/* Part 2: Niche / Remaining */}
                  <div
                    onClick={() => setSplitPart('remaining')}
                    style={{
                      padding: '7px 9px',
                      borderRadius: '11px',
                      border: `1.5px solid ${splitPart === 'remaining' ? '#38bdf8' : t.cardBorder}`,
                      background: splitPart === 'remaining' ? 'rgba(56, 189, 248, 0.14)' : t.cardBg,
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '4px' }}>
                      <span style={{ fontSize: '10px', fontWeight: 800, color: splitPart === 'remaining' ? '#38bdf8' : t.textMuted }}>
                        {lowerLabel}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          copyListWithTotal(remainingNums, cutSplitData.lowerBoxTotals, remainingSum, lowerLabel);
                        }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '3px',
                          padding: '2px 7px',
                          borderRadius: '999px',
                          border: '1px solid #38bdf8',
                          background: t.inputBg,
                          color: '#38bdf8',
                          fontSize: '9px',
                          fontWeight: 800,
                          cursor: 'pointer',
                        }}
                      >
                        <Copy size={10} /> Copy
                      </button>
                    </div>
                    <div style={{ fontSize: '13px', fontWeight: 800, color: t.textPrimary }}>
                      {remainingNums.length}J • ₹{remainingSum.toLocaleString('en-IN')}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* 1 to 100 Number Grid (or 2-Section Cut Table Boxes when Amount Filter is active) */}
        <main
          className="grid-scroll"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '10px',
            display: minAmountFilter > 0 ? 'flex' : 'grid',
            flexDirection: minAmountFilter > 0 ? 'column' : undefined,
            gap: minAmountFilter > 0 ? '12px' : columns === 5 ? '6px' : '4px',
            gridTemplateColumns: minAmountFilter > 0 ? undefined : `repeat(${columns}, 1fr)`,
            alignContent: 'start',
          }}
        >
          {(() => {
            const renderNumberBox = (num, customTotals = boxTotals) => {
              const amt = customTotals[num];
              const hasAmt = amt > 0;
              const tier = hasAmt && customTotals === boxTotals ? tierByAmount[amt] : null;
              const isHighest = tier === 'top';

              let boxBg = t.cardBg;
              let boxBorder = `1px solid ${t.cardBorder}`;
              let numColor = t.textSecondary;
              let amtColor = t.textMuted;

              if (isHighest) {
                boxBg = t.accentSoft;
                boxBorder = `1.5px solid ${t.accent}`;
                numColor = t.accentText;
                amtColor = t.textPrimary;
              } else if (hasAmt) {
                boxBg = t.accentSoft;
                boxBorder = `1px solid ${t.accent}`;
                numColor = t.accentText;
                amtColor = t.textPrimary;
              }

              return (
                <button
                  key={num}
                  onClick={() => setSelectedBox(num)}
                  style={{
                    background: boxBg,
                    border: boxBorder,
                    boxShadow: isHighest
                      ? '0 0 12px rgba(245, 158, 11, 0.45)'
                      : 'none',
                    borderRadius: '10px',
                    padding: columns === 5 ? '8px 4px' : '6px 2px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    minHeight: columns === 5 ? '54px' : '42px',
                    position: 'relative',
                  }}
                >
                  <span
                    style={{
                      fontSize: columns === 5 ? '13px' : '10px',
                      fontWeight: isHighest ? 900 : 700,
                      color: numColor,
                    }}
                  >
                    {isHighest ? `👑${String(num).padStart(2, '0')}` : String(num).padStart(2, '0')}
                  </span>
                  <span
                    style={{
                      fontSize: columns === 5 ? '11px' : '9px',
                      fontWeight: hasAmt ? 700 : 400,
                      color: amtColor,
                      marginTop: '2px',
                      wordBreak: 'break-all',
                    }}
                  >
                    {hasAmt ? `₹${amt.toLocaleString('en-IN')}` : '—'}
                  </span>
                </button>
              );
            };

            if (minAmountFilter <= 0 || !cutSplitData) {
              return Array.from({ length: 100 }, (_, i) => i + 1).map((n) => renderNumberBox(n, boxTotals));
            }

            const { upperBoxTotals, lowerBoxTotals, upperNums, lowerNums, upperSum, lowerSum } = cutSplitData;

            const copySection = async (list, totalsArr, sum, title) => {
              if (list.length === 0) {
                showToast('Copy के लिए कोई नंबर नहीं है');
                return;
              }
              const lines = [
                `*${activeCategory} — ${title}*`,
                ...list.map((n) => `${String(n).padStart(2, '0')} = ₹${totalsArr[n]}`),
                `----------------`,
                `Total (${list.length} Jodis): ₹${sum.toLocaleString('en-IN')}`,
              ];
              try {
                await navigator.clipboard.writeText(lines.join('\n'));
                showToast(`${title}: ${list.length}J (₹${sum.toLocaleString('en-IN')}) Copied ✓`);
              } catch {
                showToast('Copy failed');
              }
            };

            const sections = [
              {
                key: 'upper',
                title: filterMode === 'exact' ? `🎯 =₹${minAmountFilter} Wale` : `🎯 ₹${minAmountFilter}+ Upar`,
                nums: upperNums,
                totalsArr: upperBoxTotals,
                sum: upperSum,
                accent: t.accent,
                accentText: t.accentText,
                emptyMsg: `${activeCategory} में ${filterMode === 'exact' ? `₹${minAmountFilter}` : `₹${minAmountFilter}+`} की कोई एंट्री नहीं है।`,
              },
              {
                key: 'lower',
                title: filterMode === 'exact' ? `📦 ≠₹${minAmountFilter} (Baki)` : `📦 <₹${minAmountFilter} Niche (Baki)`,
                nums: lowerNums,
                totalsArr: lowerBoxTotals,
                sum: lowerSum,
                accent: '#38bdf8',
                accentText: '#38bdf8',
                emptyMsg: `${activeCategory} में इसके अलावा कोई और एंट्री नहीं है।`,
              },
            ];

            const orderedSections =
              splitPart === 'remaining' ? [sections[1], sections[0]] : sections;

            return orderedSections.map((sec) => (
              <div
                key={sec.key}
                style={{
                  background: t.inputBg,
                  border: `1.5px solid ${sec.accent}`,
                  borderRadius: '14px',
                  padding: '8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 800, color: sec.accentText }}>
                      {sec.title}
                    </span>
                    <span style={{ fontSize: '11px', fontWeight: 800, color: '#fbbf24' }}>
                      {sec.nums.length}J • ₹{sec.sum.toLocaleString('en-IN')}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => copySection(sec.nums, sec.totalsArr, sec.sum, sec.title)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '4px 9px',
                      borderRadius: '999px',
                      border: `1px solid ${sec.accent}`,
                      background: t.cardBg,
                      color: sec.accentText,
                      fontSize: '10px',
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    <Copy size={11} /> Copy
                  </button>
                </div>
                {sec.nums.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '12px 6px', fontSize: '11px', color: t.textMuted }}>
                    {sec.emptyMsg}
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: `repeat(${columns}, 1fr)`,
                      gap: columns === 5 ? '6px' : '4px',
                    }}
                  >
                    {sec.nums.map((n) => renderNumberBox(n, sec.totalsArr))}
                  </div>
                )}
              </div>
            ));
          })()}
        </main>

        {/* Professional Bottom Total & Action Bar */}
        <footer
          style={{
            padding: '10px 12px 12px',
            background: t.headerBg,
            borderTop: `1.5px solid ${t.cardBorder}`,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            boxShadow: '0 -6px 20px rgba(0, 0, 0, 0.18)',
          }}
        >
          {/* Stylish Total Card */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background:
                themeMode === 'dark'
                  ? 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)'
                  : 'linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)',
              border: `1px solid ${t.cardBorder}`,
              borderRadius: '12px',
              padding: '8px 12px',
            }}
          >
            <div>
              <div
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  color: t.textSecondary,
                  letterSpacing: '0.4px',
                  textTransform: 'uppercase',
                }}
              >
                {activeCategory} Total
              </div>
              <div
                style={{
                  fontSize: '20px',
                  fontWeight: 900,
                  color: '#38bdf8',
                  lineHeight: 1.15,
                }}
              >
                ₹{categoryTotals[activeCategory].toLocaleString('en-IN')}
              </div>
            </div>

            <div style={{ textAlign: 'right' }}>
              <div
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  color: t.textSecondary,
                }}
              >
                {activeCategory} Jodis
              </div>
              <div
                style={{
                  fontSize: '15px',
                  fontWeight: 800,
                  color: t.accent,
                  lineHeight: 1.2,
                }}
              >
                {rankedList.length} / 100
              </div>
            </div>
          </div>

          {/* Action Buttons: Undo, Copy, Clear {activeCategory} */}
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={handleUndoLast}
              title="आखिरी एंट्री Delete (Undo)"
              style={{
                flex: 1,
                background: t.inputBg,
                border: `1px solid ${t.cardBorder}`,
                color: t.textPrimary,
                borderRadius: '10px',
                padding: '8px 10px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '5px',
                fontSize: '12px',
                fontWeight: 600,
              }}
            >
              <Undo2 size={14} />
              Undo
            </button>
            <button
              onClick={handleCopySummary}
              title="समरी Copy"
              style={{
                flex: 1,
                background: t.inputBg,
                border: `1px solid ${t.cardBorder}`,
                color: t.textPrimary,
                borderRadius: '10px',
                padding: '8px 10px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '5px',
                fontSize: '12px',
                fontWeight: 600,
              }}
            >
              {copied ? <Check size={14} color={t.accent} /> : <Copy size={14} />}
              Copy
            </button>
            <button
              onClick={handleClearCategory}
              title={`${activeCategory} का सारा डेटा Clear`}
              style={{
                flex: 1.2,
                background: 'rgba(239, 68, 68, 0.16)',
                border: '1px solid rgba(239, 68, 68, 0.5)',
                color: '#ef4444',
                borderRadius: '10px',
                padding: '8px 10px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '5px',
                fontSize: '12px',
                fontWeight: 700,
              }}
            >
              <Trash2 size={14} />
              Clear {activeCategory}
            </button>
          </div>
        </footer>

        {/* Clear Category Confirmation Modal */}
        {showClearConfirm && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(2, 6, 23, 0.76)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '20px',
              zIndex: 50,
            }}
            onClick={() => setShowClearConfirm(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '100%',
                background: t.headerBg,
                border: '1px solid rgba(239, 68, 68, 0.45)',
                borderRadius: '18px',
                padding: '18px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
                boxShadow: '0 20px 40px rgba(0,0,0,0.45)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Trash2 size={20} color="#ef4444" />
                <h3 style={{ fontSize: '16px', fontWeight: 800, color: t.textPrimary }}>
                  {activeCategory} का डेटा Clear?
                </h3>
              </div>
              <p style={{ fontSize: '13px', color: t.textSecondary, lineHeight: 1.45 }}>
                {activeCategory} का पूरा डेटा (
                <strong style={{ color: t.textPrimary }}>
                  ₹{categoryTotals[activeCategory].toLocaleString('en-IN')} • {rankedList.length} जोड़ी
                </strong>
                ) हमेशा के लिए मिट जाएगा। बाकी कैटेगरी का डेटा सुरक्षित रहेगा।
              </p>
              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button
                  onClick={() => setShowClearConfirm(false)}
                  style={{
                    flex: 1,
                    background: t.inputBg,
                    border: `1px solid ${t.cardBorder}`,
                    color: t.textPrimary,
                    borderRadius: '10px',
                    padding: '10px',
                    fontSize: '13px',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  नहीं (Cancel)
                </button>
                <button
                  onClick={confirmClearCategory}
                  style={{
                    flex: 1.2,
                    background: '#dc2626',
                    border: 'none',
                    color: '#ffffff',
                    borderRadius: '10px',
                    padding: '10px',
                    fontSize: '13px',
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  हाँ, {activeCategory} Clear
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Toast Notification */}
        {toast && (
          <div
            style={{
              position: 'absolute',
              bottom: '72px',
              left: '50%',
              transform: 'translateX(-50%)',
              background: '#0f172a',
              color: '#ffffff',
              border: '1px solid #38bdf8',
              padding: '7px 14px',
              borderRadius: '999px',
              fontSize: '12px',
              fontWeight: 600,
              boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
              whiteSpace: 'nowrap',
              zIndex: 30,
              maxWidth: '92%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {toast}
          </div>
        )}

        {/* Category Tools & Moti Jodi Modal */}
        {toolsView && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(2, 6, 23, 0.72)',
              display: 'flex',
              alignItems: 'flex-end',
              zIndex: 45,
            }}
            onClick={() => setToolsView(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '100%',
                background: toolsView === 'menu' ? '#f0f2f5' : t.headerBg,
                borderTopLeftRadius: '20px',
                borderTopRightRadius: '20px',
                borderTop: `1px solid ${toolsView === 'menu' ? '#e5e7eb' : t.cardBorder}`,
                padding: toolsView === 'menu' ? '0' : '16px',
                maxHeight: '88%',
                display: 'flex',
                flexDirection: 'column',
                gap: toolsView === 'menu' ? '0' : '12px',
                overflowY: 'auto',
              }}
            >
              {toolsView === 'menu' ? (
                <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: '18px' }}>
                  {/* WhatsApp-style Pure White Header */}
                  <div
                    style={{
                      background: '#ffffff',
                      padding: '15px 16px 13px',
                      borderBottom: '1px solid #e5e7eb',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      position: 'sticky',
                      top: 0,
                      zIndex: 2,
                    }}
                  >
                    <div>
                      <h2 style={{ fontSize: '18px', fontWeight: 800, color: '#000000' }}>
                        सेटिंग्स (Settings)
                      </h2>
                      <p style={{ fontSize: '12px', color: '#4b5563', marginTop: '1px' }}>
                        {activeCategory} घड़ी • सब कुछ आसान भाषा में
                      </p>
                    </div>
                    <button
                      onClick={() => setToolsView(null)}
                      style={{
                        background: '#f3f4f6',
                        border: 'none',
                        color: '#111827',
                        borderRadius: '999px',
                        width: '32px',
                        height: '32px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                      }}
                    >
                      <X size={18} />
                    </button>
                  </div>

                  <div style={{ padding: '12px 12px 0', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {/* Group 1: Daily Work */}
                    <div
                      style={{
                        background: '#ffffff',
                        borderRadius: '14px',
                        overflow: 'hidden',
                        border: '1px solid #e5e7eb',
                      }}
                    >
                      <button
                        onClick={() => setToolsView('profit_loss')}
                        style={{
                          width: '100%',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          background: '#ffffff',
                          border: 'none',
                          borderBottom: '1px solid #f1f5f9',
                          padding: '13px 14px',
                          cursor: 'pointer',
                          textAlign: 'left',
                          gap: '10px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <div
                            style={{
                              width: '34px',
                              height: '34px',
                              borderRadius: '9px',
                              background: '#16a34a',
                              color: '#ffffff',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '17px',
                              flexShrink: 0,
                            }}
                          >
                            📊
                          </div>
                          <div>
                            <div style={{ fontSize: '15px', fontWeight: 700, color: '#000000' }}>
                              नफा / नुकसान और रेट
                            </div>
                            <div style={{ fontSize: '12px', color: '#4b5563', marginTop: '1px' }}>
                              रिजल्ट डालें • रेट ₹{jodiRatePer10}/10 • पुराना हिसाब
                            </div>
                          </div>
                        </div>
                        <span style={{ fontSize: '18px', color: '#9ca3af', fontWeight: 600 }}>›</span>
                      </button>

                      <button
                        onClick={() => setToolsView('moti_jodi')}
                        style={{
                          width: '100%',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          background: '#ffffff',
                          border: 'none',
                          borderBottom: '1px solid #f1f5f9',
                          padding: '13px 14px',
                          cursor: 'pointer',
                          textAlign: 'left',
                          gap: '10px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <div
                            style={{
                              width: '34px',
                              height: '34px',
                              borderRadius: '9px',
                              background: '#ea580c',
                              color: '#ffffff',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <Flame size={18} />
                          </div>
                          <div>
                            <div style={{ fontSize: '15px', fontWeight: 700, color: '#000000' }}>
                              बड़े नंबर अलग करें (Cut)
                            </div>
                            <div style={{ fontSize: '12px', color: '#4b5563', marginTop: '1px' }}>
                              50 से ऊपर या नीचे वाले नंबर अलग देखें व कॉपी करें
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span
                            style={{
                              background: '#fff7ed',
                              color: '#c2410c',
                              fontWeight: 700,
                              fontSize: '12px',
                              padding: '2px 8px',
                              borderRadius: '999px',
                            }}
                          >
                            {rankedList.length}
                          </span>
                          <span style={{ fontSize: '18px', color: '#9ca3af', fontWeight: 600 }}>›</span>
                        </div>
                      </button>

                      <button
                        onClick={() => setToolsView('entry_history')}
                        style={{
                          width: '100%',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          background: '#ffffff',
                          border: 'none',
                          borderBottom: '1px solid #f1f5f9',
                          padding: '13px 14px',
                          cursor: 'pointer',
                          textAlign: 'left',
                          gap: '10px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <div
                            style={{
                              width: '34px',
                              height: '34px',
                              borderRadius: '9px',
                              background: '#0284c7',
                              color: '#ffffff',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <History size={18} />
                          </div>
                          <div>
                            <div style={{ fontSize: '15px', fontWeight: 700, color: '#000000' }}>
                              एंट्री इतिहास (History)
                            </div>
                            <div style={{ fontSize: '12px', color: '#4b5563', marginTop: '1px' }}>
                              हर कस्टमर की एंट्री देखें, कॉपी या डिलीट करें
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span
                            style={{
                              background: '#eff6ff',
                              color: '#1d4ed8',
                              fontWeight: 700,
                              fontSize: '12px',
                              padding: '2px 8px',
                              borderRadius: '999px',
                            }}
                          >
                            {historyTransactions.length}
                          </span>
                          <span style={{ fontSize: '18px', color: '#9ca3af', fontWeight: 600 }}>›</span>
                        </div>
                      </button>

                      <button
                        onClick={() => setToolsView('all_sales')}
                        style={{
                          width: '100%',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          background: '#ffffff',
                          border: 'none',
                          padding: '13px 14px',
                          cursor: 'pointer',
                          textAlign: 'left',
                          gap: '10px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <div
                            style={{
                              width: '34px',
                              height: '34px',
                              borderRadius: '9px',
                              background: '#0d9488',
                              color: '#ffffff',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '16px',
                              flexShrink: 0,
                            }}
                          >
                            💰
                          </div>
                          <div>
                            <div style={{ fontSize: '15px', fontWeight: 700, color: '#000000' }}>
                              सभी 6 घड़ी का कुल जोड़
                            </div>
                            <div style={{ fontSize: '12px', color: '#4b5563', marginTop: '1px' }}>
                              DB, SG, FD, GB, GL, DS सबका टोटल देखें
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span
                            style={{
                              background: '#f0fdfa',
                              color: '#0f766e',
                              fontWeight: 800,
                              fontSize: '12px',
                              padding: '2px 8px',
                              borderRadius: '999px',
                            }}
                          >
                            ₹{grandTotal.toLocaleString('en-IN')}
                          </span>
                          <span style={{ fontSize: '18px', color: '#9ca3af', fontWeight: 600 }}>›</span>
                        </div>
                      </button>
                    </div>

                    {/* Group 2: Sync & Share */}
                    <div
                      style={{
                        background: '#ffffff',
                        borderRadius: '14px',
                        overflow: 'hidden',
                        border: '1px solid #e5e7eb',
                      }}
                    >
                      <button
                        onClick={() => setToolsView('cloud_sync')}
                        style={{
                          width: '100%',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          background: '#ffffff',
                          border: 'none',
                          borderBottom: '1px solid #f1f5f9',
                          padding: '13px 14px',
                          cursor: 'pointer',
                          textAlign: 'left',
                          gap: '10px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <div
                            style={{
                              width: '34px',
                              height: '34px',
                              borderRadius: '9px',
                              background: '#10b981',
                              color: '#ffffff',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <Wifi size={18} />
                          </div>
                          <div>
                            <div style={{ fontSize: '15px', fontWeight: 700, color: '#000000' }}>
                              4-फोन लाइव सिंक
                            </div>
                            <div style={{ fontSize: '12px', color: '#4b5563', marginTop: '1px' }}>
                              एक फोन में जोड़ें, बाकी सब में तुरंत दिखेगा
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span
                            style={{
                              background: syncEnabled ? '#dcfce7' : '#f3f4f6',
                              color: syncEnabled ? '#15803d' : '#4b5563',
                              fontWeight: 800,
                              fontSize: '11px',
                              padding: '2px 8px',
                              borderRadius: '999px',
                            }}
                          >
                            {syncEnabled ? 'चालू (ON)' : 'बंद (OFF)'}
                          </span>
                          <span style={{ fontSize: '18px', color: '#9ca3af', fontWeight: 600 }}>›</span>
                        </div>
                      </button>

                      <button
                        onClick={() => setToolsView('share_image')}
                        style={{
                          width: '100%',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          background: '#ffffff',
                          border: 'none',
                          padding: '13px 14px',
                          cursor: 'pointer',
                          textAlign: 'left',
                          gap: '10px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <div
                            style={{
                              width: '34px',
                              height: '34px',
                              borderRadius: '9px',
                              background: '#2563eb',
                              color: '#ffffff',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <ImageIcon size={18} />
                          </div>
                          <div>
                            <div style={{ fontSize: '15px', fontWeight: 700, color: '#000000' }}>
                              01–100 चार्ट फोटो बनाएं
                            </div>
                            <div style={{ fontSize: '12px', color: '#4b5563', marginTop: '1px' }}>
                              व्हाट्सएप पर भेजने के लिए साफ़ फोटो डाउनलोड करें
                            </div>
                          </div>
                        </div>
                        <span style={{ fontSize: '18px', color: '#9ca3af', fontWeight: 600 }}>›</span>
                      </button>
                    </div>

                    {/* Group 3: Display & Quick Switches */}
                    <div
                      style={{
                        background: '#ffffff',
                        borderRadius: '14px',
                        padding: '10px',
                        border: '1px solid #e5e7eb',
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr 1fr',
                        gap: '8px',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setThemeMode((m) => (m === 'dark' ? 'light' : 'dark'))}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '4px',
                          background: '#f9fafb',
                          border: '1px solid #e5e7eb',
                          color: '#000000',
                          borderRadius: '10px',
                          padding: '10px 6px',
                          fontSize: '12px',
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        {themeMode === 'dark' ? <Sun size={16} color="#ea580c" /> : <Moon size={16} color="#2563eb" />}
                        {themeMode === 'dark' ? 'सफेद स्क्रीन' : 'काली स्क्रीन'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setColumns((c) => (c === 5 ? 10 : 5))}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '4px',
                          background: '#f9fafb',
                          border: '1px solid #e5e7eb',
                          color: '#000000',
                          borderRadius: '10px',
                          padding: '10px 6px',
                          fontSize: '12px',
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        <LayoutGrid size={16} color="#0284c7" />
                        {columns} खाने
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const next = !autoPasteEnabled;
                          setAutoPasteEnabled(next);
                          showToast(next ? 'Auto-Copy ON' : 'Auto-Copy OFF');
                        }}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '4px',
                          background: autoPasteEnabled ? '#ecfdf5' : '#f9fafb',
                          border: `1px solid ${autoPasteEnabled ? '#10b981' : '#e5e7eb'}`,
                          color: '#000000',
                          borderRadius: '10px',
                          padding: '10px 6px',
                          fontSize: '12px',
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        {autoPasteEnabled ? <Unlock size={16} color="#16a34a" /> : <Lock size={16} color="#6b7280" />}
                        {autoPasteEnabled ? 'ऑटो-पेस्ट ON' : 'ऑटो-पेस्ट OFF'}
                      </button>
                    </div>

                    {/* Group 4: Failed Patterns + Demos */}
                    <div
                      style={{
                        background: '#ffffff',
                        borderRadius: '14px',
                        overflow: 'hidden',
                        border: '1px solid #e5e7eb',
                      }}
                    >
                      <button
                        onClick={() => setToolsView('failed_patterns')}
                        style={{
                          width: '100%',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          background: '#ffffff',
                          border: 'none',
                          borderBottom: '1px solid #f1f5f9',
                          padding: '13px 14px',
                          cursor: 'pointer',
                          textAlign: 'left',
                          gap: '10px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <div
                            style={{
                              width: '34px',
                              height: '34px',
                              borderRadius: '9px',
                              background: '#dc2626',
                              color: '#ffffff',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                          >
                            <AlertTriangle size={18} />
                          </div>
                          <div>
                            <div style={{ fontSize: '15px', fontWeight: 700, color: '#000000' }}>
                              जो नंबर नहीं जुड़े
                            </div>
                            <div style={{ fontSize: '12px', color: '#4b5563', marginTop: '1px' }}>
                              गलत पैटर्न यहाँ दिखेंगे, कॉपी करके भेजें
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span
                            style={{
                              background: failedPatterns.length > 0 ? '#fee2e2' : '#f3f4f6',
                              color: failedPatterns.length > 0 ? '#dc2626' : '#4b5563',
                              fontWeight: 800,
                              fontSize: '12px',
                              padding: '2px 8px',
                              borderRadius: '999px',
                            }}
                          >
                            {failedPatterns.length}
                          </span>
                          <span style={{ fontSize: '18px', color: '#9ca3af', fontWeight: 600 }}>›</span>
                        </div>
                      </button>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', background: '#ffffff' }}>
                        <button
                          onClick={() => {
                            setToolsView(null);
                            const demoMsg =
                              '[25/11, 8:45 pm] कस्टमर: 12.27.34.. into 20\n43=50\nTotal 110';
                            if (typeof window.receiveSunnyClip === 'function') {
                              window.receiveSunnyClip(demoMsg);
                            } else {
                              openConfirmForText(demoMsg, 'कीबोर्ड ✓ ');
                            }
                          }}
                          style={{
                            background: '#ffffff',
                            border: 'none',
                            borderRight: '1px solid #f1f5f9',
                            padding: '12px 8px',
                            fontSize: '12px',
                            fontWeight: 700,
                            color: '#000000',
                            cursor: 'pointer',
                          }}
                        >
                          📱 ऑटो-पेस्ट डेमो
                        </button>
                        <button
                          onClick={() => {
                            handleLoad30kGame();
                            setToolsView('moti_jodi');
                          }}
                          style={{
                            background: '#ffffff',
                            border: 'none',
                            padding: '12px 8px',
                            fontSize: '12px',
                            fontWeight: 700,
                            color: '#000000',
                            cursor: 'pointer',
                          }}
                        >
                          🎯 ₹30k सैंपल गेम
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : toolsView === 'all_sales' ? (
                <>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        onClick={() => setToolsView('menu')}
                        title="Back to Settings"
                        style={{
                          background: t.inputBg,
                          border: `1px solid ${t.cardBorder}`,
                          color: t.textPrimary,
                          borderRadius: '8px',
                          padding: '5px 7px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                        }}
                      >
                        <ArrowLeft size={15} />
                      </button>
                      <div>
                        <h2 style={{ fontSize: '15px', fontWeight: 800, color: t.textPrimary }}>
                          📊 All Games Total Sale
                        </h2>
                        <p style={{ fontSize: '11px', color: t.textSecondary }}>
                          Combined sale across all 6 categories
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setToolsView(null)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: t.textSecondary,
                        cursor: 'pointer',
                      }}
                    >
                      <X size={20} />
                    </button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {CATEGORIES.map((cat) => {
                      const catAmt = categoryTotals[cat] || 0;
                      const catCount = entries.filter((e) => e.category === cat).length;
                      return (
                        <div
                          key={cat}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            background: t.inputBg,
                            border: `1px solid ${cat === activeCategory ? t.accent : t.cardBorder}`,
                            borderRadius: '10px',
                            padding: '10px 12px',
                          }}
                        >
                          <div>
                            <div style={{ fontSize: '13px', fontWeight: 800, color: t.textPrimary }}>
                              {cat}
                            </div>
                            <div style={{ fontSize: '10px', color: t.textMuted }}>
                              {catCount} entries
                            </div>
                          </div>
                          <span style={{ fontSize: '14px', fontWeight: 800, color: t.accentText }}>
                            ₹{catAmt.toLocaleString('en-IN')}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      background: t.accentSoft,
                      border: `1.5px solid ${t.accent}`,
                      borderRadius: '12px',
                      padding: '12px 14px',
                    }}
                  >
                    <span style={{ fontSize: '13px', fontWeight: 800, color: t.textPrimary }}>
                      Final Total Sale (All 6)
                    </span>
                    <span style={{ fontSize: '18px', fontWeight: 900, color: t.accentText }}>
                      ₹{grandTotal.toLocaleString('en-IN')}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={async () => {
                      const lines = [
                        '*All Games Total Sale*',
                        ...CATEGORIES.map(
                          (cat) => `${cat}: ₹${(categoryTotals[cat] || 0).toLocaleString('en-IN')}`
                        ),
                        `*Final Total: ₹${grandTotal.toLocaleString('en-IN')}*`,
                      ].join('\n');
                      try {
                        await navigator.clipboard.writeText(lines);
                        showToast('All Games Sale Report copied ✓');
                      } catch {
                        showToast('Copy failed');
                      }
                    }}
                    style={{
                      width: '100%',
                      background: t.accent,
                      border: 'none',
                      color: '#ffffff',
                      borderRadius: '12px',
                      padding: '12px',
                      fontSize: '13px',
                      fontWeight: 800,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '6px',
                    }}
                  >
                    <Copy size={15} />
                    Copy Sale Report
                  </button>
                </>
              ) : toolsView === 'moti_jodi' ? (
                <>
                  {/* Moti Jodi Header */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        onClick={() => setToolsView('menu')}
                        title="Tools पर Back जाएं"
                        style={{
                          background: t.inputBg,
                          border: `1px solid ${t.cardBorder}`,
                          color: t.textPrimary,
                          borderRadius: '8px',
                          padding: '5px 7px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                        }}
                      >
                        <ArrowLeft size={15} />
                      </button>
                      <div>
                        <h2 style={{ fontSize: '15px', fontWeight: 700, color: t.textPrimary }}>
                          🔥 {activeCategory} — Top Jodis
                        </h2>
                        <p style={{ fontSize: '11px', color: t.textSecondary }}>
                          कुल: ₹{categoryTotals[activeCategory].toLocaleString('en-IN')} ({filteredRankedList.length}
                          {motiMinAmount > 0 ? ` / ${rankedList.length}` : ''} जोड़ी)
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setToolsView(null)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: t.textSecondary,
                        cursor: 'pointer',
                      }}
                    >
                      <X size={20} />
                    </button>
                  </div>

                  {/* Moti Jodi Threshold Filter (hidden in dedicated Cut Result Display) */}
                  {!(cutApplied && motiMinAmount > 0) ? (
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '6px',
                      alignItems: 'center',
                      background: t.inputBg,
                      border: `1px solid ${t.cardBorder}`,
                      borderRadius: '10px',
                      padding: '8px',
                    }}
                  >
                    {[
                      { label: 'All', val: 0 },
                      { label: '₹300+', val: 300 },
                      { label: '₹500+', val: 500 },
                      { label: '₹800+', val: 800 },
                      { label: '₹1,000+', val: 1000 },
                    ].map((preset) => {
                      const activePreset = motiMinAmount === preset.val;
                      return (
                        <button
                          key={preset.val}
                          type="button"
                          onClick={() => {
                            setMotiMinAmount(preset.val);
                            if (preset.val === 0) setCutApplied(false);
                          }}
                          style={{
                            background: activePreset ? t.accent : t.cardBg,
                            color: activePreset ? '#ffffff' : t.textPrimary,
                            border: `1px solid ${activePreset ? t.accent : t.cardBorder}`,
                            borderRadius: '999px',
                            padding: '4px 9px',
                            fontSize: '11px',
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '5px',
                        width: '100%',
                        marginTop: '4px',
                      }}
                    >
                      <span style={{ fontSize: '11px', color: t.textSecondary, fontWeight: 600 }}>
                        Amount:
                      </span>
                      <input
                        type="number"
                        min="0"
                        value={motiMinAmount || ''}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          const nextVal = Number.isFinite(v) && v > 0 ? v : 0;
                          setMotiMinAmount(nextVal);
                          if (nextVal === 0) setCutApplied(false);
                        }}
                        placeholder="e.g. 70 or 800"
                        style={{
                          flex: 1,
                          background: t.cardBg,
                          border: `1px solid ${t.cardBorder}`,
                          borderRadius: '8px',
                          padding: '6px 8px',
                          color: t.textPrimary,
                          fontSize: '12px',
                          fontWeight: 700,
                          outline: 'none',
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (motiMinAmount > 0) {
                            setCutApplied((prev) => !prev);
                          } else {
                            showToast('Enter an amount first (e.g. 70 or 800)');
                          }
                        }}
                        style={{
                          background: cutApplied && motiMinAmount > 0 ? '#059669' : t.accent,
                          border: 'none',
                          color: '#ffffff',
                          borderRadius: '8px',
                          padding: '6px 12px',
                          fontSize: '12px',
                          fontWeight: 800,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {cutApplied && motiMinAmount > 0 ? `Cut ON (-₹${motiMinAmount})` : 'Cut'}
                      </button>
                    </div>
                  </div>
                  ) : null}

                  {cutApplied && motiMinAmount > 0 && (() => {
                    const cutItems = filteredRankedList.filter((x) => x.amount > motiMinAmount);
                    const cutTotal = cutItems.reduce((s, x) => s + (x.amount - motiMinAmount), 0);
                    return (
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          background: t.accentSoft,
                          border: `1px solid ${t.accent}`,
                          borderRadius: '10px',
                          padding: '8px 10px',
                          fontSize: '12px',
                          fontWeight: 700,
                          color: t.accentText,
                          gap: '8px',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setCutApplied(false)}
                          style={{
                            background: t.cardBg,
                            border: `1px solid ${t.cardBorder}`,
                            color: t.textPrimary,
                            borderRadius: '7px',
                            padding: '4px 8px',
                            fontSize: '11px',
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          ← Back
                        </button>
                        <span>
                          ✂️ Cut (-₹{motiMinAmount}) • {cutItems.length} Jodis
                        </span>
                        <span style={{ color: t.textPrimary }}>
                          ₹{cutTotal.toLocaleString('en-IN')}
                        </span>
                      </div>
                    );
                  })()}

                  {/* Moti Jodi List (Highest to Lowest + Per-Row Copy Button) */}
                  <div
                    className="grid-scroll"
                    style={{
                      overflowY: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                      maxHeight: '320px',
                    }}
                  >
                    {filteredRankedList.length === 0 ? (
                      <p
                        style={{
                          fontSize: '13px',
                          color: t.textMuted,
                          textAlign: 'center',
                          padding: '24px 0',
                        }}
                      >
                        {rankedList.length === 0
                          ? `अभी ${activeCategory} में कोई जोड़ी नहीं लगी है।`
                          : `₹${motiMinAmount} या उससे ऊपर कोई जोड़ी नहीं है — ऊपर "सभी" दबाकर देखें।`}
                      </p>
                    ) : (
                      (cutApplied && motiMinAmount > 0
                        ? filteredRankedList.filter((x) => x.amount > motiMinAmount)
                        : filteredRankedList
                      ).map((item, idx) => {
                        const displayAmt =
                          cutApplied && motiMinAmount > 0
                            ? item.amount - motiMinAmount
                            : item.amount;
                        const tier = tierByAmount[item.amount];
                        const catTotal = categoryTotals[activeCategory] || 1;
                        const pct = ((item.amount / catTotal) * 100).toFixed(1);
                        const isRowCopied = copiedKey === item.number;

                        let badgeLabel = `#${idx + 1}`;
                        let rowBg = t.inputBg;
                        let rowBorder = t.cardBorder;
                        let badgeColor = t.textSecondary;

                        if (tier === 'top') {
                          badgeLabel = '👑 Top';
                          rowBg = t.accentSoft;
                          rowBorder = t.accent;
                          badgeColor = t.accentText;
                        }

                        const jodiEntries = entries.filter(
                          (e) => e.category === activeCategory && e.number === item.number
                        );
                        const isExpanded = expandedJodi === item.number;

                        return (
                          <div
                            key={item.number}
                            style={{
                              background: rowBg,
                              border: `1px solid ${rowBorder}`,
                              borderRadius: '10px',
                              padding: '8px 10px',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: '8px',
                              }}
                            >
                              <div
                                onClick={() =>
                                  setExpandedJodi(isExpanded ? null : item.number)
                                }
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '8px',
                                  flex: 1,
                                  cursor: 'pointer',
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: '10px',
                                    fontWeight: 800,
                                    color: badgeColor,
                                    minWidth: '66px',
                                  }}
                                >
                                  {badgeLabel}
                                </span>
                                <div>
                                  <div
                                    style={{
                                      fontSize: '14px',
                                      fontWeight: 800,
                                      color: t.textPrimary,
                                    }}
                                  >
                                    Jodi {String(item.number).padStart(2, '0')}
                                  </div>
                                  <div style={{ fontSize: '10px', color: t.textMuted }}>
                                    {cutApplied && motiMinAmount > 0
                                      ? `Orig: ₹${item.amount.toLocaleString('en-IN')} − Cut: ₹${motiMinAmount}`
                                      : `${jodiEntries.length}x • ${pct}%`} {isExpanded ? '▴' : '▾'}
                                  </div>
                                </div>
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span
                                  style={{
                                    fontSize: '14px',
                                    fontWeight: 800,
                                    color: t.accentText,
                                  }}
                                >
                                  ₹{displayAmt.toLocaleString('en-IN')}
                                </span>
                                <button
                                  onClick={() => handleCopySingleJodi(item.number, displayAmt)}
                                  title="यह जोड़ी Copy"
                                  style={{
                                    background: isRowCopied ? t.accent : t.cardBg,
                                    border: `1px solid ${isRowCopied ? t.accent : t.cardBorder}`,
                                    color: isRowCopied ? '#ffffff' : t.textPrimary,
                                    borderRadius: '8px',
                                    padding: '6px 8px',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '3px',
                                    fontSize: '11px',
                                    fontWeight: 600,
                                  }}
                                >
                                  {isRowCopied ? <Check size={13} /> : <Copy size={13} />}
                                  {isRowCopied ? 'Copied' : 'Copy'}
                                </button>
                              </div>
                            </div>

                            {isExpanded && (
                              <div
                                style={{
                                  marginTop: '8px',
                                  paddingTop: '8px',
                                  borderTop: `1px dashed ${t.cardBorder}`,
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '5px',
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    fontSize: '11px',
                                    fontWeight: 700,
                                    color: tier === 'top' ? '#fde68a' : t.textSecondary,
                                  }}
                                >
                                  <span>
                                    कुल {jodiEntries.length} बार जुड़कर ₹{item.amount.toLocaleString('en-IN')} हुआ:
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setToolsView(null);
                                      setSelectedBox(item.number);
                                    }}
                                    style={{
                                      background: 'transparent',
                                      border: `1px solid ${t.cardBorder}`,
                                      color: tier === 'top' ? '#fbbf24' : t.accentText,
                                      borderRadius: '6px',
                                      padding: '2px 7px',
                                      fontSize: '10px',
                                      fontWeight: 700,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    बॉक्स खोलें
                                  </button>
                                </div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                                  {jodiEntries.map((ent, eIdx) => (
                                    <span
                                      key={ent.id}
                                      style={{
                                        fontSize: '11px',
                                        padding: '3px 7px',
                                        borderRadius: '6px',
                                        background: t.cardBg,
                                        border: `1px solid ${t.cardBorder}`,
                                        color: t.textPrimary,
                                        fontWeight: 600,
                                      }}
                                    >
                                      #{jodiEntries.length - eIdx}: ₹{ent.amount}
                                      {ent.time ? ` (${ent.time})` : ''}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Bottom Copy & Cut Buttons */}
                  {filteredRankedList.length > 0 && (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        onClick={handleCopyAllMotiJodi}
                        style={{
                          flex: 1,
                          background: copiedKey === 'ALL' ? '#059669' : t.accent,
                          border: 'none',
                          color: '#ffffff',
                          borderRadius: '12px',
                          padding: '11px',
                          fontSize: '12px',
                          fontWeight: 800,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '6px',
                        }}
                      >
                        {copiedKey === 'ALL' ? <Check size={15} /> : <Copy size={15} />}
                        {copiedKey === 'ALL'
                          ? 'Copied ✓'
                          : `Copy All (${filteredRankedList.length})`}
                      </button>
                      {motiMinAmount > 0 && filteredRankedList.some((x) => x.amount > motiMinAmount) && (
                        <button
                          onClick={async () => {
                            const cutItems = filteredRankedList.filter((x) => x.amount > motiMinAmount);
                            const cutText = [
                              `*${activeCategory} Cut (>₹${motiMinAmount})*`,
                              ...cutItems.map(
                                (x) => `${String(x.number).padStart(2, '0')} = ${x.amount - motiMinAmount}`
                              ),
                            ].join('\n');
                            try {
                              await navigator.clipboard.writeText(cutText);
                              setCopiedKey('CUT');
                              setTimeout(() => setCopiedKey(null), 1500);
                              showToast(`Copied ${cutItems.length} cut jodis (>₹${motiMinAmount})`);
                            } catch {
                              showToast('Copy failed');
                            }
                          }}
                          style={{
                            flex: 1,
                            background: copiedKey === 'CUT' ? '#059669' : t.inputBg,
                            border: `1.5px solid ${t.accent}`,
                            color: copiedKey === 'CUT' ? '#ffffff' : t.accentText,
                            borderRadius: '12px',
                            padding: '11px',
                            fontSize: '12px',
                            fontWeight: 800,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '6px',
                          }}
                        >
                          {copiedKey === 'CUT' ? <Check size={15} /> : <Copy size={15} />}
                          {copiedKey === 'CUT' ? 'Cut Copied ✓' : `Copy Cut (>₹${motiMinAmount})`}
                        </button>
                      )}
                    </div>
                  )}
                </>
              ) : toolsView === 'share_image' ? (
                <>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        onClick={() => setToolsView('menu')}
                        title="Tools पर Back जाएं"
                        style={{
                          background: t.inputBg,
                          border: `1px solid ${t.cardBorder}`,
                          color: t.textPrimary,
                          borderRadius: '8px',
                          padding: '5px 7px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                        }}
                      >
                        <ArrowLeft size={15} />
                      </button>
                      <div>
                        <h2 style={{ fontSize: '15px', fontWeight: 700, color: t.textPrimary }}>
                          🖼️ {activeCategory} — 01 से 100 चार्ट इमेज
                        </h2>
                        <p style={{ fontSize: '11px', color: t.textSecondary }}>
                          नीचे टोटल व नाम के साथ शेयर या Download करें
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setToolsView(null)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: t.textSecondary,
                        cursor: 'pointer',
                      }}
                    >
                      <X size={20} />
                    </button>
                  </div>

                  {/* Owner / Party Name for Footer */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label style={{ fontSize: '11px', color: t.textSecondary, whiteSpace: 'nowrap' }}>
                      इमेज पर Name:
                    </label>
                    <input
                      type="text"
                      value={chartOwnerName}
                      onChange={(e) => setChartOwnerName(e.target.value)}
                      placeholder="Enter your or party name"
                      style={{
                        flex: 1,
                        background: t.inputBg,
                        border: `1px solid ${t.cardBorder}`,
                        borderRadius: '8px',
                        padding: '7px 10px',
                        color: t.textPrimary,
                        fontSize: '12px',
                        fontWeight: 600,
                        outline: 'none',
                      }}
                    />
                  </div>

                  {/* Live Generated Chart Preview */}
                  <div
                    className="grid-scroll"
                    style={{
                      overflowY: 'auto',
                      maxHeight: '340px',
                      borderRadius: '10px',
                      border: `1px solid ${t.cardBorder}`,
                      background: '#0b1120',
                    }}
                  >
                    {chartImageUrl && (
                      <img
                        src={chartImageUrl}
                        alt={`${activeCategory} 01-100 Chart`}
                        style={{ width: '100%', display: 'block', borderRadius: '10px' }}
                      />
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      onClick={handleShareChartImage}
                      style={{
                        flex: 1,
                        background: '#059669',
                        border: 'none',
                        color: '#ffffff',
                        borderRadius: '10px',
                        padding: '11px',
                        fontSize: '13px',
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '6px',
                      }}
                    >
                      <Share2 size={15} />
                      Share
                    </button>
                    <button
                      type="button"
                      onClick={handleDownloadChartImage}
                      style={{
                        flex: 1,
                        background: '#0284c7',
                        border: 'none',
                        color: '#ffffff',
                        borderRadius: '10px',
                        padding: '11px',
                        fontSize: '13px',
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '6px',
                      }}
                    >
                      <Download size={15} />
                      Download PNG
                    </button>
                  </div>
                </>
              ) : toolsView === 'cloud_sync' ? (
                <>
                  {/* Free 4-Phone Live Sync Settings */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        onClick={() => setToolsView('menu')}
                        title="Tools पर Back जाएं"
                        style={{
                          background: t.inputBg,
                          border: `1px solid ${t.cardBorder}`,
                          color: t.textPrimary,
                          borderRadius: '8px',
                          padding: '5px 7px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                        }}
                      >
                        <ArrowLeft size={15} />
                      </button>
                      <div>
                        <h2 style={{ fontSize: '15px', fontWeight: 800, color: '#6ee7b7' }}>
                          📡 4-फोन फ्री लाइव सिंक (₹0)
                        </h2>
                        <p style={{ fontSize: '11px', color: t.textSecondary }}>
                          {syncEnabled
                            ? syncStatus === 'live'
                              ? `🟢 Connected: ${connectedCount} फोन${lastSyncTime ? ` • अंतिम सिंक: ${lastSyncTime}` : ''}`
                              : '🟡 कनेक्ट हो रहा है...'
                            : '⚪ अभी बंद है'}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setToolsView(null)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: t.textSecondary,
                        cursor: 'pointer',
                      }}
                    >
                      <X size={20} />
                    </button>
                  </div>

                  <div
                    style={{
                      background: t.inputBg,
                      border: `1px solid ${t.cardBorder}`,
                      borderRadius: '12px',
                      padding: '12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px',
                    }}
                  >
                    <div style={{ fontSize: '12px', color: t.textSecondary, lineHeight: '1.45' }}>
                      अपने सभी फोनों (4 या ज़्यादा) में एक ही <strong>गुप्त कोड (Sync Code)</strong> डालकर ON करें। किसी भी फोन पर Numbers जुड़ते ही चारों फोनों में तुरंत अपडेट हो जाएगा — बिल्कुल मुफ़्त!
                    </div>

                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <input
                        type="text"
                        value={syncRoomId}
                        onChange={(e) => setSyncRoomId(e.target.value)}
                        placeholder="Enter room code (e.g. sunny-live-8899)"
                        style={{
                          flex: 1,
                          background: t.cardBg,
                          border: `1px solid ${t.cardBorder}`,
                          borderRadius: '8px',
                          padding: '9px 10px',
                          color: t.textPrimary,
                          fontSize: '13px',
                          fontWeight: 700,
                          outline: 'none',
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const code = `sunny-${Math.floor(1000 + Math.random() * 9000)}`;
                          setSyncRoomId(code);
                          showToast(`नया कोड बना: ${code}`);
                        }}
                        style={{
                          background: t.cardBg,
                          border: `1px solid ${t.cardBorder}`,
                          color: t.accentText,
                          borderRadius: '8px',
                          padding: '9px 10px',
                          fontSize: '11px',
                          fontWeight: 700,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        🎲 नया कोड
                      </button>
                    </div>

                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        type="button"
                        onClick={() => {
                          let activeCode = syncRoomId.trim();
                          if (!activeCode && !syncEnabled) {
                            activeCode = `sunny-${Math.floor(1000 + Math.random() * 9000)}`;
                            setSyncRoomId(activeCode);
                          }
                          const next = !syncEnabled;
                          setSyncEnabled(next);
                          if (next) {
                            setTimeout(() => pushSyncSnapshot(entries), 200);
                          }
                          showToast(
                            next
                              ? `🟢 लाइव सिंक चालू हो गया (कोड: ${activeCode})`
                              : '⚪ लाइव सिंक बंद हो गया'
                          );
                        }}
                        style={{
                          flex: 1.5,
                          background: syncEnabled ? '#e11d48' : '#059669',
                          border: 'none',
                          color: '#ffffff',
                          borderRadius: '10px',
                          padding: '11px',
                          fontSize: '13px',
                          fontWeight: 800,
                          cursor: 'pointer',
                        }}
                      >
                        {syncEnabled ? 'सिंक Close (OFF)' : '✅ लाइव सिंक चालू करें'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!cleanSyncTopic) {
                            showToast('पहले गुप्त कोड डालें');
                            return;
                          }
                          pullSyncHistory(true);
                        }}
                        style={{
                          flex: 1,
                          background: '#0284c7',
                          border: 'none',
                          color: '#ffffff',
                          borderRadius: '10px',
                          padding: '11px',
                          fontSize: '12px',
                          fontWeight: 700,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '5px',
                        }}
                      >
                        <RefreshCw size={14} />
                        अभी सिंक करें
                      </button>
                    </div>
                  </div>
                </>
              ) : toolsView === 'profit_loss' ? (
                (() => {
                  const rateVal = Number(jodiRatePer10) || 0;
                  const rateMult = rateVal / 10;
                  const now = new Date();
                  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                  const todayLabel = now.toLocaleDateString('en-IN', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  });

                  const gameRows = CATEGORIES.map((cat) => {
                    const rawRes = String(gameResults?.[cat] ?? '').replace(/\D/g, '').slice(0, 2);
                    const hasResult = rawRes.length === 2;
                    const resNum = hasResult ? normalizeJodiNumber(rawRes) : '';
                    const sale = Number(categoryTotals?.[cat]) || 0;
                    const betOnRes = hasResult
                      ? entries.reduce(
                          (sum, e) =>
                            e.category === cat && e.number === resNum
                              ? sum + (Number(e.amount) || 0)
                              : sum,
                          0
                        )
                      : 0;
                    const payout = hasResult ? Math.round(betOnRes * rateMult) : 0;
                    const net = hasResult ? sale - payout : 0;
                    const savedRec = plHistory.find(
                      (h) => h.dateKey === todayKey && h.category === cat
                    );
                    const isSyncedToday =
                      Boolean(savedRec) &&
                      hasResult &&
                      savedRec.resultNum === resNum &&
                      savedRec.totalSale === sale &&
                      savedRec.payout === payout;
                    return {
                      cat,
                      rawRes,
                      hasResult,
                      resNum,
                      sale,
                      betOnRes,
                      payout,
                      net,
                      savedRec,
                      isSyncedToday,
                    };
                  });

                  const declaredRows = gameRows.filter((r) => r.hasResult);
                  const totalDeclaredSale = declaredRows.reduce((s, r) => s + r.sale, 0);
                  const totalDeclaredPayout = declaredRows.reduce((s, r) => s + r.payout, 0);
                  const grandNet = totalDeclaredSale - totalDeclaredPayout;

                  const saveRowsToHistory = (rowsToSave) => {
                    if (!rowsToSave.length) return;
                    setPlHistory((prev) => {
                      const next = [...prev];
                      rowsToSave.forEach((row) => {
                        const rec = {
                          id: `${todayKey}_${row.cat}`,
                          dateKey: todayKey,
                          dateLabel: todayLabel,
                          category: row.cat,
                          totalSale: row.sale,
                          resultNum: row.resNum,
                          betOnResult: row.betOnRes,
                          ratePer10: rateVal,
                          rateMult,
                          payout: row.payout,
                          net: row.net,
                          savedAt: Date.now(),
                        };
                        const idx = next.findIndex(
                          (item) => item.dateKey === todayKey && item.category === row.cat
                        );
                        if (idx >= 0) {
                          next[idx] = rec;
                        } else {
                          next.unshift(rec);
                        }
                      });
                      return next.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
                    });
                  };

                  // Overall running status = saved history + any unsaved declared games from today
                  const savedHistoryNet = plHistory.reduce((s, h) => s + (Number(h.net) || 0), 0);
                  const unsavedTodayDelta = declaredRows.reduce((s, r) => {
                    if (r.savedRec) {
                      return s + (r.net - (Number(r.savedRec.net) || 0));
                    }
                    return s + r.net;
                  }, 0);
                  const overallRunningNet = savedHistoryNet + unsavedTodayDelta;

                  // Filtered history for Final Hisaab tab
                  const filteredHistory =
                    plGameFilter === 'ALL'
                      ? plHistory
                      : plHistory.filter((h) => h.category === plGameFilter);
                  const histSale = filteredHistory.reduce((s, h) => s + (Number(h.totalSale) || 0), 0);
                  const histPayout = filteredHistory.reduce((s, h) => s + (Number(h.payout) || 0), 0);
                  const histNet = histSale - histPayout;

                  const copyFinalHisaab = () => {
                    const title =
                      plGameFilter === 'ALL'
                        ? '📊 FINAL HISAAB (ALL GAMES)'
                        : `📊 FINAL HISAAB (${plGameFilter})`;
                    const lines = [
                      title,
                      `Total Game: ₹${histSale.toLocaleString('en-IN')}`,
                      `Total Jodi Lagi: ₹${histPayout.toLocaleString('en-IN')}`,
                      `Final Hisaab: ${histNet >= 0 ? '+₹' : '-₹'}${Math.abs(histNet).toLocaleString('en-IN')} (${histNet >= 0 ? 'PROFIT' : 'LOSS'})`,
                      '-------------------',
                      ...filteredHistory.map(
                        (h) =>
                          `${h.dateLabel} | ${h.category} | Game: ₹${h.totalSale.toLocaleString('en-IN')} | [${h.resultNum}] ₹${h.betOnResult}×${h.rateMult}=₹${h.payout.toLocaleString('en-IN')} | ${h.net >= 0 ? '+₹' : '-₹'}${Math.abs(h.net).toLocaleString('en-IN')}`
                      ),
                    ];
                    navigator.clipboard?.writeText(lines.join('\n')).then(() => {
                      setPlCopied(true);
                      setTimeout(() => setPlCopied(false), 1800);
                    });
                  };

                  return (
                    <>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <button
                            onClick={() => setToolsView('menu')}
                            title="Tools पर Back जाएं"
                            style={{
                              background: t.inputBg,
                              border: `1px solid ${t.cardBorder}`,
                              color: t.textPrimary,
                              borderRadius: '8px',
                              padding: '5px 7px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                            }}
                          >
                            <ArrowLeft size={15} />
                          </button>
                          <div>
                            <h2 style={{ fontSize: '15px', fontWeight: 700, color: '#34d399' }}>
                              📊 Profit / Loss &amp; Rate Setting
                            </h2>
                            <p style={{ fontSize: '11px', color: t.textSecondary }}>
                              आज का हिसाब, जोड़ी रेट और पूरा इतिहास
                            </p>
                          </div>
                        </div>
                        {plTab === 'today' && declaredRows.length > 0 && (
                          <button
                            onClick={() => setGameResults({})}
                            style={{
                              background: 'rgba(244, 63, 94, 0.14)',
                              border: '1px solid rgba(244, 63, 94, 0.35)',
                              color: '#fb7185',
                              borderRadius: '8px',
                              padding: '5px 9px',
                              fontSize: '11px',
                              fontWeight: 700,
                              cursor: 'pointer',
                            }}
                          >
                            Clear Results
                          </button>
                        )}
                      </div>

                      {/* Always-visible Overall Running Profit/Loss Banner */}
                      <div
                        style={{
                          background:
                            overallRunningNet >= 0
                              ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.18), rgba(6, 95, 70, 0.25))'
                              : 'linear-gradient(135deg, rgba(244, 63, 94, 0.18), rgba(136, 19, 55, 0.25))',
                          border:
                            overallRunningNet >= 0
                              ? '1px solid rgba(16, 185, 129, 0.5)'
                              : '1px solid rgba(244, 63, 94, 0.5)',
                          borderRadius: '12px',
                          padding: '10px 12px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '10px',
                        }}
                      >
                        <div>
                          <div style={{ fontSize: '11px', fontWeight: 700, color: t.textPrimary }}>
                            📈 अब तक का कुल स्टेटस ({plHistory.length} सेव्ड)
                          </div>
                          <div style={{ fontSize: '10px', color: t.textSecondary, marginTop: '2px' }}>
                            History: {savedHistoryNet >= 0 ? '+₹' : '-₹'}
                            {Math.abs(savedHistoryNet).toLocaleString('en-IN')} • आज Live:{' '}
                            {grandNet >= 0 ? '+₹' : '-₹'}
                            {Math.abs(grandNet).toLocaleString('en-IN')}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div
                            style={{
                              fontSize: '17px',
                              fontWeight: 900,
                              color: overallRunningNet >= 0 ? '#34d399' : '#fb7185',
                            }}
                          >
                            {overallRunningNet >= 0 ? '+₹' : '-₹'}
                            {Math.abs(overallRunningNet).toLocaleString('en-IN')}
                          </div>
                          <div
                            style={{
                              fontSize: '10px',
                              fontWeight: 800,
                              color: overallRunningNet >= 0 ? '#34d399' : '#fb7185',
                            }}
                          >
                            {overallRunningNet >= 0 ? 'OVERALL PROFIT' : 'OVERALL LOSS'}
                          </div>
                        </div>
                      </div>

                      {/* Sub-Tabs: Today's Entry vs Final Hisaab */}
                      <div
                        style={{
                          display: 'flex',
                          gap: '6px',
                          background: 'rgba(15, 23, 42, 0.45)',
                          padding: '4px',
                          borderRadius: '10px',
                          border: `1px solid ${t.cardBorder}`,
                        }}
                      >
                        <button
                          onClick={() => setPlTab('today')}
                          style={{
                            flex: 1,
                            background: plTab === 'today' ? '#0284c7' : 'transparent',
                            border: 'none',
                            color: plTab === 'today' ? '#ffffff' : t.textSecondary,
                            borderRadius: '7px',
                            padding: '7px 8px',
                            fontSize: '12px',
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          📝 आज का हिसाब
                        </button>
                        <button
                          onClick={() => setPlTab('final')}
                          style={{
                            flex: 1,
                            background: plTab === 'final' ? '#10b981' : 'transparent',
                            border: 'none',
                            color: plTab === 'final' ? '#052e16' : t.textSecondary,
                            borderRadius: '7px',
                            padding: '7px 8px',
                            fontSize: '12px',
                            fontWeight: 800,
                            cursor: 'pointer',
                          }}
                        >
                          📋 Final Hisaab ({plHistory.length})
                        </button>
                      </div>

                      {plTab === 'today' ? (
                        <>
                          {/* Jodi Rate Setting */}
                          <div
                            style={{
                              background: t.inputBg,
                              border: `1px solid ${t.cardBorder}`,
                              borderRadius: '12px',
                              padding: '10px 12px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '8px',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: '8px',
                              }}
                            >
                              <span style={{ fontSize: '12px', fontWeight: 700, color: t.textPrimary }}>
                                ⚙️ जोड़ी रेट (₹10 पर)
                              </span>
                              <span style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8' }}>
                                ₹10 = ₹{rateVal} ({rateMult}x)
                              </span>
                            </div>

                            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                              {[900, 950, 1000].map((preset) => {
                                const active = rateVal === preset;
                                return (
                                  <button
                                    key={preset}
                                    onClick={() => setJodiRatePer10(preset)}
                                    style={{
                                      flex: '1 1 70px',
                                      background: active
                                        ? 'rgba(16, 185, 129, 0.2)'
                                        : 'rgba(15, 23, 42, 0.45)',
                                      border: active
                                        ? '1px solid #10b981'
                                        : `1px solid ${t.cardBorder}`,
                                      color: active ? '#34d399' : t.textPrimary,
                                      borderRadius: '8px',
                                      padding: '6px 8px',
                                      fontSize: '11px',
                                      fontWeight: 700,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    ₹{preset} ({preset / 10}x)
                                  </button>
                                );
                              })}
                              <input
                                type="number"
                                inputMode="numeric"
                                min="0"
                                value={jodiRatePer10 === 0 ? '' : jodiRatePer10}
                                onChange={(e) => {
                                  const v = Number(e.target.value);
                                  setJodiRatePer10(Number.isFinite(v) && v >= 0 ? v : 0);
                                }}
                                placeholder="Custom"
                                style={{
                                  width: '78px',
                                  background: 'rgba(15, 23, 42, 0.6)',
                                  border: `1px solid ${t.cardBorder}`,
                                  color: t.textPrimary,
                                  borderRadius: '8px',
                                  padding: '6px 8px',
                                  fontSize: '12px',
                                  fontWeight: 700,
                                  textAlign: 'center',
                                  outline: 'none',
                                }}
                              />
                            </div>
                          </div>

                          {/* Today's Summary + Save All Button */}
                          <div
                            style={{
                              background: t.inputBg,
                              border: `1px solid ${t.cardBorder}`,
                              borderRadius: '12px',
                              padding: '10px 12px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '8px',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: '10px',
                              }}
                            >
                              <div>
                                <div style={{ fontSize: '11px', color: t.textSecondary, fontWeight: 600 }}>
                                  आज का हिसाब ({declaredRows.length}/{CATEGORIES.length} घड़ी रिजल्ट)
                                </div>
                                <div style={{ fontSize: '11px', color: t.textSecondary, marginTop: '2px' }}>
                                  Sale: ₹{totalDeclaredSale.toLocaleString('en-IN')} • Lagi: ₹
                                  {totalDeclaredPayout.toLocaleString('en-IN')}
                                </div>
                              </div>
                              <div style={{ textAlign: 'right' }}>
                                <div
                                  style={{
                                    fontSize: '15px',
                                    fontWeight: 800,
                                    color:
                                      declaredRows.length === 0
                                        ? t.textSecondary
                                        : grandNet >= 0
                                          ? '#34d399'
                                          : '#fb7185',
                                  }}
                                >
                                  {declaredRows.length === 0
                                    ? '—'
                                    : `${grandNet >= 0 ? '+₹' : '-₹'}${Math.abs(grandNet).toLocaleString('en-IN')}`}
                                </div>
                              </div>
                            </div>

                            {declaredRows.length > 0 && (
                              <button
                                onClick={() => saveRowsToHistory(declaredRows)}
                                style={{
                                  width: '100%',
                                  background: '#10b981',
                                  border: 'none',
                                  color: '#052e16',
                                  borderRadius: '9px',
                                  padding: '8px 10px',
                                  fontSize: '12px',
                                  fontWeight: 800,
                                  cursor: 'pointer',
                                }}
                              >
                                💾 आज का हिसाब History में Save करें ({declaredRows.length} घड़ी)
                              </button>
                            )}
                          </div>

                          {/* Game-wise Result & Detailed Hisaab Breakdown */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {gameRows.map((row) => {
                              const isProfit = row.net >= 0;
                              return (
                                <div
                                  key={row.cat}
                                  style={{
                                    background: t.inputBg,
                                    border: row.hasResult
                                      ? isProfit
                                        ? '1px solid rgba(16, 185, 129, 0.4)'
                                        : '1px solid rgba(244, 63, 94, 0.4)'
                                      : `1px solid ${t.cardBorder}`,
                                    borderRadius: '11px',
                                    padding: '10px 11px',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '7px',
                                  }}
                                >
                                  <div
                                    style={{
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      gap: '8px',
                                    }}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                      <span
                                        style={{
                                          background: 'rgba(56, 189, 248, 0.16)',
                                          color: '#38bdf8',
                                          border: '1px solid rgba(56, 189, 248, 0.35)',
                                          borderRadius: '7px',
                                          padding: '3px 8px',
                                          fontSize: '12px',
                                          fontWeight: 800,
                                          minWidth: '34px',
                                          textAlign: 'center',
                                        }}
                                      >
                                        {row.cat}
                                      </span>
                                      <div style={{ fontSize: '12px', fontWeight: 700, color: t.textPrimary }}>
                                        Total Game: ₹{row.sale.toLocaleString('en-IN')}
                                      </div>
                                    </div>

                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      <input
                                        type="text"
                                        inputMode="numeric"
                                        maxLength={2}
                                        value={row.rawRes}
                                        onChange={(e) => {
                                          const digits = e.target.value.replace(/\D/g, '').slice(0, 2);
                                          setGameResults((prev) => ({
                                            ...(prev || {}),
                                            [row.cat]: digits,
                                          }));
                                        }}
                                        placeholder="Result"
                                        style={{
                                          width: '58px',
                                          background: 'rgba(15, 23, 42, 0.65)',
                                          border: row.hasResult
                                            ? '1px solid #38bdf8'
                                            : `1px solid ${t.cardBorder}`,
                                          color: t.textPrimary,
                                          borderRadius: '8px',
                                          padding: '5px 4px',
                                          fontSize: '13px',
                                          fontWeight: 800,
                                          textAlign: 'center',
                                          outline: 'none',
                                        }}
                                      />
                                      {row.hasResult && (
                                        <button
                                          onClick={() => saveRowsToHistory([row])}
                                          style={{
                                            background: row.isSyncedToday
                                              ? 'rgba(16, 185, 129, 0.16)'
                                              : '#0284c7',
                                            border: row.isSyncedToday
                                              ? '1px solid rgba(16, 185, 129, 0.45)'
                                              : 'none',
                                            color: row.isSyncedToday ? '#34d399' : '#ffffff',
                                            borderRadius: '7px',
                                            padding: '6px 8px',
                                            fontSize: '11px',
                                            fontWeight: 700,
                                            cursor: 'pointer',
                                          }}
                                        >
                                          {row.isSyncedToday ? '✓ Saved' : 'Save'}
                                        </button>
                                      )}
                                    </div>
                                  </div>

                                  {row.hasResult && (
                                    <div
                                      style={{
                                        background: 'rgba(15, 23, 42, 0.45)',
                                        borderRadius: '8px',
                                        padding: '7px 9px',
                                        fontSize: '11px',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '3px',
                                      }}
                                    >
                                      <div style={{ display: 'flex', justifyContent: 'space-between', color: t.textSecondary }}>
                                        <span>जोड़ी [{row.resNum}] लगी: ₹{row.betOnRes.toLocaleString('en-IN')} × {rateMult}</span>
                                        <span style={{ color: '#fbbf24', fontWeight: 700 }}>
                                          ₹{row.payout.toLocaleString('en-IN')}
                                        </span>
                                      </div>
                                      <div
                                        style={{
                                          display: 'flex',
                                          justifyContent: 'space-between',
                                          borderTop: `1px dashed ${t.cardBorder}`,
                                          paddingTop: '4px',
                                          marginTop: '2px',
                                          fontWeight: 800,
                                        }}
                                      >
                                        <span style={{ color: t.textPrimary }}>
                                          हिसब (₹{row.sale.toLocaleString('en-IN')} − ₹{row.payout.toLocaleString('en-IN')}):
                                        </span>
                                        <span style={{ color: isProfit ? '#34d399' : '#fb7185' }}>
                                          {isProfit ? '+₹' : '-₹'}
                                          {Math.abs(row.net).toLocaleString('en-IN')} ({isProfit ? 'PROFIT' : 'LOSS'})
                                        </span>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </>
                      ) : (
                        /* Final Hisaab & Game-wise History */
                        <>
                          {/* Game Filter Pills */}
                          <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                            {['ALL', ...CATEGORIES].map((cat) => {
                              const active = plGameFilter === cat;
                              return (
                                <button
                                  key={cat}
                                  onClick={() => setPlGameFilter(cat)}
                                  style={{
                                    background: active ? '#38bdf8' : t.inputBg,
                                    border: active ? '1px solid #38bdf8' : `1px solid ${t.cardBorder}`,
                                    color: active ? '#082f49' : t.textPrimary,
                                    borderRadius: '8px',
                                    padding: '5px 10px',
                                    fontSize: '11px',
                                    fontWeight: 800,
                                    cursor: 'pointer',
                                  }}
                                >
                                  {cat === 'ALL' ? 'Final Hisaab (All)' : cat}
                                </button>
                              );
                            })}
                          </div>

                          {/* Filtered Summary Card */}
                          <div
                            style={{
                              background: t.inputBg,
                              border:
                                filteredHistory.length === 0
                                  ? `1px solid ${t.cardBorder}`
                                  : histNet >= 0
                                    ? '1px solid rgba(16, 185, 129, 0.5)'
                                    : '1px solid rgba(244, 63, 94, 0.5)',
                              borderRadius: '12px',
                              padding: '10px 12px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '6px',
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '12px', fontWeight: 800, color: '#38bdf8' }}>
                                {plGameFilter === 'ALL' ? 'कुल फाइनल हिसाब' : `${plGameFilter} का फाइनल हिसाब`} ({filteredHistory.length})
                              </span>
                              {filteredHistory.length > 0 && (
                                <button
                                  onClick={copyFinalHisaab}
                                  style={{
                                    background: plCopied ? 'rgba(16, 185, 129, 0.2)' : 'rgba(56, 189, 248, 0.16)',
                                    border: '1px solid rgba(56, 189, 248, 0.35)',
                                    color: plCopied ? '#34d399' : '#38bdf8',
                                    borderRadius: '7px',
                                    padding: '4px 9px',
                                    fontSize: '11px',
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                  }}
                                >
                                  {plCopied ? '✓ Copied' : '📋 Copy Hisaab'}
                                </button>
                              )}
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: t.textSecondary }}>
                              <span>Total Game:</span>
                              <span style={{ color: t.textPrimary, fontWeight: 700 }}>
                                ₹{histSale.toLocaleString('en-IN')}
                              </span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: t.textSecondary }}>
                              <span>Total Jodi Lagi:</span>
                              <span style={{ color: '#fbbf24', fontWeight: 700 }}>
                                ₹{histPayout.toLocaleString('en-IN')}
                              </span>
                            </div>
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                borderTop: `1px dashed ${t.cardBorder}`,
                                paddingTop: '6px',
                                fontSize: '13px',
                                fontWeight: 900,
                              }}
                            >
                              <span style={{ color: t.textPrimary }}>Final Net (Minus करके):</span>
                              <span style={{ color: histNet >= 0 ? '#34d399' : '#fb7185' }}>
                                {histNet >= 0 ? '+₹' : '-₹'}
                                {Math.abs(histNet).toLocaleString('en-IN')} ({histNet >= 0 ? 'PROFIT' : 'LOSS'})
                              </span>
                            </div>
                          </div>

                          {/* History Records */}
                          {filteredHistory.length === 0 ? (
                            <div
                              style={{
                                background: t.inputBg,
                                border: `1px solid ${t.cardBorder}`,
                                borderRadius: '12px',
                                padding: '22px 14px',
                                textAlign: 'center',
                                fontSize: '12px',
                                color: t.textSecondary,
                              }}
                            >
                              अभी कोई हिसाब सेव नहीं है। &ldquo;📝 आज का हिसाब&rdquo; में रिजल्ट डालकर Save करें।
                            </div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                              {filteredHistory.map((h) => {
                                const isP = h.net >= 0;
                                return (
                                  <div
                                    key={h.id}
                                    style={{
                                      background: t.inputBg,
                                      border: isP
                                        ? '1px solid rgba(16, 185, 129, 0.35)'
                                        : '1px solid rgba(244, 63, 94, 0.35)',
                                      borderRadius: '11px',
                                      padding: '9px 11px',
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: '4px',
                                    }}
                                  >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                                        <span
                                          style={{
                                            background: 'rgba(56, 189, 248, 0.16)',
                                            color: '#38bdf8',
                                            borderRadius: '6px',
                                            padding: '2px 7px',
                                            fontSize: '11px',
                                            fontWeight: 800,
                                          }}
                                        >
                                          {h.category}
                                        </span>
                                        <span style={{ fontSize: '11px', color: t.textSecondary, fontWeight: 600 }}>
                                          {h.dateLabel}
                                        </span>
                                      </div>
                                      <button
                                        onClick={() =>
                                          setPlHistory((prev) => prev.filter((item) => item.id !== h.id))
                                        }
                                        title="Delete entry"
                                        style={{
                                          background: 'transparent',
                                          border: 'none',
                                          color: '#fb7185',
                                          fontSize: '14px',
                                          fontWeight: 700,
                                          cursor: 'pointer',
                                          padding: '0 4px',
                                        }}
                                      >
                                        ×
                                      </button>
                                    </div>
                                    <div style={{ fontSize: '11px', color: t.textPrimary, fontWeight: 600 }}>
                                      Total Game: ₹{Number(h.totalSale).toLocaleString('en-IN')}
                                    </div>
                                    <div style={{ fontSize: '11px', color: t.textSecondary }}>
                                      जोड़ी [{h.resultNum}] लगी: ₹{Number(h.betOnResult).toLocaleString('en-IN')} × {h.rateMult} = ₹
                                      {Number(h.payout).toLocaleString('en-IN')}
                                    </div>
                                    <div
                                      style={{
                                        fontSize: '12px',
                                        fontWeight: 800,
                                        color: isP ? '#34d399' : '#fb7185',
                                      }}
                                    >
                                      हिसब: {isP ? '+₹' : '-₹'}
                                      {Math.abs(h.net).toLocaleString('en-IN')} ({isP ? 'PROFIT' : 'LOSS'})
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </>
                      )}
                    </>
                  );
                })()
              ) : toolsView === 'failed_patterns' ? (
                <>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        onClick={() => setToolsView('menu')}
                        title="Tools पर Back जाएं"
                        style={{
                          background: t.inputBg,
                          border: `1px solid ${t.cardBorder}`,
                          color: t.textPrimary,
                          borderRadius: '8px',
                          padding: '5px 7px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                        }}
                      >
                        <ArrowLeft size={15} />
                      </button>
                      <div>
                        <h2 style={{ fontSize: '15px', fontWeight: 700, color: '#fb7185' }}>
                          ⚠️ Failed Patterns History ({failedPatterns.length})
                        </h2>
                        <p style={{ fontSize: '11px', color: t.textSecondary }}>
                          इन्हें कॉपी करके भेजें ताकि हम तुरंत फिक्स कर सकें
                        </p>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={() => pullFailedBackup(true)}
                        title="चारों फोनों के Failed Patterns एक जगह लाएं"
                        style={{
                          background: 'rgba(2, 132, 199, 0.16)',
                          border: '1px solid #38bdf8',
                          color: '#38bdf8',
                          borderRadius: '8px',
                          padding: '4px 8px',
                          fontSize: '11px',
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        🔄 4-फोन लाएं
                      </button>
                      {failedPatterns.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setFailedPatterns([]);
                            showToast('Failed Patterns History साफ़ हो गई');
                          }}
                          style={{
                            background: 'rgba(225, 29, 72, 0.14)',
                            border: '1px solid #f43f5e',
                            color: '#fb7185',
                            borderRadius: '8px',
                            padding: '4px 8px',
                            fontSize: '11px',
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          Clear
                        </button>
                      )}
                      <button
                        onClick={() => setToolsView(null)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: t.textSecondary,
                          cursor: 'pointer',
                        }}
                      >
                        <X size={20} />
                      </button>
                    </div>
                  </div>

                  <div
                    className="grid-scroll"
                    style={{
                      overflowY: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                      maxHeight: '320px',
                    }}
                  >
                    {failedPatterns.length === 0 ? (
                      <p
                        style={{
                          fontSize: '13px',
                          color: t.textMuted,
                          textAlign: 'center',
                          padding: '24px 0',
                        }}
                      >
                        अभी कोई भी Failed Patterns नहीं है ✓
                      </p>
                    ) : (
                      failedPatterns.map((fp) => (
                        <div
                          key={fp.id}
                          style={{
                            background: t.inputBg,
                            border: '1px solid rgba(244, 63, 94, 0.4)',
                            borderRadius: '10px',
                            padding: '8px 10px',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              fontSize: '10px',
                              color: t.textMuted,
                              marginBottom: '4px',
                            }}
                          >
                            <span>
                              {fp.category} • {fp.time}
                            </span>
                            <span style={{ color: '#fb7185', fontWeight: 700 }}>{fp.reason}</span>
                          </div>
                          <div
                            style={{
                              fontSize: '12px',
                              fontWeight: 700,
                              color: t.textPrimary,
                              fontFamily: 'monospace',
                              wordBreak: 'break-word',
                            }}
                          >
                            {fp.rawLine}
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {failedPatterns.length > 0 && (
                    <button
                      type="button"
                      onClick={handleCopyFailedPatterns}
                      style={{
                        width: '100%',
                        background: copiedKey === 'FAILED_ALL' ? '#059669' : '#e11d48',
                        border: 'none',
                        color: '#ffffff',
                        borderRadius: '12px',
                        padding: '12px',
                        fontSize: '13px',
                        fontWeight: 800,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '6px',
                      }}
                    >
                      {copiedKey === 'FAILED_ALL' ? <Check size={16} /> : <Copy size={16} />}
                      {copiedKey === 'FAILED_ALL'
                        ? 'फेल History कॉपी हो गई ✓'
                        : `सारी फेल History Copy (${failedPatterns.length})`}
                    </button>
                  )}
                </>
              ) : (
                <>
                  {/* Full Category Entry History View (with Time + Remove button) */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        onClick={() => setToolsView('menu')}
                        title="Tools पर Back जाएं"
                        style={{
                          background: t.inputBg,
                          border: `1px solid ${t.cardBorder}`,
                          color: t.textPrimary,
                          borderRadius: '8px',
                          padding: '5px 7px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                        }}
                      >
                        <ArrowLeft size={15} />
                      </button>
                      <div>
                        <h2 style={{ fontSize: '15px', fontWeight: 700, color: t.textPrimary }}>
                          📜 {effectiveHistoryCat === 'ALL' ? 'All Games' : effectiveHistoryCat} — History ({filteredHistoryTransactions.length})
                        </h2>
                        <p style={{ fontSize: '11px', color: t.textSecondary }}>
                          WhatsApp बटन दबाकर असली मैसेज देखें व कॉपी करें
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setToolsView(null)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: t.textSecondary,
                        cursor: 'pointer',
                      }}
                    >
                      <X size={20} />
                    </button>
                  </div>

                  {/* Game Category Filter Pills in History */}
                  <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', paddingBottom: '4px' }}>
                    {['ALL', ...CATEGORIES].map((catOpt) => {
                      const active = effectiveHistoryCat === catOpt;
                      return (
                        <button
                          key={`hist-cat-${catOpt}`}
                          type="button"
                          onClick={() => setHistoryCategoryFilter(catOpt)}
                          style={{
                            padding: '4px 10px',
                            borderRadius: '999px',
                            fontSize: '11px',
                            fontWeight: 800,
                            cursor: 'pointer',
                            background: active ? t.accent : t.inputBg,
                            color: active ? '#ffffff' : t.textSecondary,
                            border: `1px solid ${active ? t.accent : t.cardBorder}`,
                          }}
                        >
                          {catOpt === 'ALL' ? 'All' : catOpt}
                        </button>
                      );
                    })}
                  </div>

                  <div
                    className="grid-scroll"
                    style={{
                      overflowY: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      maxHeight: '350px',
                    }}
                  >
                    {filteredHistoryTransactions.length === 0 ? (
                      <p
                        style={{
                          fontSize: '13px',
                          color: t.textMuted,
                          textAlign: 'center',
                          padding: '24px 0',
                        }}
                      >
                        No entries in {effectiveHistoryCat === 'ALL' ? 'any game' : effectiveHistoryCat} yet.
                      </p>
                    ) : (
                      filteredHistoryTransactions.map((tx, idx) => {
                        const isOpen = expandedBatchId === tx.batchId;
                        const srcMsg = batchSources[tx.batchId] || '';
                        const previewText = tx.items
                          .slice(0, 5)
                          .map((x) => `${String(x.number).padStart(2, '0')}=₹${x.amount}`)
                          .join(', ') + (tx.items.length > 5 ? ` +${tx.items.length - 5} more` : '');
                        return (
                          <div
                            key={tx.batchId}
                            style={{
                              background: t.inputBg,
                              border: `1px solid ${isOpen ? t.accent : t.cardBorder}`,
                              borderRadius: '12px',
                              padding: '10px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '8px',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: '6px',
                              }}
                            >
                              <div
                                onClick={() => setExpandedBatchId(isOpen ? null : tx.batchId)}
                                style={{ flex: 1, cursor: 'pointer', minWidth: 0 }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                                  <span
                                    style={{
                                      fontSize: '10px',
                                      fontWeight: 800,
                                      padding: '1px 6px',
                                      borderRadius: '6px',
                                      background: t.accentSoft,
                                      color: t.accentText,
                                    }}
                                  >
                                    {tx.category}
                                  </span>
                                  <span style={{ fontSize: '12px', fontWeight: 800, color: t.textPrimary }}>
                                    #{filteredHistoryTransactions.length - idx} • {tx.items.length}J
                                  </span>
                                  <span style={{ fontSize: '12px', fontWeight: 800, color: t.accentText }}>
                                    ₹{tx.totalAmount.toLocaleString('en-IN')}
                                  </span>
                                  <span style={{ fontSize: '10px', color: t.textMuted }}>
                                    • {tx.time}
                                  </span>
                                </div>
                                <div style={{ fontSize: '11px', color: t.textSecondary, marginTop: '3px' }}>
                                  {previewText} {isOpen ? '▲' : '▼'}
                                </div>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0 }}>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setHistoryWhatsAppPopup({
                                      batchId: tx.batchId,
                                      category: tx.category,
                                      time: tx.time,
                                      count: tx.items.length,
                                      totalAmount: tx.totalAmount,
                                      rawText: srcMsg,
                                    })
                                  }
                                  title="View exact WhatsApp message"
                                  style={{
                                    background: 'rgba(16, 185, 129, 0.16)',
                                    border: '1px solid #10b981',
                                    color: '#34d399',
                                    borderRadius: '8px',
                                    padding: '6px 8px',
                                    fontSize: '10px',
                                    fontWeight: 800,
                                    cursor: 'pointer',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  WhatsApp
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteBatch(tx.items)}
                                  title="Delete entire pattern"
                                  style={{
                                    background: 'rgba(225, 29, 72, 0.14)',
                                    border: '1px solid #f43f5e',
                                    color: '#fb7185',
                                    borderRadius: '8px',
                                    padding: '6px 8px',
                                    fontSize: '10px',
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '3px',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  <Trash2 size={12} />
                                  Del
                                </button>
                              </div>
                            </div>

                            {isOpen && (
                              <div
                                style={{
                                  borderTop: `1px dashed ${t.cardBorder}`,
                                  paddingTop: '8px',
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: '5px',
                                }}
                              >
                                {tx.items.map((ent) => (
                                  <span
                                    key={ent.id}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '5px',
                                      background: t.cardBg,
                                      border: `1px solid ${t.cardBorder}`,
                                      borderRadius: '7px',
                                      padding: '3px 7px',
                                      fontSize: '11px',
                                      fontWeight: 700,
                                      color: t.textPrimary,
                                    }}
                                  >
                                    <span>
                                      {String(ent.number).padStart(2, '0')} ={' '}
                                      <span style={{ color: t.accentText }}>₹{ent.amount}</span>
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteEntry(ent.id)}
                                      title="Delete this jodi"
                                      style={{
                                        background: 'transparent',
                                        border: 'none',
                                        color: '#fb7185',
                                        cursor: 'pointer',
                                        padding: 0,
                                        fontSize: '12px',
                                        lineHeight: 1,
                                      }}
                                    >
                                      ×
                                    </button>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Box Detail / History Modal */}
        {selectedBox !== null && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(2, 6, 23, 0.65)',
              display: 'flex',
              alignItems: 'flex-end',
              zIndex: 40,
            }}
            onClick={() => setSelectedBox(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '100%',
                background: t.headerBg,
                borderTopLeftRadius: '20px',
                borderTopRightRadius: '20px',
                borderTop: `1px solid ${t.cardBorder}`,
                padding: '16px',
                maxHeight: '70%',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <History size={18} color="#0284c7" />
                  <h2 style={{ fontSize: '16px', fontWeight: 700, color: t.textPrimary }}>
                    {activeCategory} — Numbers {String(selectedBox).padStart(2, '0')}
                  </h2>
                  <span
                    style={{
                      background: t.accentSoft,
                      color: t.accentText,
                      padding: '2px 8px',
                      borderRadius: '999px',
                      fontSize: '12px',
                      fontWeight: 700,
                    }}
                  >
                    कुल: ₹{boxTotals[selectedBox]}
                  </span>
                </div>
                <button
                  onClick={() => setSelectedBox(null)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: t.textSecondary,
                    cursor: 'pointer',
                  }}
                >
                  <X size={20} />
                </button>
              </div>

              <form
                onSubmit={handleAddToSelectedBox}
                style={{ display: 'flex', gap: '8px' }}
              >
                <input
                  type="number"
                  min="1"
                  value={quickBoxAmount}
                  onChange={(e) => setQuickBoxAmount(e.target.value)}
                  placeholder="Enter amount (e.g. 50)"
                  autoFocus
                  style={{
                    flex: 1,
                    background: t.inputBg,
                    border: `1px solid ${t.cardBorder}`,
                    borderRadius: '10px',
                    padding: '10px',
                    color: t.textPrimary,
                    fontSize: '14px',
                    outline: 'none',
                  }}
                />
                <button
                  type="submit"
                  style={{
                    background: t.accent,
                    border: 'none',
                    color: '#ffffff',
                    fontWeight: 700,
                    borderRadius: '10px',
                    padding: '0 16px',
                    cursor: 'pointer',
                  }}
                >
                  + Add
                </button>
              </form>

              <div
                className="grid-scroll"
                style={{
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  maxHeight: '220px',
                }}
              >
                {selectedBoxEntries.length === 0 ? (
                  <p
                    style={{
                      fontSize: '13px',
                      color: t.textMuted,
                      textAlign: 'center',
                      padding: '16px 0',
                    }}
                  >
                    अभी इस Numbers पर कोई एंट्री नहीं है।
                  </p>
                ) : (
                  selectedBoxEntries.map((item) => {
                    const srcMsg = (item.batchId && batchSources[item.batchId]) || item.rawText || '';
                    const isExpanded = expandedEntryId === item.id;
                    return (
                      <div
                        key={item.id}
                        style={{
                          background: t.inputBg,
                          borderRadius: '10px',
                          border: `1px solid ${isExpanded ? t.accent : t.cardBorder}`,
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          onClick={() => setExpandedEntryId(isExpanded ? null : item.id)}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '8px 12px',
                            cursor: 'pointer',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontWeight: 700, color: t.textPrimary }}>
                              ₹{item.amount}
                            </span>
                            <span style={{ fontSize: '11px', color: t.textMuted }}>
                              {new Date(item.createdAt).toLocaleTimeString('hi-IN', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                            <span
                              style={{
                                fontSize: '10px',
                                fontWeight: 700,
                                color: srcMsg ? t.accentText : t.textMuted,
                              }}
                            >
                              {srcMsg ? (isExpanded ? '▲ Hide Msg' : '▼ View Msg') : ''}
                            </span>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteEntry(item.id);
                            }}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: '#ef4444',
                              cursor: 'pointer',
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                        {isExpanded && (
                          <div
                            style={{
                              borderTop: `1px dashed ${t.cardBorder}`,
                              padding: '8px 12px',
                              background: 'rgba(15, 23, 42, 0.55)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '6px',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                              }}
                            >
                              <span style={{ fontSize: '10px', fontWeight: 700, color: '#94a3b8' }}>
                                Exact WhatsApp Message:
                              </span>
                              {srcMsg && (
                                <button
                                  type="button"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    try {
                                      await navigator.clipboard.writeText(srcMsg);
                                      showToast('Message Copied — WhatsApp में Search करें ✓');
                                    } catch {
                                      showToast('Copy failed');
                                    }
                                  }}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                    padding: '3px 8px',
                                    borderRadius: '6px',
                                    border: `1px solid ${t.accent}`,
                                    background: t.accentSoft,
                                    color: t.accentText,
                                    fontSize: '10px',
                                    fontWeight: 800,
                                    cursor: 'pointer',
                                  }}
                                >
                                  <Copy size={11} /> Copy Msg
                                </button>
                              )}
                            </div>
                            <div
                              style={{
                                fontSize: '11px',
                                fontFamily: 'monospace',
                                color: t.textPrimary,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                maxHeight: '130px',
                                overflowY: 'auto',
                              }}
                            >
                              {srcMsg || 'Manual entry / पुराना डेटा (WhatsApp मैसेज उपलब्ध नहीं)'}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* History Exact WhatsApp Message Popup Modal */}
        {historyWhatsAppPopup && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(2, 6, 23, 0.92)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '14px',
              zIndex: 70,
            }}
            onClick={() => setHistoryWhatsAppPopup(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '100%',
                background: t.cardBg,
                border: '2px solid #10b981',
                borderRadius: '18px',
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                boxShadow: '0 20px 50px rgba(0, 0, 0, 0.7)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#34d399' }}>
                    💬 Exact WhatsApp Message
                  </h3>
                  <div style={{ fontSize: '11px', color: t.textSecondary, marginTop: '2px' }}>
                    {historyWhatsAppPopup.category} • {historyWhatsAppPopup.count} Jodis • ₹
                    {historyWhatsAppPopup.totalAmount.toLocaleString('en-IN')} • {historyWhatsAppPopup.time}
                  </div>
                </div>
                <button
                  onClick={() => setHistoryWhatsAppPopup(null)}
                  style={{ background: 'transparent', border: 'none', color: t.textSecondary, cursor: 'pointer' }}
                >
                  <X size={20} />
                </button>
              </div>
              <div
                className="grid-scroll"
                style={{
                  background: t.inputBg,
                  border: `1px solid ${t.cardBorder}`,
                  borderRadius: '12px',
                  padding: '12px',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  color: t.textPrimary,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: '260px',
                  overflowY: 'auto',
                }}
              >
                {historyWhatsAppPopup.rawText ||
                  'Manual entry / पुराना डेटा (इस एंट्री का WhatsApp मैसेज सेव नहीं था)'}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => setHistoryWhatsAppPopup(null)}
                  style={{
                    flex: 1,
                    background: t.inputBg,
                    border: `1px solid ${t.cardBorder}`,
                    color: t.textPrimary,
                    borderRadius: '10px',
                    padding: '11px',
                    fontSize: '12px',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Close
                </button>
                {historyWhatsAppPopup.rawText && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(historyWhatsAppPopup.rawText);
                        showToast('WhatsApp Message Copied — Search में पेस्ट करें ✓');
                      } catch {
                        showToast('Copy failed');
                      }
                    }}
                    style={{
                      flex: 1.6,
                      background: '#10b981',
                      border: 'none',
                      color: '#000000',
                      borderRadius: '10px',
                      padding: '11px',
                      fontSize: '12px',
                      fontWeight: 800,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '6px',
                    }}
                  >
                    <Copy size={14} /> Copy WhatsApp Msg
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Focused Full-Screen Confirmation Preview Modal before Adding */}
        {pendingConfirm && (() => {
          if (pendingConfirm.isError) {
            return (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(2, 6, 23, 0.94)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '14px',
                  zIndex: 60,
                }}
                onClick={handleCancelPendingAdd}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    width: '100%',
                    background: t.cardBg,
                    border: '2px solid #f43f5e',
                    borderRadius: '20px',
                    padding: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                    boxShadow: '0 20px 50px rgba(0, 0, 0, 0.7)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h2 style={{ fontSize: '16px', fontWeight: 800, color: '#fb7185' }}>
                      ❌ FAILED — पैटर्न समझ नहीं आया
                    </h2>
                    <button
                      onClick={handleCancelPendingAdd}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: t.textSecondary,
                        cursor: 'pointer',
                      }}
                    >
                      <X size={20} />
                    </button>
                  </div>
                  <p style={{ fontSize: '12px', color: t.textSecondary }}>
                    यह पर्ची Failed Patterns History में सेव हो गई है।{' '}
                    <strong style={{ color: '#fbbf24' }}>
                      {failCountdown} सेकंड में अपने-आप बंद हो जाएगा...
                    </strong>
                  </p>
                  <div
                    style={{
                      background: t.inputBg,
                      border: '1px solid rgba(244, 63, 94, 0.45)',
                      borderRadius: '10px',
                      padding: '10px',
                      fontSize: '12px',
                      fontFamily: 'monospace',
                      color: t.textPrimary,
                      maxHeight: '150px',
                      overflowY: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {pendingConfirm.rawText}
                  </div>
                  <button
                    type="button"
                    onClick={handleCancelPendingAdd}
                    style={{
                      width: '100%',
                      background: '#e11d48',
                      border: 'none',
                      color: '#ffffff',
                      borderRadius: '10px',
                      padding: '12px',
                      fontSize: '13px',
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    ठीक है (Back चैट पर जाएं)
                  </button>
                </div>
              </div>
            );
          }

          const msgTotal = pendingConfirm.results.reduce((s, x) => s + x.amount, 0);
          const declaredTotal = extractDeclaredTotal(pendingConfirm.rawText);
          const currentCatTotal = categoryTotals[activeCategory] || 0;
          const nextCatTotal = currentCatTotal + msgTotal;
          const totalMatches = declaredTotal !== null && Math.abs(declaredTotal - msgTotal) < 0.01;

          return (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(2, 6, 23, 0.94)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '14px',
                zIndex: 60,
              }}
              onClick={handleCancelPendingAdd}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: '100%',
                  background: t.cardBg,
                  border: `2px solid ${t.accent}`,
                  borderRadius: '20px',
                  padding: '16px',
                  maxHeight: '88vh',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  boxShadow: '0 20px 50px rgba(0, 0, 0, 0.7)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 style={{ fontSize: '15px', fontWeight: 800, color: t.textPrimary }}>
                    {pendingConfirm.step === 2
                      ? `✅ ${activeCategory} — Review Generated Jodis`
                      : `✅ ${activeCategory} — Confirm Add`}
                  </h2>
                  <button
                    onClick={handleCancelPendingAdd}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: t.textSecondary,
                      cursor: 'pointer',
                    }}
                  >
                    <X size={20} />
                  </button>
                </div>

                {/* Duplicate WhatsApp Message Alert */}
                {pendingConfirm.duplicateMatch && (
                  <div
                    style={{
                      fontSize: '11px',
                      fontWeight: 800,
                      color: '#fde047',
                      background: 'rgba(234, 179, 8, 0.16)',
                      border: '1.5px solid #eab308',
                      borderRadius: '10px',
                      padding: '8px 10px',
                    }}
                  >
                    ⚠️ यह मैसेज पहले से जुड़ा हुआ है! ({pendingConfirm.duplicateMatch.category} •{' '}
                    {pendingConfirm.duplicateMatch.time} • {pendingConfirm.duplicateMatch.count}J • ₹
                    {pendingConfirm.duplicateMatch.total.toLocaleString('en-IN')}) — क्या आप फिर भी दोबारा जोड़ना चाहते हैं?
                  </div>
                )}

                {/* Big Total Match & Game Total Card */}
                <div
                  style={{
                    background: '#000000',
                    border: '1.5px solid #f59e0b',
                    borderRadius: '12px',
                    padding: '10px 12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', color: '#cbd5e1', fontWeight: 600 }}>
                      Message Total ({pendingConfirm.results.length} numbers):
                    </span>
                    <span style={{ fontSize: '18px', fontWeight: 800, color: '#fbbf24' }}>
                      ₹{msgTotal.toLocaleString('en-IN')}
                    </span>
                  </div>
                  {declaredTotal !== null && (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '11px',
                        fontWeight: 700,
                        color: totalMatches ? '#6ee7b7' : '#fb7185',
                      }}
                    >
                      <span>Customer Total: ₹{declaredTotal.toLocaleString('en-IN')}</span>
                      <span>{totalMatches ? '✓ Total Matched' : '⚠️ Total Mismatch'}</span>
                    </div>
                  )}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: '11px',
                      color: '#94a3b8',
                      borderTop: '1px dashed #334155',
                      paddingTop: '4px',
                      marginTop: '2px',
                    }}
                  >
                    <span>{activeCategory} Game Total (After Add):</span>
                    <strong style={{ color: '#38bdf8' }}>
                      ₹{currentCatTotal.toLocaleString('en-IN')} → ₹{nextCatTotal.toLocaleString('en-IN')}
                    </strong>
                  </div>
                </div>

                {pendingConfirm.failed.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setPendingConfirm((prev) => (prev ? { ...prev, viewTab: 'failed' } : null))
                    }
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      fontSize: '11px',
                      fontWeight: 700,
                      color: '#fb7185',
                      background: 'rgba(225, 29, 72, 0.12)',
                      border: '1px solid rgba(244, 63, 94, 0.4)',
                      borderRadius: '8px',
                      padding: '6px 9px',
                      cursor: 'pointer',
                    }}
                  >
                    ⚠️ {pendingConfirm.failed.length} लाइन समझ नहीं आई — यहाँ क्लिक करके अलग देखें / कॉपी करें
                  </button>
                )}

                {pendingConfirm.step === 2 ? (
                  <div
                    className="grid-scroll"
                    style={{
                      overflowY: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px',
                      maxHeight: '260px',
                      padding: '2px 0',
                    }}
                  >
                    {(pendingConfirm.specialPreviews || []).map((sp, sIdx) => (
                      <div
                        key={`step2-${sp.kind}-${sIdx}`}
                        style={{
                          background: t.inputBg,
                          border: `1px solid ${t.accent}`,
                          borderRadius: '10px',
                          padding: '8px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '12px', fontWeight: 800, color: t.accentText }}>
                            {sp.kind === 'haruf' ? '🎯 Haruf' : '🔀 Crossing'}: {sp.raw}
                          </span>
                          <span style={{ fontSize: '11px', fontWeight: 700, color: t.textSecondary }}>
                            {sp.count} Jodis • ₹{sp.total.toLocaleString('en-IN')}
                          </span>
                        </div>
                        {sp.kind === 'crossing' && (
                          <div style={{ display: 'flex', gap: '6px', marginTop: '2px' }}>
                            <button
                              type="button"
                              onClick={() => toggleCrossingJodaCut(sIdx, false)}
                              style={{
                                flex: 1,
                                padding: '4px 6px',
                                borderRadius: '7px',
                                fontSize: '10px',
                                fontWeight: 700,
                                cursor: 'pointer',
                                background: !sp.isJodaCut ? t.accent : t.cardBg,
                                color: !sp.isJodaCut ? '#ffffff' : t.textSecondary,
                                border: `1px solid ${!sp.isJodaCut ? t.accent : t.cardBorder}`,
                              }}
                            >
                              With Joda (जोड़े के साथ)
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleCrossingJodaCut(sIdx, true)}
                              style={{
                                flex: 1,
                                padding: '4px 6px',
                                borderRadius: '7px',
                                fontSize: '10px',
                                fontWeight: 700,
                                cursor: 'pointer',
                                background: sp.isJodaCut ? t.accent : t.cardBg,
                                color: sp.isJodaCut ? '#ffffff' : t.textSecondary,
                                border: `1px solid ${sp.isJodaCut ? t.accent : t.cardBorder}`,
                              }}
                            >
                              Joda Cut (11..100 कट)
                            </button>
                          </div>
                        )}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                          {(sp.items || []).map((item, jIdx) => (
                            <span
                              key={`${item.number}-${jIdx}`}
                              style={{
                                background: t.cardBg,
                                border: `1px solid ${t.cardBorder}`,
                                borderRadius: '7px',
                                padding: '4px 8px',
                                fontSize: '11px',
                                fontWeight: 700,
                                color: t.textPrimary,
                              }}
                            >
                              {String(item.number).padStart(2, '0')} ={' '}
                              <span style={{ color: t.accentText }}>₹{item.amount}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                    {Array.isArray(pendingConfirm.normalResults) &&
                      pendingConfirm.normalResults.length > 0 && (
                        <div
                          style={{
                            background: t.inputBg,
                            border: `1px solid ${t.cardBorder}`,
                            borderRadius: '10px',
                            padding: '8px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px',
                          }}
                        >
                          <div style={{ fontSize: '12px', fontWeight: 800, color: t.textPrimary }}>
                            📌 Normal Jodis ({pendingConfirm.normalResults.length})
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                            {pendingConfirm.normalResults.map((item, idx) => (
                              <span
                                key={`n-${item.number}-${idx}`}
                                style={{
                                  background: t.cardBg,
                                  border: `1px solid ${t.cardBorder}`,
                                  borderRadius: '7px',
                                  padding: '4px 8px',
                                  fontSize: '11px',
                                  fontWeight: 700,
                                  color: t.textPrimary,
                                }}
                              >
                                {String(item.number).padStart(2, '0')} ={' '}
                                <span style={{ color: t.accentText }}>₹{item.amount}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                  </div>
                ) : (
                  <>
                    {Array.isArray(pendingConfirm.specialPreviews) &&
                      pendingConfirm.specialPreviews.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {pendingConfirm.specialPreviews.map((sp, sIdx) => (
                            <div
                              key={`${sp.kind}-${sIdx}`}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                background: t.accentSoft,
                                border: `1px solid ${t.accent}`,
                                borderRadius: '10px',
                                padding: '8px 10px',
                                gap: '8px',
                              }}
                            >
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontSize: '12px', fontWeight: 800, color: t.accentText }}>
                                  {sp.kind === 'haruf' ? '🎯 Haruf' : '🔀 Crossing'}:{' '}
                                  <span style={{ color: t.textPrimary }}>{sp.raw}</span>
                                </div>
                                <div style={{ fontSize: '10px', color: t.textSecondary, marginTop: '2px' }}>
                                  Tap Confirm to view {sp.count} Jodis (₹{sp.perAmt} each)
                                </div>
                                {sp.kind === 'crossing' && (
                                  <div style={{ display: 'flex', gap: '5px', marginTop: '5px' }}>
                                    <button
                                      type="button"
                                      onClick={() => toggleCrossingJodaCut(sIdx, false)}
                                      style={{
                                        padding: '3px 7px',
                                        borderRadius: '6px',
                                        fontSize: '10px',
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                        background: !sp.isJodaCut ? t.accent : t.cardBg,
                                        color: !sp.isJodaCut ? '#ffffff' : t.textSecondary,
                                        border: `1px solid ${!sp.isJodaCut ? t.accent : t.cardBorder}`,
                                      }}
                                    >
                                      With Joda
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => toggleCrossingJodaCut(sIdx, true)}
                                      style={{
                                        padding: '3px 7px',
                                        borderRadius: '6px',
                                        fontSize: '10px',
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                        background: sp.isJodaCut ? t.accent : t.cardBg,
                                        color: sp.isJodaCut ? '#ffffff' : t.textSecondary,
                                        border: `1px solid ${sp.isJodaCut ? t.accent : t.cardBorder}`,
                                      }}
                                    >
                                      Joda Cut (11..100 कट)
                                    </button>
                                  </div>
                                )}
                              </div>
                              <span style={{ fontSize: '14px', fontWeight: 800, color: t.textPrimary, whiteSpace: 'nowrap' }}>
                                ₹{sp.total.toLocaleString('en-IN')}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                    <div
                      style={{
                        display: 'flex',
                        gap: '6px',
                        background: t.inputBg,
                        padding: '4px',
                        borderRadius: '10px',
                        border: `1px solid ${t.cardBorder}`,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setPendingConfirm((prev) => (prev ? { ...prev, viewTab: 'numbers' } : null))
                        }
                        style={{
                          flex: 1,
                          padding: '6px 8px',
                          borderRadius: '7px',
                          border: 'none',
                          fontSize: '11px',
                          fontWeight: 800,
                          cursor: 'pointer',
                          background: (pendingConfirm.viewTab || 'numbers') === 'numbers' ? t.accent : 'transparent',
                          color: (pendingConfirm.viewTab || 'numbers') === 'numbers' ? '#ffffff' : t.textSecondary,
                        }}
                      >
                        01–100 View ({pendingConfirm.results.length})
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setPendingConfirm((prev) => (prev ? { ...prev, viewTab: 'parchi' } : null))
                        }
                        style={{
                          flex: 1,
                          padding: '6px 8px',
                          borderRadius: '7px',
                          border: 'none',
                          fontSize: '11px',
                          fontWeight: 800,
                          cursor: 'pointer',
                          background: pendingConfirm.viewTab === 'parchi' ? t.accent : 'transparent',
                          color: pendingConfirm.viewTab === 'parchi' ? '#ffffff' : t.textSecondary,
                        }}
                      >
                        Parchi Line View ({(pendingConfirm.lineBreakdown || []).length})
                      </button>
                      {pendingConfirm.failed.length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setPendingConfirm((prev) => (prev ? { ...prev, viewTab: 'failed' } : null))
                          }
                          style={{
                            flex: 0.9,
                            padding: '6px 8px',
                            borderRadius: '7px',
                            border: 'none',
                            fontSize: '11px',
                            fontWeight: 800,
                            cursor: 'pointer',
                            background: pendingConfirm.viewTab === 'failed' ? '#e11d48' : 'transparent',
                            color: pendingConfirm.viewTab === 'failed' ? '#ffffff' : '#fb7185',
                          }}
                        >
                          ❌ Failed ({pendingConfirm.failed.length})
                        </button>
                      )}
                    </div>

                    {pendingConfirm.viewTab === 'failed' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', color: '#fb7185', fontWeight: 700 }}>
                            Unparsed Lines (बाद में फिक्स करने के लिए)
                          </span>
                          <button
                            type="button"
                            onClick={async () => {
                              const out = pendingConfirm.failed
                                .map((f, idx) => `${idx + 1}. ${f.rawLine}`)
                                .join('\n');
                              try {
                                await navigator.clipboard.writeText(out);
                                showToast(`${pendingConfirm.failed.length} Failed Lines Copied ✓`);
                              } catch {
                                showToast('Copy failed');
                              }
                            }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px',
                              padding: '5px 10px',
                              borderRadius: '8px',
                              border: '1px solid rgba(244, 63, 94, 0.6)',
                              background: 'rgba(225, 29, 72, 0.16)',
                              color: '#fda4af',
                              fontSize: '11px',
                              fontWeight: 800,
                              cursor: 'pointer',
                            }}
                          >
                            <Copy size={12} /> Copy Failed
                          </button>
                        </div>
                        <div
                          className="grid-scroll"
                          style={{
                            overflowY: 'auto',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '5px',
                            maxHeight: '220px',
                            paddingRight: '2px',
                          }}
                        >
                          {pendingConfirm.failed.map((f, fIdx) => (
                            <div
                              key={`fail-tab-${fIdx}`}
                              style={{
                                background: 'rgba(225, 29, 72, 0.12)',
                                border: '1px solid rgba(244, 63, 94, 0.45)',
                                borderRadius: '8px',
                                padding: '6px 9px',
                              }}
                            >
                              <div
                                style={{
                                  fontSize: '11px',
                                  fontFamily: 'monospace',
                                  fontWeight: 700,
                                  color: '#fda4af',
                                  wordBreak: 'break-word',
                                }}
                              >
                                {fIdx + 1}. {f.rawLine}
                              </div>
                              <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '2px' }}>
                                {f.reason}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : pendingConfirm.viewTab === 'parchi' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '11px', color: t.textSecondary, fontWeight: 700 }}>
                            Line-by-Line Total Check
                          </span>
                          <button
                            type="button"
                            onClick={async () => {
                              const linesOut = [
                                `*${activeCategory} Parchi Breakdown*`,
                                ...(pendingConfirm.lineBreakdown || []).map((row) => {
                                  if (row.status === 'parsed') {
                                    return `#${row.lineNo} ${row.raw}  =>  ${row.count} Jodi = ₹${row.total}`;
                                  }
                                  if (row.status === 'included') {
                                    return `#${row.lineNo} ${row.raw}  =>  (${row.note})`;
                                  }
                                  if (row.status === 'failed') {
                                    return `#${row.lineNo} ${row.raw}  =>  ❌ FAILED`;
                                  }
                                  return `#${row.lineNo} ${row.raw}  =>  (Skipped)`;
                                }),
                                `----------------`,
                                `Calculated Total: ₹${msgTotal}`,
                              ];
                              if (declaredTotal !== null) {
                                linesOut.push(`Customer Total: ₹${declaredTotal}`);
                                const diff = msgTotal - declaredTotal;
                                linesOut.push(
                                  diff === 0
                                    ? `Status: Matched ✓`
                                    : `Difference: ${diff > 0 ? '+' : ''}₹${diff}`
                                );
                              }
                              try {
                                await navigator.clipboard.writeText(linesOut.join('\n'));
                                showToast('Parchi Breakdown Copied ✓');
                              } catch {
                                showToast('Copy failed');
                              }
                            }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px',
                              padding: '5px 10px',
                              borderRadius: '8px',
                              border: `1px solid ${t.accent}`,
                              background: t.accentSoft,
                              color: t.accentText,
                              fontSize: '11px',
                              fontWeight: 800,
                              cursor: 'pointer',
                            }}
                          >
                            <Copy size={12} /> Copy Breakdown
                          </button>
                        </div>

                        <div
                          className="grid-scroll"
                          style={{
                            overflowY: 'auto',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '5px',
                            maxHeight: '220px',
                            paddingRight: '2px',
                          }}
                        >
                          {(pendingConfirm.lineBreakdown || []).map((row) => {
                            const isParsed = row.status === 'parsed';
                            const isFailed = row.status === 'failed';
                            const isIncluded = row.status === 'included';
                            return (
                              <div
                                key={`lb-${row.lineNo}`}
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  gap: '8px',
                                  background: isFailed
                                    ? 'rgba(225, 29, 72, 0.14)'
                                    : isParsed
                                    ? t.inputBg
                                    : 'rgba(148, 163, 184, 0.08)',
                                  border: `1px solid ${
                                    isFailed
                                      ? 'rgba(244, 63, 94, 0.5)'
                                      : isParsed
                                      ? t.cardBorder
                                      : 'rgba(148, 163, 184, 0.2)'
                                  }`,
                                  borderRadius: '8px',
                                  padding: '6px 9px',
                                }}
                              >
                                <div style={{ minWidth: 0, flex: 1 }}>
                                  <div
                                    style={{
                                      fontSize: '11px',
                                      fontFamily: 'monospace',
                                      fontWeight: 700,
                                      color: isFailed ? '#fda4af' : t.textPrimary,
                                      wordBreak: 'break-word',
                                    }}
                                  >
                                    <span style={{ color: t.textMuted, marginRight: '5px' }}>
                                      #{row.lineNo}
                                    </span>
                                    {row.raw}
                                  </div>
                                </div>
                                <div style={{ textAlign: 'right', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                  {isParsed && (
                                    <span
                                      style={{
                                        fontSize: '11px',
                                        fontWeight: 800,
                                        color: '#fbbf24',
                                      }}
                                    >
                                      {row.count}J • ₹{row.total.toLocaleString('en-IN')}
                                    </span>
                                  )}
                                  {isIncluded && (
                                    <span style={{ fontSize: '10px', fontWeight: 700, color: '#38bdf8' }}>
                                      {row.note}
                                    </span>
                                  )}
                                  {isFailed && (
                                    <span style={{ fontSize: '10px', fontWeight: 800, color: '#fb7185' }}>
                                      ❌ Failed
                                    </span>
                                  )}
                                  {!isParsed && !isIncluded && !isFailed && (
                                    <span style={{ fontSize: '10px', color: t.textMuted }}>
                                      Skipped
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {declaredTotal !== null && !totalMatches && (
                          <div
                            style={{
                              fontSize: '11px',
                              fontWeight: 800,
                              color: '#fb7185',
                              background: 'rgba(225, 29, 72, 0.12)',
                              border: '1px solid rgba(244, 63, 94, 0.4)',
                              borderRadius: '8px',
                              padding: '6px 9px',
                              display: 'flex',
                              justifyContent: 'space-between',
                            }}
                          >
                            <span>Diff (Our Total − Customer):</span>
                            <span>
                              {msgTotal - declaredTotal > 0 ? '+' : ''}₹
                              {(msgTotal - declaredTotal).toLocaleString('en-IN')}
                            </span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div
                        className="grid-scroll"
                        style={{
                          overflowY: 'auto',
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '6px',
                          maxHeight: '200px',
                          padding: '4px 0',
                        }}
                      >
                        {(pendingConfirm.normalResults || pendingConfirm.results).map((item, idx) => (
                          <span
                            key={`${item.number}-${idx}`}
                            style={{
                              background: t.inputBg,
                              border: `1px solid ${t.cardBorder}`,
                              borderRadius: '8px',
                              padding: '5px 9px',
                              fontSize: '12px',
                              fontWeight: 700,
                              color: t.textPrimary,
                            }}
                          >
                            {String(item.number).padStart(2, '0')} ={' '}
                            <span style={{ color: t.accentText }}>₹{item.amount}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* Multi-Game Target Selector (send same parchi to GB + GL + DS in 1 tap) */}
                {(() => {
                  const targets =
                    Array.isArray(pendingConfirm.targetCategories) &&
                    pendingConfirm.targetCategories.length > 0
                      ? pendingConfirm.targetCategories
                      : [activeCategory];
                  return (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '6px',
                        flexWrap: 'wrap',
                        background: t.inputBg,
                        border: `1px solid ${t.cardBorder}`,
                        borderRadius: '10px',
                        padding: '6px 8px',
                      }}
                    >
                      <span style={{ fontSize: '10px', fontWeight: 800, color: t.textSecondary }}>
                        Send to:
                      </span>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {CATEGORIES.map((cat) => {
                          const isSel = targets.includes(cat);
                          return (
                            <button
                              key={`confirm-cat-${cat}`}
                              type="button"
                              onClick={() => {
                                setPendingConfirm((prev) => {
                                  if (!prev) return null;
                                  const cur =
                                    Array.isArray(prev.targetCategories) &&
                                    prev.targetCategories.length > 0
                                      ? prev.targetCategories
                                      : [activeCategory];
                                  let next;
                                  if (cur.includes(cat)) {
                                    next = cur.length > 1 ? cur.filter((c) => c !== cat) : cur;
                                  } else {
                                    next = [...cur, cat];
                                  }
                                  return { ...prev, targetCategories: next };
                                });
                              }}
                              style={{
                                padding: '3px 8px',
                                borderRadius: '999px',
                                fontSize: '10px',
                                fontWeight: 800,
                                cursor: 'pointer',
                                background: isSel ? t.accent : t.cardBg,
                                color: isSel ? '#ffffff' : t.textSecondary,
                                border: `1px solid ${isSel ? t.accent : t.cardBorder}`,
                              }}
                            >
                              {cat}
                              {isSel ? ' ✓' : ''}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button
                    type="button"
                    onClick={() => {
                      if (pendingConfirm.step === 2) {
                        setPendingConfirm((prev) => (prev ? { ...prev, step: 1 } : null));
                      } else {
                        handleCancelPendingAdd();
                      }
                    }}
                    style={{
                      flex: 1,
                      background: t.inputBg,
                      border: `1px solid ${t.cardBorder}`,
                      color: t.textPrimary,
                      borderRadius: '10px',
                      padding: '12px 8px',
                      fontSize: '12px',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    {pendingConfirm.step === 2 ? '← Back' : 'Cancel'}
                  </button>
                  <button
                    type="button"
                    onClick={handleMarkWrongAndSaveFailed}
                    style={{
                      flex: 1.3,
                      background: 'rgba(234, 88, 12, 0.18)',
                      border: '1px solid #f97316',
                      color: '#fdba74',
                      borderRadius: '10px',
                      padding: '12px 8px',
                      fontSize: '12px',
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    ⚠️ Wrong
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmPendingAdd}
                    style={{
                      flex: 1.7,
                      background: t.accent,
                      border: 'none',
                      color: '#ffffff',
                      borderRadius: '10px',
                      padding: '12px 8px',
                      fontSize: '12px',
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    {(() => {
                      const targets =
                        Array.isArray(pendingConfirm.targetCategories) &&
                        pendingConfirm.targetCategories.length > 0
                          ? pendingConfirm.targetCategories
                          : [activeCategory];
                      const grandTot = msgTotal * targets.length;
                      return targets.length > 1
                        ? `Confirm ${targets.join('+')} (₹${grandTot.toLocaleString('en-IN')})`
                        : `Confirm (₹${msgTotal.toLocaleString('en-IN')})`;
                    })()}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
