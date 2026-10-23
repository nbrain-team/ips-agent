/**
 * groundingGate — finds exact dollar figures in a draft answer that no tool
 * result, user message or earlier turn supports.
 *
 * Oct 23, 2026: asked for "the same thing for 2025", the agent ran no query and
 * wrote $1,489,057.26 / $512,739.11 / $27,090.14 (the real figures were
 * $1,354,715.15 / $1,454,250.21 / $76,244.19), then "reconciled" a gap with a
 * $50,663.56 plug that was never queried. outputValidators flagged both
 * answers and they were sent anyway.
 *
 * Only cents-precise amounts ("$1,454,250.21") are checked. Rounded or
 * shorthand figures ("~$20K", "$1.45M") are left alone: those are how people
 * summarise, while an exact amount to the cent is a claim that a query
 * returned it.
 *
 * A figure is supported when it appears in the evidence, or is a sum or
 * difference of figures that do (a total of two accounts, a year-over-year
 * change), or of a pairwise sum and another figure (the change between two
 * totals). A turn that ran no tools gets no derivation at all: with nothing
 * queried, a new exact amount can only have been made up, and the plug in the
 * Per Diem answer was exactly a difference of two figures already on screen.
 */

const CLAIM = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?!\d|\s?(?:[kmb]|mm|thousand|million|billion)\b)/gi;
const NUMBER = /-?\d[\d,]*(?:\.\d+)?/g;
const MAX_PAIR_BASE = 400;

const toCents = (s) => {
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) : null;
};

/** Cents-precise dollar amounts stated in the text, in order of first appearance. */
function claimedAmounts(text) {
  const out = new Map();
  for (const m of String(text || '').matchAll(CLAIM)) {
    const cents = toCents(`${m[1]}.${m[2]}`);
    if (cents && cents >= 100 && !out.has(cents)) out.set(cents, m[0].replace(/\s/g, ''));
  }
  return out;
}

function evidenceNumbers(texts) {
  const all = new Set();
  const money = new Set();
  for (const t of texts) {
    for (const m of String(t || '').matchAll(NUMBER)) {
      const cents = toCents(m[0]);
      if (cents === null) continue;
      all.add(cents);
      if (m[0].includes('.') && cents >= 100) money.add(cents);
    }
  }
  return { all, money };
}

/**
 * @param {string}   answer
 * @param {object}   opts
 * @param {string[]} opts.evidence   tool results this turn, the user's message, attachments
 * @param {string[]} opts.history    earlier turns (their text and stored query results)
 * @param {boolean}  opts.derive     allow sums and differences (false when the turn ran no tools)
 * @returns {string[]} the unsupported figures as written, e.g. ["$512,739.11"]
 */
function ungroundedAmounts(answer, { evidence = [], history = [], derive = true } = {}) {
  const claims = claimedAmounts(answer);
  if (!claims.size) return [];
  const { all, money } = evidenceNumbers([...evidence, ...history]);

  let pairs = null;
  if (derive) {
    const base = [...money].slice(0, MAX_PAIR_BASE);
    pairs = new Set();
    for (let i = 0; i < base.length; i++) {
      for (let j = i; j < base.length; j++) {
        pairs.add(base[i] + base[j]);
        pairs.add(Math.abs(base[i] - base[j]));
      }
    }
  }

  // Derivations only combine money figures (numbers written with decimals):
  // counts, years and row numbers would make almost any amount "derivable".
  const moneyList = [...money];
  const supported = (c) => {
    if (all.has(c)) return true;
    if (!derive) return false;
    if (pairs.has(c)) return true;
    return moneyList.some((m) => pairs.has(Math.abs(c - m)) || pairs.has(c + m));
  };

  return [...claims].filter(([c]) => !supported(c)).map(([, written]) => written);
}

/** The block the orchestrator attaches to history; a draft that writes one itself is imitating query output. */
const FAKE_DATA_BLOCK = /\n*\[STRUCTURED DATA BEHIND THIS ANSWER[\s\S]*$/;

module.exports = { ungroundedAmounts, claimedAmounts, FAKE_DATA_BLOCK };
