import React, { useState, useEffect, useMemo, useRef } from 'react';
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
function tryParseHarufLine(line) {
  const hasHarufWord =
    /\b(?:haruf|harf|harup|haroop|hrf|bahar|bahr|andar|ander)\b/i.test(line) ||
    /(?:हरूफ|हरफ|बाहर|अंदर|अन्दर)/.test(line);
  const hasABToken = /(?:^|[\s.,(/])(?:AB|BA)(?:$|[\s.,)/])/i.test(line);
  const hasAttachedSide = /(?:^|[\s.,])(?:[AB][\s.,]*\d|\d[\s.,]*[AB])(?:$|[\s.,(/])/i.test(line);
  // 3+ repeated identical digits (e.g. "222=100", "1111 into 400") without A/B defaults to Bahar Haruf
  const hasRepeatedHarufDigits = /\b(\d)\1{2,}\b/.test(line);
  if (!hasHarufWord && !hasABToken && !hasAttachedSide && !hasRepeatedHarufDigits) return null;

  const hasAB =
    /\b(?:ab|ba)\b/i.test(line) ||
    (/\b(?:andar|ander)\b/i.test(line) && /\b(?:bahar|bahr)\b/i.test(line)) ||
    (/(?:अंदर|अन्दर)/.test(line) && /बाहर/.test(line));
  let hasA =
    hasAB ||
    /\b(?:andar|ander)\b/i.test(line) ||
    /(?:अंदर|अन्दर)/.test(line) ||
    /(?:^|[\s.,])a[\s.,]*\d|\d[\s.,]*a(?:$|[\s.,(/])/i.test(line);
  let hasB =
    hasAB ||
    /\b(?:bahar|bahr)\b/i.test(line) ||
    /बाहर/.test(line) ||
    /(?:^|[\s.,])b[\s.,]*\d|\d[\s.,]*b(?:$|[\s.,(/])/i.test(line);
  // If neither Andar nor Bahar is specified, default is always Bahar (outer)
  if (!hasA && !hasB) {
    hasA = false;
    hasB = true;
  }

  // Extract total haruf amount and divide by 10 (e.g. 400 -> ₹40 per jodi, 100 -> ₹10)
  let amt = 0;
  let digitPart = line;
  const parenAmt = line.match(/\(\s*@?\s*(\d+(?:\.\d+)?)\s*(?:into|in|rs)?\s*\)/i);
  const intoAmt = line.match(/(?:into|intu|ento|in|rs|r|@|=|×|x)\s*[.=*:\s]*(\d+(?:\.\d+)?)/i);
  const slashAmt = line.match(/\/\s*(\d+(?:\.\d+)?)/);

  if (parenAmt) {
    amt = parseFloat(parenAmt[1]);
    digitPart = line.slice(0, parenAmt.index);
  } else if (intoAmt) {
    amt = parseFloat(intoAmt[1]);
    digitPart = line.slice(0, intoAmt.index);
  } else if (slashAmt) {
    amt = parseFloat(slashAmt[1]);
    digitPart = line.slice(0, slashAmt.index);
  } else {
    const trailingAmt = line.match(/(\d+(?:\.\d+)?)\s*$/);
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
  const isJodaCut = /\b(?:jc|j\.c|joda\s*cut|jode\s*cat|jodi\s*cut)\b/i.test(line);
  const isFullCrossing = /\b(?:cwj|cwz|crocing|crossing)\b/i.test(line);
  if (!isJodaCut && !isFullCrossing) return null;

  let amt = 0;
  let digitPart = line;

  const parenAmt = line.match(/\(\s*@?\s*(\d+(?:\.\d+)?)\s*(?:into|in|rs)?\s*\)/i);
  const eqOrIntoAmt = line.match(
    /(?:=|into|intu|ento|in|rs|r|@|×|x)\s*[.=*:\s]*(\d+(?:\.\d+)?)/i
  );
  const afterKwAmt = line.match(
    /\b(?:jc|j\.c|joda\s*cut|jode\s*cat|jodi\s*cut|cwj|cwz|crocing|crossing)\b\s*[.=*:\s]*(\d+(?:\.\d+)?)/i
  );

  if (parenAmt) {
    amt = parseFloat(parenAmt[1]);
    digitPart = line.slice(0, parenAmt.index);
  } else if (eqOrIntoAmt) {
    amt = parseFloat(eqOrIntoAmt[1]);
    digitPart = line.slice(0, eqOrIntoAmt.index);
  } else if (afterKwAmt) {
    amt = parseFloat(afterKwAmt[1]);
    digitPart = line.slice(0, afterKwAmt.index);
  } else {
    const trailingAmt = line.match(/(\d+(?:\.\d+)?)\s*$/);
    if (trailingAmt) {
      amt = parseFloat(trailingAmt[1]);
      digitPart = line.slice(0, trailingAmt.index);
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
  const failed = [];
  if (!raw || !raw.trim()) return { results, failed };

  const lines = raw.split(/\r?\n|;/);
  let pendingNumbers = [];
  let pendingRawLines = [];

  const pushEntries = (nums, straightAmt, palatAmt) => {
    for (const n of nums) {
      results.push({ number: n, amount: straightAmt });
      if (palatAmt > 0) {
        const rev = getPalatNumber(n);
        if (rev !== null) {
          results.push({ number: rev, amount: palatAmt });
        }
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i].trim();
    let line = originalLine;
    if (!line) continue;

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

    // Skip WhatsApp system lines, media, deleted messages, phone numbers
    if (
      /^\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}/.test(line) ||
      /<Media omitted>/i.test(line) ||
      /This message was deleted/i.test(line) ||
      /paytm|phonepe|gpay|qr code|scanner/i.test(line) ||
      /\b\d{10}\b/.test(line)
    ) {
      continue;
    }

    // Skip Total / Balance / Grand Total lines
    if (
      /^(?:total|tot|ttl|tt|t|gt|all\s*total|hisab|balance|blnce|grand\s*total|टोटल|कुल)\b/i.test(
        line
      ) ||
      /^\*?\(?\d+\s*₹?\]?\)*\s*[+\-*/=]*$/.test(line) ||
      /\d+\s*[-+]\s*\d+\s*=/.test(line) ||
      /\b\d+\s*\+\+/.test(line)
    ) {
      pendingNumbers = [];
      pendingRawLines = [];
      continue;
    }

    // Strip trailing total clauses like "टोटल 100", "Total = 200", or "To. 570"
    line = line
      .replace(
        /(?:टोटल|कुल|grand\s*total|total|tot|ttl|sum|\bto\.)\s*[-:=*>₹.\s]*\d+(?:\.\d+)?(?:\s*(?:₹|rs\.?|inr|\/-|रुपये|रुपए))?/gi,
        ' '
      )
      .trim();
    if (!line) continue;

    // Check for Joda Cut (JC) or Full Crossing (crossing / cwj / cwz)
    const crossingEntries = tryParseCrossingLine(line);
    if (crossingEntries !== null) {
      pendingNumbers = [];
      pendingRawLines = [];
      if (crossingEntries.length > 0) {
        results.push(...crossingEntries);
      } else {
        failed.push({ rawLine: originalLine, reason: 'क्रॉसिंग/JC में अंक या अमाउंट नहीं मिला' });
      }
      continue;
    }

    // Check for Haruf line (A=Andar, B=Bahar, AB=Both, amount/10 per jodi)
    const harufEntries = tryParseHarufLine(line);
    if (harufEntries !== null) {
      pendingNumbers = [];
      pendingRawLines = [];
      if (harufEntries.length > 0) {
        results.push(...harufEntries);
      } else {
        failed.push({ rawLine: originalLine, reason: 'हरूफ में अंक या अमाउंट नहीं मिला' });
      }
      continue;
    }

    // Detect Palat modifiers on this line before cleaning
    let separatePalatAmt = null;
    let hasSamePalat = false;

    const sepPalatMatch = line.match(
      /(?:\b(?:with\s+)?(?:palat|palti|palt|plt)\b)\s*[.=*:\s]*(\d+(?:\.\d+)?)/i
    );
    const hasPalatKeyword =
      /\b(?:with\s+palat|palt\s*k\s*sath|palat\s*ke\s*sath|palat|palti|palt|plt|wp)\b/i.test(line);

    if (hasPalatKeyword) {
      if (sepPalatMatch) {
        const beforePalat = line.slice(0, sepPalatMatch.index);
        if (/(?:into|intu|ento|in|rs|r|@|=|\(|\*|\/)\s*\d+/i.test(beforePalat)) {
          separatePalatAmt = parseFloat(sepPalatMatch[1]);
          line = beforePalat.trim();
        } else {
          hasSamePalat = true;
          line = line.replace(/\b(?:with\s+)?(?:palat|palti|palt|plt)\b/gi, 'into').trim();
        }
      } else {
        hasSamePalat = true;
        line = line
          .replace(/\b(?:with\s+palat|palt\s*k\s*sath|palat\s*ke\s*sath|palat|palti|palt|plt|wp)\b/gi, ' ')
          .trim();
      }
    }

    // 2. Clean common noise words & currency symbols
    let cleaned = line
      .replace(/[₹]/g, ' ')
      .replace(/(\d)\s*(?:into|intu|ento|intoo|rs\.?|rupe)\s*$/i, '$1')
      .replace(/\b(?:rs\.?|inr|rupe|rupy|ru|ki|ka|me|mai|mein|se|tak|ok|okk|ookk|clear)\b/gi, ' ')
      .replace(/\/-/g, ' ')
      .replace(/\]/g, ')')
      .replace(/\)+/g, ')')
      .replace(/\(+/g, '(')
      .trim();

    if (!cleaned) continue;

    // 3. Inline "(amount)" groups
    const parenGroups = [...cleaned.matchAll(/([\d\s.,/_+\-\\*]+?)\(\s*@?\s*(\d+(?:\.\d+)?)\s*(?:into|intu|ento|in|rs)?\s*\)/gi)];
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

    // 4. "nums ... into/intu/ento/in/R/@/× amount"
    const intoMatch = cleaned.match(
      /^(.*?)(?:into|intu|ento|intoo|int|in|rs|r|@|×|x)\s*[.=*:\s]*(\d+(?:\.\d+)?)\s*$/i
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

    // Lookahead: if line is a multi-number list (e.g. "60*48*75*21*13") followed later by an "into X" line, buffer it instead of treating the last number as amount
    let deferToBuffer = false;
    if (!/(?:=|\*\*|#|@|×)/.test(cleaned) && /^[\d\s.,/_+\-\\*]+$/.test(cleaned)) {
      const candidateNums = extractJodiList(cleaned);
      if (candidateNums.length >= 2) {
        for (let k = i + 1; k < lines.length; k++) {
          const nxt = lines[k].trim();
          if (!nxt) continue;
          if (/^(?:total|tot|ttl|tt|t|gt|टोटल|कुल)\b/i.test(nxt)) break;
          if (/(?:into|intu|ento|intoo|in|rs|r)\s*[.=*:\s]*\d+|\(\s*@?\s*\d+\s*(?:into|in|rs)?\s*\)\s*$/i.test(nxt)) {
            deferToBuffer = true;
            break;
          }
          if (!/^[\d\s.,/_+\-\\*]+$/.test(nxt)) break;
        }
      }
    }

    // 5. Separator match
    const sepMatch = !deferToBuffer && cleaned.match(
      /^([\d\s.,/_+\-\\*=*#]+?)\s*(?:=|==|\*\*|\*|\/\/|\/|#|:|---|--|-|\.+|@|×|x)\s*(\d+(?:\.\d+)?)$/i
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
    const singleSpaceMatch = !nextIsAmountOnly && cleaned.match(/^(\d{1,3})\s+(\d+(?:\.\d+)?)$/);
    if (singleSpaceMatch) {
      const num = normalizeJodiNumber(singleSpaceMatch[1]);
      const amt = parseFloat(singleSpaceMatch[2]);
      if (num !== null && amt > 0) {
        pendingNumbers = [];
        pendingRawLines = [];
        pushEntries([num], amt, separatePalatAmt ?? (hasSamePalat ? amt : 0));
        continue;
      }
    }

    // 7. Buffer pure number lines for next line's "into X"
    const strippedWords = cleaned.replace(/[\p{L}\p{M}]+/gu, ' ').trim();
    if (strippedWords && /^[\d\s.,/_+\-\\*]+$/.test(strippedWords)) {
      const buffered = extractJodiList(strippedWords);
      if (buffered.length > 0) {
        pendingNumbers.push(...buffered);
        pendingRawLines.push(originalLine);
        continue;
      }
    }

    // Line had digits but matched no known pattern -> record as failed pattern
    if (/\d/.test(line)) {
      failed.push({ rawLine: originalLine, reason: 'पैटर्न पार्स नहीं हो सका' });
    }
  }

  // If buffered number lines had no following amount line, record them as failed
  if (pendingNumbers.length > 0 && pendingRawLines.length > 0) {
    failed.push({
      rawLine: pendingRawLines.join(' | '),
      reason: 'नंबर के बाद अमाउंट (into/=/Rs) नहीं मिला',
    });
  }

  return { results, failed };
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
    frameBg: '#0f172a',
    frameBorder: '#283548',
    headerBg: '#162033',
    cardBg: '#1a253a',
    cardBorder: '#2c3c56',
    inputBg: '#162033',
    textPrimary: '#f1f5f9',
    textSecondary: '#94a3b8',
    textMuted: '#64748b',
    accent: '#10b981',
    accentSoft: 'rgba(16, 185, 129, 0.16)',
    accentText: '#6ee7b7',
    tabActiveBg: '#0284c7',
    tabActiveBorder: '#38bdf8',
    lockBadgeBg: 'rgba(245, 158, 11, 0.16)',
    lockBadgeBorder: '#f59e0b',
    lockBadgeText: '#fcd34d',
  },
  light: {
    frameBg: '#f8fafc',
    frameBorder: '#cbd5e1',
    headerBg: '#ffffff',
    cardBg: '#ffffff',
    cardBorder: '#e2e8f0',
    inputBg: '#f1f5f9',
    textPrimary: '#0f172a',
    textSecondary: '#475569',
    textMuted: '#94a3b8',
    accent: '#059669',
    accentSoft: 'rgba(5, 150, 105, 0.12)',
    accentText: '#047857',
    tabActiveBg: '#0284c7',
    tabActiveBorder: '#0369a1',
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

  const [inputText, setInputText] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.DRAFT) || '';
  });

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
  const [motiMinAmount, setMotiMinAmount] = useState(0); // 0 = all, 300 = 30K (1%), 1000 = 1L (1%)
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
      localStorage.setItem('sunny_tracker_deleted_ids_v1', JSON.stringify([...deletedIdsRef.current].slice(-300)));
      localStorage.setItem('sunny_tracker_cat_clear_at_v1', JSON.stringify(categoryClearAtRef.current));
    } catch {
      // ignore
    }
  };

  const mergeRemoteSyncPayload = (payload) => {
    if (!payload) return false;
    if (payload.senderId) {
      peersRef.current.set(payload.senderId, Date.now());
      const now = Date.now();
      let active = 1; // include self
      for (const [pid, ts] of peersRef.current.entries()) {
        if (pid !== deviceId && now - ts < 50000) active++;
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
    const prevCount = byId.size;
    if (Array.isArray(payload.entries)) {
      for (const item of payload.entries) {
        if (item && item.id && !byId.has(item.id)) {
          byId.set(item.id, item);
        }
      }
    }

    const filtered = [...byId.values()].filter((item) => {
      if (deletedIdsRef.current.has(item.id)) return false;
      const clearTs = Number(categoryClearAtRef.current[item.category] || 0);
      if (clearTs > 0 && Number(item.createdAt || 0) <= clearTs) return false;
      return true;
    });

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

  const pushSyncSnapshot = async (customEntries) => {
    if (!syncEnabled || !cleanSyncTopic) return;
    try {
      const body = JSON.stringify({
        type: 'SUNNY_SYNC_V1',
        senderId: deviceId,
        sentAt: Date.now(),
        entries: customEntries || entriesRef.current,
        deletedIds: [...deletedIdsRef.current].slice(-200),
        categoryClearAt: categoryClearAtRef.current,
      });
      await fetch(`https://ntfy.sh/${cleanSyncTopic}`, {
        method: 'POST',
        body,
      });
      setLastSyncTime(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
    } catch {
      // ignore offline push errors
    }
  };

  const pullSyncHistory = async (showNotice = false) => {
    if (!cleanSyncTopic) return;
    try {
      const res = await fetch(`https://ntfy.sh/${cleanSyncTopic}/json?poll=1&since=24h`);
      const text = await res.text();
      let updated = false;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt && evt.message) {
            const payload = JSON.parse(evt.message);
            if (mergeRemoteSyncPayload(payload)) updated = true;
          }
        } catch {
          // ignore non-sync lines
        }
      }
      if (showNotice) {
        showToast(updated ? '🔄 दूसरे फोन का नया डेटा सिंक हो गया ✓' : '✓ सभी फोन पहले से अप-टू-डेट हैं');
      }
      if (syncEnabled) setSyncStatus('live');
    } catch {
      if (showNotice) showToast('इंटरनेट कनेक्शन जाँचें');
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
    window.SunnyNativeBridge?.startBackgroundSync?.(cleanSyncTopic);

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

    const sendHeartbeat = async () => {
      try {
        const res = await fetch(`https://ntfy.sh/${cleanSyncTopic}`, {
          method: 'POST',
          body: JSON.stringify({ type: 'SUNNY_PING_V1', senderId: deviceId, sentAt: Date.now() }),
        });
        if (res.ok) setSyncStatus('live');
      } catch {
        // ignore
      }
    };
    sendHeartbeat();
    const hbInterval = setInterval(() => {
      sendHeartbeat();
      const now = Date.now();
      let active = 1;
      for (const [pid, ts] of peersRef.current.entries()) {
        if (pid !== deviceId && now - ts < 50000) active++;
      }
      setConnectedCount(active);
    }, 20000);

    const es = new EventSource(`https://ntfy.sh/${cleanSyncTopic}/sse`);
    es.onopen = () => setSyncStatus('live');
    es.onerror = () => setSyncStatus('error');
    es.onmessage = (event) => {
      try {
        const wrapper = JSON.parse(event.data);
        if (wrapper && wrapper.message) {
          const payload = JSON.parse(wrapper.message);
          if (mergeRemoteSyncPayload(payload)) {
            showToast('🟢 दूसरे फोन से नया डेटा सिंक हुआ');
          }
        }
      } catch {
        // ignore keepalive/non-json events
      }
    };
    return () => {
      clearInterval(hbInterval);
      es.close();
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

  // Highest to Lowest ranking ("सबसे मोटा" -> "उससे नीचे" -> "सबसे कम") in active category
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
        tierMap[amt] = 'lowest'; // सबसे कम
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

  const categoryEntries = useMemo(() => {
    return entries
      .filter((e) => e.category === activeCategory)
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [entries, activeCategory]);

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
      showToast(
        nextLock
          ? `🔒 ${cat} लॉक हो गया`
          : `🔓 ${cat} अनलॉक हो गया — अब दूसरी कैटेगरी चुन सकते हैं`
      );
      return;
    }

    if (isLocked) {
      showToast(`🔒 ${activeCategory} लॉक है! पहले ${activeCategory} पर टैप करके अनलॉक करें`);
      return;
    }

    // Unlocked: switch to new category and auto-lock it!
    setActiveCategory(cat);
    setIsLocked(true);
    setSelectedBox(null);
    showToast(`🔒 ${cat} सेलेक्ट और लॉक हो गया`);
  };

  // Shared helper to commit parsed entries into activeCategory
  const commitParsedEntries = (parsed, sourceLabel = '') => {
    if (parsed.length === 0) return false;
    const now = Date.now();
    const timeStr = new Date(now).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const newItems = parsed.map((item, idx) => ({
      id: `${now}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
      category: activeCategory,
      number: item.number,
      amount: item.amount,
      time: timeStr,
      createdAt: now + idx,
    }));

    const addedTotal = newItems.reduce((sum, item) => sum + item.amount, 0);
    setEntries((prev) => [...prev, ...newItems]);
    setInputText('');

    if (newItems.length === 1) {
      showToast(
        `${sourceLabel}${activeCategory}: नंबर ${newItems[0].number} में ₹${newItems[0].amount} जुड़ा`
      );
    } else {
      showToast(
        `${sourceLabel}${activeCategory} में ${newItems.length} नंबर जुड़े (₹${addedTotal})`
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
        ? [{ rawLine: fallbackRaw.trim(), reason: 'पैटर्न समझ नहीं आया (0 नंबर जुड़े)' }]
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
        showToast(remoteList.length > 0 ? `🔄 ${remoteList.length} फेल पैटर्न चारों फोन से सिंक हुए` : 'कोई नया फेल पैटर्न नहीं मिला');
      }
    } catch {
      if (showNotice) showToast('इंटरनेट कनेक्शन जाँचें');
    }
  };

  const handleCopyFailedPatterns = async () => {
    if (failedPatterns.length === 0) {
      showToast('कोई फेल पैटर्न नहीं है');
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
      showToast('फेल पैटर्न हिस्ट्री कॉपी हो गई — अब चैट में पेस्ट कर दें');
    } catch {
      showToast('कॉपी नहीं हो सका');
    }
  };

  const openConfirmForText = (rawText, sourceLabel = '', fromBridge = false) => {
    if (!rawText || !rawText.trim()) {
      showToast('पहले WhatsApp टेक्स्ट पेस्ट करें या लिखें');
      return;
    }
    const { results, failed } = analyzeWhatsAppText(rawText);
    setInputText('');
    if (results.length === 0) {
      const savedCount = recordFailedPatterns(failed, rawText);
      if (fromBridge) {
        setPendingConfirm({
          isError: true,
          results: [],
          failed,
          sourceLabel,
          rawText,
          fromBridge: true,
        });
        return;
      }
      if (savedCount > 0) {
        showToast('पैटर्न एक्सेप्ट नहीं हुआ — फेल हिस्ट्री में सेव हो गया (Tools देखें)');
      } else {
        showToast('सही फॉर्मेट लिखें: जैसे 23 100 या 23=50');
      }
      return;
    }
    setPendingConfirm({ isError: false, results, failed, sourceLabel, rawText, fromBridge });
  };

  // Listen for clipboard text from native Android auto-clipboard check (when Auto ON)
  useEffect(() => {
    const handleIncomingText = (text) => {
      if (!autoPasteEnabled) return 'LOCKED';
      if (typeof text === 'string' && text.trim()) {
        openConfirmForText(text, 'ऑटो ✓ ', true);
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
    const { results, failed, sourceLabel, fromBridge } = pendingConfirm;
    commitParsedEntries(results, sourceLabel);
    if (failed.length > 0) {
      const savedCount = recordFailedPatterns(failed, '');
      if (savedCount > 0) {
        showToast(`${sourceLabel}${results.length} नंबर जुड़े (${savedCount} लाइन फेल हिस्ट्री में सेव)`);
      }
    }
    setPendingConfirm(null);
    if (fromBridge && window.SunnyNativeBridge?.returnToPreviousApp) {
      setTimeout(() => window.SunnyNativeBridge.returnToPreviousApp(), 250);
    }
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
    showToast('⚠️ फेल पैटर्न हिस्ट्री में सेव हो गया');
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
      processInputSubmission('पेस्ट ✓ ');
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        showToast('क्लिपबोर्ड खाली है');
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
    showToast(`${activeCategory}: नंबर ${selectedBox} में ₹${amt} जुड़ा`);
  };

  const handleDeleteEntry = (id) => {
    deletedIdsRef.current.add(id);
    persistSyncMeta();
    setEntries((prev) => prev.filter((item) => item.id !== id));
    showToast('एंट्री हटाई गई');
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
    showToast(`Undo: नंबर ${removed.number} (₹${removed.amount})`);
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
      showToast('समरी कॉपी हो गई');
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
    ctx.fillText(`तारीख: ${nowStr}`, 44, 90);

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
    ctx.fillText(`नाम: ${(chartOwnerName || 'Sunny').trim()}`, 46, footY + 38);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '15px sans-serif';
    ctx.fillText(`कैटेगरी: ${activeCategory} • 01 से 100 चार्ट`, 46, footY + 66);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText(
      `कुल टोटल: ₹${categoryTotals[activeCategory].toLocaleString('en-IN')}`,
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
    showToast(`${activeCategory} चार्ट इमेज डाउनलोड हो गई`);
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
          text: `${activeCategory} कुल टोटल: ₹${categoryTotals[activeCategory].toLocaleString('en-IN')} — ${chartOwnerName}`,
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
          {/* Row 1: Title + Lock Badge + Theme & Grid Toggle */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '6px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
              <h1
                style={{
                  fontSize: '16px',
                  fontWeight: 800,
                  color: t.textPrimary,
                  whiteSpace: 'nowrap',
                }}
              >
                नंबर ट्रैकर
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
                {isLocked ? `${activeCategory} लॉक` : 'अनलॉक'}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
              <button
                onClick={() => setToolsView('cloud_sync')}
                title="4-फोन फ्री लाइव सिंक सेटिंग"
                style={{
                  background: syncEnabled
                    ? syncStatus === 'live'
                      ? '#059669'
                      : 'rgba(245, 158, 11, 0.2)'
                    : t.inputBg,
                  color: syncEnabled
                    ? syncStatus === 'live'
                      ? '#ffffff'
                      : '#fbbf24'
                    : t.textSecondary,
                  border: `1.5px solid ${
                    syncEnabled ? (syncStatus === 'live' ? '#34d399' : '#f59e0b') : t.cardBorder
                  }`,
                  borderRadius: '8px',
                  padding: '5px 8px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '10px',
                  fontWeight: 800,
                }}
              >
                <Wifi size={13} color={syncEnabled && syncStatus === 'live' ? '#ffffff' : undefined} />
                {syncEnabled ? (syncStatus === 'live' ? `Connected: ${connectedCount}` : 'Sync...') : 'Sync'}
              </button>
              <button
                onClick={() => setThemeMode((m) => (m === 'dark' ? 'light' : 'dark'))}
                title="थीम बदलें"
                style={{
                  background: t.inputBg,
                  color: t.textSecondary,
                  border: `1px solid ${t.cardBorder}`,
                  borderRadius: '8px',
                  padding: '5px 8px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                {themeMode === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              </button>
              <button
                onClick={() => setColumns((c) => (c === 5 ? 10 : 5))}
                title="ग्रिड लेआउट बदलें"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  background: t.inputBg,
                  color: t.textSecondary,
                  border: `1px solid ${t.cardBorder}`,
                  borderRadius: '8px',
                  padding: '5px 8px',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <LayoutGrid size={14} />
                {columns === 5 ? '5' : '10'}
              </button>
            </div>
          </div>

          {/* Row 2: Grand Total + History & Tools Buttons */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '9px',
            }}
          >
            <p style={{ fontSize: '11px', color: t.textSecondary, whiteSpace: 'nowrap' }}>
              ग्रैंड टोटल:{' '}
              <strong style={{ color: t.accent }}>
                ₹{grandTotal.toLocaleString('en-IN')}
              </strong>{' '}
              <span style={{ color: t.textMuted }}>
                / ₹{gameTarget.toLocaleString('en-IN')}
              </span>
            </p>

            <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
              <button
                onClick={() => {
                  const next = !autoPasteEnabled;
                  setAutoPasteEnabled(next);
                  showToast(
                    next
                      ? '🔓 ऑटो-कॉपी ON — कॉपी किया नंबर अपने-आप कन्फ़र्म दिखेगा'
                      : '🔒 ऑटो-कॉपी OFF — अब कॉपी डेटा अपने-आप नहीं आएगा'
                  );
                }}
                title="ऑटो-कॉपी चालू/बंद करें"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '3px',
                  background: autoPasteEnabled ? 'rgba(16, 185, 129, 0.16)' : 'rgba(225, 29, 72, 0.16)',
                  color: autoPasteEnabled ? '#6ee7b7' : '#fb7185',
                  border: `1px solid ${autoPasteEnabled ? '#10b981' : '#f43f5e'}`,
                  borderRadius: '8px',
                  padding: '5px 7px',
                  fontSize: '10px',
                  fontWeight: 800,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {autoPasteEnabled ? <Unlock size={11} /> : <Lock size={11} />}
                {autoPasteEnabled ? 'Auto ON' : 'Auto OFF'}
              </button>
              <button
                onClick={() => setToolsView('entry_history')}
                title="सभी एंट्री की हिस्ट्री देखें व गलत एंट्री हटाएं"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  background: t.inputBg,
                  color: t.textPrimary,
                  border: `1px solid ${t.cardBorder}`,
                  borderRadius: '8px',
                  padding: '5px 9px',
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <History size={13} />
                हिस्ट्री
              </button>
              <button
                onClick={() => setToolsView('menu')}
                title="कैटेगरी टूल्स खोलें"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  background: '#000000',
                  color: '#fbbf24',
                  border: '1px solid #f59e0b',
                  borderRadius: '8px',
                  padding: '5px 10px',
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                <Wrench size={13} />
                टूल्स
              </button>
            </div>
          </div>

          {/* Target Progress Bar (₹30,000 Game) */}
          <div
            style={{
              height: '4px',
              background: t.inputBg,
              borderRadius: '999px',
              overflow: 'hidden',
              marginBottom: '8px',
            }}
          >
            <div
              style={{
                width: `${Math.min(100, (categoryTotals[activeCategory] / gameTarget) * 100)}%`,
                height: '100%',
                background: 'linear-gradient(90deg, #10b981, #f59e0b)',
                transition: 'width 0.25s ease',
              }}
            />
          </div>

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
            placeholder="यहाँ पेस्ट करें..."
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
            title="WhatsApp से पेस्ट करके तुरंत जोड़ें"
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
            जोड़ें
          </button>
        </form>

        {/* Live Tier Summary Strip (सबसे मोटा -> उससे नीचे -> सबसे कम) */}
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
                  label: '👑 सबसे मोटा',
                  item: first,
                  bg: '#000000',
                  border: '#f59e0b',
                  color: '#fbbf24',
                },
                second && {
                  label: '2nd',
                  item: second,
                  bg: 'rgba(234, 88, 12, 0.18)',
                  border: '#f97316',
                  color: '#fb923c',
                },
                third && {
                  label: '3rd',
                  item: third,
                  bg: 'rgba(2, 132, 199, 0.18)',
                  border: '#38bdf8',
                  color: '#38bdf8',
                },
                lowest &&
                  lowest.amount !== first.amount && {
                    label: 'सबसे कम',
                    item: lowest,
                    bg: 'rgba(225, 29, 72, 0.16)',
                    border: '#f43f5e',
                    color: '#fb7185',
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
                    borderRadius: '8px',
                    padding: '4px 8px',
                    fontSize: '10px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  <span>{chip.label}:</span>
                  <span style={{ color: t.textPrimary === '#0f172a' && chip.bg !== '#000000' ? '#0f172a' : '#ffffff' }}>
                    {String(chip.item.number).padStart(2, '0')} (₹{chip.item.amount.toLocaleString('en-IN')})
                  </span>
                </button>
              ));
            })()}
          </div>
        )}

        {/* 1 to 100 Number Grid */}
        <main
          className="grid-scroll"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '10px',
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, 1fr)`,
            gap: columns === 5 ? '6px' : '4px',
            alignContent: 'start',
          }}
        >
          {Array.from({ length: 100 }, (_, i) => i + 1).map((num) => {
            const amt = boxTotals[num];
            const hasAmt = amt > 0;
            const tier = hasAmt ? tierByAmount[amt] : null;
            const isHighest = tier === 'top';

            let boxBg = t.cardBg;
            let boxBorder = `1px solid ${t.cardBorder}`;
            let numColor = t.textSecondary;
            let amtColor = t.textMuted;

            if (tier === 'top') {
              boxBg = '#000000';
              boxBorder = '2px solid #f59e0b';
              numColor = '#fbbf24';
              amtColor = '#ffffff';
            } else if (tier === 'second') {
              boxBg = 'rgba(234, 88, 12, 0.2)';
              boxBorder = '1.5px solid #f97316';
              numColor = '#fdba74';
              amtColor = t.textPrimary;
            } else if (tier === 'third') {
              boxBg = 'rgba(2, 132, 199, 0.2)';
              boxBorder = '1.5px solid #38bdf8';
              numColor = '#7dd3fc';
              amtColor = t.textPrimary;
            } else if (tier === 'lowest') {
              boxBg = 'rgba(225, 29, 72, 0.16)';
              boxBorder = '1.5px solid #f43f5e';
              numColor = '#fda4af';
              amtColor = t.textPrimary;
            } else if (hasAmt) {
              boxBg = t.accentSoft;
              boxBorder = `1.5px solid ${t.accent}`;
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
          })}
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
                {activeCategory} कुल टोटल
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
                सभी 6 कैटेगरी (Grand)
              </div>
              <div
                style={{
                  fontSize: '15px',
                  fontWeight: 800,
                  color: t.accent,
                  lineHeight: 1.2,
                }}
              >
                ₹{grandTotal.toLocaleString('en-IN')}
              </div>
            </div>
          </div>

          {/* Action Buttons: Undo, Copy, Clear {activeCategory} */}
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={handleUndoLast}
              title="आखिरी एंट्री हटाएं (Undo)"
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
              title="समरी कॉपी करें"
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
              title={`${activeCategory} का सारा डेटा क्लियर करें`}
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
                  {activeCategory} का डेटा क्लियर करें?
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
                  नहीं (रद्द करें)
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
                  हाँ, {activeCategory} क्लियर करें
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
                background: t.headerBg,
                borderTopLeftRadius: '20px',
                borderTopRightRadius: '20px',
                borderTop: `1px solid ${t.cardBorder}`,
                padding: '16px',
                maxHeight: '84%',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              {toolsView === 'menu' ? (
                <>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <h2 style={{ fontSize: '16px', fontWeight: 700, color: t.textPrimary }}>
                        🛠️ {activeCategory} — टूल्स
                      </h2>
                      <p style={{ fontSize: '11px', color: t.textSecondary }}>
                        अपने काम के लिए टूल चुनें
                      </p>
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

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <button
                      onClick={() => setToolsView('moti_jodi')}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: '#000000',
                        border: '1.5px solid #f59e0b',
                        borderRadius: '12px',
                        padding: '14px',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <Flame size={20} color="#fbbf24" />
                        <div>
                          <div style={{ fontSize: '14px', fontWeight: 800, color: '#fbbf24' }}>
                            मोटी जोड़ी (बड़े से छोटा)
                          </div>
                          <div style={{ fontSize: '11px', color: '#cbd5e1', marginTop: '2px' }}>
                            सबसे मोटी से सबसे कम जोड़ी देखें व कॉपी करें
                          </div>
                        </div>
                      </div>
                      <span
                        style={{
                          background: '#f59e0b',
                          color: '#000000',
                          fontWeight: 800,
                          fontSize: '11px',
                          padding: '3px 8px',
                          borderRadius: '999px',
                        }}
                      >
                        {rankedList.length}
                      </span>
                    </button>

                    <button
                      onClick={() => setToolsView('share_image')}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        background: t.inputBg,
                        border: `1.5px solid #0284c7`,
                        borderRadius: '12px',
                        padding: '12px 14px',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <ImageIcon size={18} color="#38bdf8" />
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: '#38bdf8' }}>
                          01–100 चार्ट इमेज बनाएं व शेयर करें
                        </div>
                        <div style={{ fontSize: '11px', color: t.textSecondary }}>
                          नीचे टोटल और नाम के साथ पूरी HD इमेज डाउनलोड/शेयर करें
                        </div>
                      </div>
                    </button>

                    <button
                      onClick={() => setToolsView('cloud_sync')}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: t.inputBg,
                        border: `1.5px solid ${syncEnabled ? '#10b981' : '#38bdf8'}`,
                        borderRadius: '12px',
                        padding: '12px 14px',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <Wifi size={18} color={syncEnabled ? '#10b981' : '#38bdf8'} />
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: syncEnabled ? '#6ee7b7' : '#38bdf8' }}>
                            4-फोन फ्री लाइव सिंक (₹0 खर्च)
                          </div>
                          <div style={{ fontSize: '11px', color: t.textSecondary }}>
                            एक फोन में जोड़ें और चारों फोनों में तुरंत देखें
                          </div>
                        </div>
                      </div>
                      <span
                        style={{
                          background: syncEnabled ? '#059669' : t.cardBg,
                          color: syncEnabled ? '#ffffff' : t.textSecondary,
                          fontWeight: 800,
                          fontSize: '10px',
                          padding: '3px 8px',
                          borderRadius: '999px',
                        }}
                      >
                        {syncEnabled ? 'ON' : 'OFF'}
                      </span>
                    </button>

                    <button
                      onClick={() => setToolsView('entry_history')}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: t.inputBg,
                        border: `1px solid ${t.cardBorder}`,
                        borderRadius: '12px',
                        padding: '12px 14px',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <History size={18} color={t.accent} />
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: t.textPrimary }}>
                            सभी एंट्री हिस्ट्री (गलत एंट्री हटाएं)
                          </div>
                          <div style={{ fontSize: '11px', color: t.textSecondary }}>
                            समय के साथ हर एंट्री देखें और गलत एंट्री डिलीट करें
                          </div>
                        </div>
                      </div>
                      <span
                        style={{
                          background: t.cardBg,
                          color: t.textPrimary,
                          fontWeight: 800,
                          fontSize: '11px',
                          padding: '3px 8px',
                          borderRadius: '999px',
                        }}
                      >
                        {categoryEntries.length}
                      </span>
                    </button>

                    <button
                      onClick={() => setToolsView('failed_patterns')}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: t.inputBg,
                        border: `1.5px solid ${failedPatterns.length > 0 ? '#f43f5e' : t.cardBorder}`,
                        borderRadius: '12px',
                        padding: '12px 14px',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <AlertTriangle size={18} color={failedPatterns.length > 0 ? '#fb7185' : t.textSecondary} />
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: failedPatterns.length > 0 ? '#fb7185' : t.textPrimary }}>
                            फेल पैटर्न हिस्ट्री (कॉपी करें)
                          </div>
                          <div style={{ fontSize: '11px', color: t.textSecondary }}>
                            जो पैटर्न ऐड न हो सकें, उन्हें कॉपी करके भेजें
                          </div>
                        </div>
                      </div>
                      <span
                        style={{
                          background: failedPatterns.length > 0 ? '#f43f5e' : t.cardBg,
                          color: failedPatterns.length > 0 ? '#ffffff' : t.textSecondary,
                          fontWeight: 800,
                          fontSize: '11px',
                          padding: '3px 8px',
                          borderRadius: '999px',
                        }}
                      >
                        {failedPatterns.length}
                      </span>
                    </button>

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
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        background: t.inputBg,
                        border: '1.5px solid #10b981',
                        borderRadius: '12px',
                        padding: '12px 14px',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <Sparkles size={18} color="#10b981" />
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: '#6ee7b7' }}>
                          📱 ऑटो-पेस्ट डेमो देखें (Live Demo)
                        </div>
                        <div style={{ fontSize: '11px', color: t.textSecondary }}>
                          देखें WhatsApp पर Copy करते ही कन्फ़र्मेशन लिस्ट कैसे खुलेगी
                        </div>
                      </div>
                    </button>

                    <button
                      onClick={() => {
                        handleLoad30kGame();
                        setToolsView('moti_jodi');
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        background: t.inputBg,
                        border: `1px solid ${t.cardBorder}`,
                        borderRadius: '12px',
                        padding: '12px 14px',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <Sparkles size={18} color={t.accent} />
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: t.textPrimary }}>
                          ₹30,000 डेमो गेम लोड करें
                        </div>
                        <div style={{ fontSize: '11px', color: t.textSecondary }}>
                          {activeCategory} में ₹30,000 का सैंपल डेटा टेस्ट करें
                        </div>
                      </div>
                    </button>
                  </div>
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
                        title="टूल्स पर वापस जाएं"
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
                          🔥 {activeCategory} — मोटी जोड़ी
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

                  {/* Moti Jodi Threshold Filter (1% of Total Work: 30K -> ₹300+, 1L -> ₹1,000+) */}
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
                      { label: 'सभी', val: 0 },
                      { label: '30K काम (₹300+)', val: 300 },
                      { label: '1L काम (₹1,000+)', val: 1000 },
                    ].map((preset) => {
                      const activePreset = motiMinAmount === preset.val;
                      return (
                        <button
                          key={preset.val}
                          type="button"
                          onClick={() => setMotiMinAmount(preset.val)}
                          style={{
                            background: activePreset ? '#f59e0b' : t.cardBg,
                            color: activePreset ? '#000000' : t.textPrimary,
                            border: `1px solid ${activePreset ? '#f59e0b' : t.cardBorder}`,
                            borderRadius: '7px',
                            padding: '4px 8px',
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
                        gap: '4px',
                        marginLeft: 'auto',
                      }}
                    >
                      <span style={{ fontSize: '10px', color: t.textMuted }}>₹ से ऊपर:</span>
                      <input
                        type="number"
                        min="0"
                        value={motiMinAmount || ''}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          setMotiMinAmount(Number.isFinite(v) && v > 0 ? v : 0);
                        }}
                        placeholder="0"
                        style={{
                          width: '64px',
                          background: t.cardBg,
                          border: `1px solid ${t.cardBorder}`,
                          borderRadius: '6px',
                          padding: '3px 6px',
                          color: t.textPrimary,
                          fontSize: '11px',
                          fontWeight: 700,
                          outline: 'none',
                        }}
                      />
                    </div>
                  </div>

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
                      filteredRankedList.map((item, idx) => {
                        const tier = tierByAmount[item.amount];
                        const catTotal = categoryTotals[activeCategory] || 1;
                        const pct = ((item.amount / catTotal) * 100).toFixed(1);
                        const isRowCopied = copiedKey === item.number;

                        let badgeLabel = `#${idx + 1}`;
                        let rowBg = t.inputBg;
                        let rowBorder = t.cardBorder;
                        let badgeColor = t.textSecondary;

                        if (tier === 'top') {
                          badgeLabel = '👑 सबसे मोटी';
                          rowBg = '#000000';
                          rowBorder = '#f59e0b';
                          badgeColor = '#fbbf24';
                        } else if (tier === 'second') {
                          badgeLabel = '2nd नीचे';
                          rowBg = 'rgba(234, 88, 12, 0.14)';
                          rowBorder = '#f97316';
                          badgeColor = '#fb923c';
                        } else if (tier === 'third') {
                          badgeLabel = '3rd नीचे';
                          rowBg = 'rgba(2, 132, 199, 0.14)';
                          rowBorder = '#38bdf8';
                          badgeColor = '#38bdf8';
                        } else if (tier === 'lowest') {
                          badgeLabel = 'सबसे कम';
                          rowBg = 'rgba(225, 29, 72, 0.14)';
                          rowBorder = '#f43f5e';
                          badgeColor = '#fb7185';
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
                                      color: tier === 'top' ? '#ffffff' : t.textPrimary,
                                    }}
                                  >
                                    जोड़ी {String(item.number).padStart(2, '0')}
                                  </div>
                                  <div style={{ fontSize: '10px', color: t.textMuted }}>
                                    {jodiEntries.length} बार जुड़ा • {pct}% हिस्सा {isExpanded ? '▴' : '▾'}
                                  </div>
                                </div>
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span
                                  style={{
                                    fontSize: '14px',
                                    fontWeight: 800,
                                    color: tier === 'top' ? '#fbbf24' : t.accentText,
                                  }}
                                >
                                  ₹{item.amount.toLocaleString('en-IN')}
                                </span>
                                <button
                                  onClick={() => handleCopySingleJodi(item.number, item.amount)}
                                  title="यह जोड़ी कॉपी करें"
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

                  {/* Bottom "All Text" Copy Button */}
                  {filteredRankedList.length > 0 && (
                    <button
                      onClick={handleCopyAllMotiJodi}
                      style={{
                        width: '100%',
                        background: copiedKey === 'ALL' ? '#059669' : '#0284c7',
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
                      {copiedKey === 'ALL' ? <Check size={16} /> : <Copy size={16} />}
                      {copiedKey === 'ALL'
                        ? 'सारी जोड़ी कॉपी हो गई ✓'
                        : `All Text कॉपी करें (${filteredRankedList.length} जोड़ी)`}
                    </button>
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
                        title="टूल्स पर वापस जाएं"
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
                          नीचे टोटल व नाम के साथ शेयर या डाउनलोड करें
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
                      इमेज पर नाम:
                    </label>
                    <input
                      type="text"
                      value={chartOwnerName}
                      onChange={(e) => setChartOwnerName(e.target.value)}
                      placeholder="अपना या पार्टी का नाम लिखें"
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
                      शेयर करें
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
                      डाउनलोड PNG
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
                        title="टूल्स पर वापस जाएं"
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
                      अपने सभी फोनों (4 या ज़्यादा) में एक ही <strong>गुप्त कोड (Sync Code)</strong> डालकर ON करें। किसी भी फोन पर नंबर जुड़ते ही चारों फोनों में तुरंत अपडेट हो जाएगा — बिल्कुल मुफ़्त!
                    </div>

                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <input
                        type="text"
                        value={syncRoomId}
                        onChange={(e) => setSyncRoomId(e.target.value)}
                        placeholder="गुप्त कोड डालें (जैसे sunny-9988)"
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
                        {syncEnabled ? 'सिंक बंद करें (OFF)' : '✅ लाइव सिंक चालू करें'}
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
                        title="टूल्स पर वापस जाएं"
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
                          ⚠️ फेल पैटर्न हिस्ट्री ({failedPatterns.length})
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
                        title="चारों फोनों के फेल पैटर्न एक जगह लाएं"
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
                            showToast('फेल पैटर्न हिस्ट्री साफ़ हो गई');
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
                        अभी कोई भी फेल पैटर्न नहीं है ✓
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
                        ? 'फेल हिस्ट्री कॉपी हो गई ✓'
                        : `सारी फेल हिस्ट्री कॉपी करें (${failedPatterns.length})`}
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
                        title="टूल्स पर वापस जाएं"
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
                          📜 {activeCategory} — एंट्री हिस्ट्री ({categoryEntries.length})
                        </h2>
                        <p style={{ fontSize: '11px', color: t.textSecondary }}>
                          गलत एंट्री हटाने पर मेन ग्रिड व टोटल से भी हट जाएगी
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
                    className="grid-scroll"
                    style={{
                      overflowY: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                      maxHeight: '360px',
                    }}
                  >
                    {categoryEntries.length === 0 ? (
                      <p
                        style={{
                          fontSize: '13px',
                          color: t.textMuted,
                          textAlign: 'center',
                          padding: '24px 0',
                        }}
                      >
                        अभी {activeCategory} में कोई एंट्री नहीं है।
                      </p>
                    ) : (
                      categoryEntries.map((ent, idx) => {
                        const timeLabel =
                          ent.time ||
                          new Date(ent.createdAt).toLocaleTimeString('en-IN', {
                            hour: '2-digit',
                            minute: '2-digit',
                          });
                        return (
                          <div
                            key={ent.id}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              background: t.inputBg,
                              border: `1px solid ${t.cardBorder}`,
                              borderRadius: '10px',
                              padding: '8px 10px',
                              gap: '8px',
                            }}
                          >
                            <div>
                              <div style={{ fontSize: '13px', fontWeight: 800, color: t.textPrimary }}>
                                जोड़ी {String(ent.number).padStart(2, '0')} —{' '}
                                <span style={{ color: t.accentText }}>₹{ent.amount}</span>
                              </div>
                              <div style={{ fontSize: '10px', color: t.textMuted }}>
                                #{categoryEntries.length - idx} • समय: {timeLabel}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                handleDeleteEntry(ent.id);
                                showToast(
                                  `${activeCategory}: जोड़ी ${String(ent.number).padStart(2, '0')} (₹${ent.amount}) हट गई`
                                );
                              }}
                              title="यह एंट्री हटाएं"
                              style={{
                                background: 'rgba(225, 29, 72, 0.14)',
                                border: '1px solid #f43f5e',
                                color: '#fb7185',
                                borderRadius: '8px',
                                padding: '6px 9px',
                                fontSize: '11px',
                                fontWeight: 700,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                              }}
                            >
                              <Trash2 size={13} />
                              हटाएं
                            </button>
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
                    {activeCategory} — नंबर {String(selectedBox).padStart(2, '0')}
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
                  placeholder="अमाउंट डालें (जैसे 50)"
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
                  + जोड़ें
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
                    अभी इस नंबर पर कोई एंट्री नहीं है।
                  </p>
                ) : (
                  selectedBoxEntries.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: t.inputBg,
                        padding: '8px 12px',
                        borderRadius: '10px',
                        border: `1px solid ${t.cardBorder}`,
                      }}
                    >
                      <div>
                        <span style={{ fontWeight: 700, color: t.textPrimary }}>
                          ₹{item.amount}
                        </span>
                        <span
                          style={{
                            fontSize: '11px',
                            color: t.textMuted,
                            marginLeft: '8px',
                          }}
                        >
                          {new Date(item.createdAt).toLocaleTimeString('hi-IN', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                      <button
                        onClick={() => handleDeleteEntry(item.id)}
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
                  ))
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
                    यह पर्ची फेल पैटर्न हिस्ट्री में सेव हो गई है।{' '}
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
                    ठीक है (वापस चैट पर जाएं)
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
                    ✅ {activeCategory} में जोड़ने की पुष्टि करें
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
                      इस मैसेज का टोटल ({pendingConfirm.results.length} नंबर):
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
                      <span>कस्टमर का लिखा टोटल: ₹{declaredTotal.toLocaleString('en-IN')}</span>
                      <span>{totalMatches ? '✓ टोटल बराबर है' : '⚠️ टोटल अलग है'}</span>
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
                    <span>{activeCategory} गेम टोटल (जुड़ने के बाद):</span>
                    <strong style={{ color: '#38bdf8' }}>
                      ₹{currentCatTotal.toLocaleString('en-IN')} → ₹{nextCatTotal.toLocaleString('en-IN')}
                    </strong>
                  </div>
                </div>

                {pendingConfirm.failed.length > 0 && (
                  <div
                    style={{
                      fontSize: '11px',
                      color: '#fb7185',
                      background: 'rgba(225, 29, 72, 0.12)',
                      border: '1px solid rgba(244, 63, 94, 0.4)',
                      borderRadius: '8px',
                      padding: '6px 9px',
                    }}
                  >
                    ⚠️ {pendingConfirm.failed.length} लाइन समझ नहीं आई (फेल हिस्ट्री में सेव होगी)
                  </div>
                )}

                <div
                  className="grid-scroll"
                  style={{
                    overflowY: 'auto',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '6px',
                    maxHeight: '220px',
                    padding: '4px 0',
                  }}
                >
                  {pendingConfirm.results.map((item, idx) => (
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

                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button
                    type="button"
                    onClick={handleCancelPendingAdd}
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
                    रद्द करें
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
                    ⚠️ गलत जुड़ा
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
                    कन्फ़र्म (₹{msgTotal.toLocaleString('en-IN')})
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
