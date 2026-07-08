// ── timeline: generic timestamp → value lookup ────────────────────────────────
// The scheduling guts that used to live inside caption.js, pulled out so more
// than one media type can share them. A "cue" is { t: seconds, value: <any> };
// callers decide what `value` means — caption.js reads it as a word to draw,
// sequence pieces read it as an index into the global media pool (see pool.js).
//
// The model is *hold-until-displaced*, not duration-based: at any elapsed time
// the active value is simply the last cue whose t <= elapsed, so each cue holds
// until the next one supersedes it, and the final cue holds to the end of the
// loop. There are no end times by design.

// {"<seconds>": <raw>} → time-sorted [{ t, value }]. `mapValue` transforms each
// raw JSON value into the shape this timeline wants (String for caption words,
// int-parse for sequence indices). JSON key order isn't guaranteed, so the sort
// is required, not cosmetic.
export function parseTimeline(raw, mapValue = v => v) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.keys(raw)
    .map(k => ({ t: parseFloat(k), value: mapValue(raw[k]) }))
    .filter(c => Number.isFinite(c.t))
    .sort((a, b) => a.t - b.t);
}

// Loop period: half a second past the last cue, so the final value gets a beat
// to hold before wrapping. Infinity for <2 cues (nothing to loop between).
export function loopLength(cues) {
  if (cues.length < 2) return Infinity;
  return cues[cues.length - 1].t + 0.5;
}

// Value of the last cue with t <= elapsed (binary search), looping via
// loopLength. Returns null before the first cue. Note: a cue's value may
// legitimately be 0 (a valid pool index), so callers must null-check the
// return, never treat it as falsy.
export function timelineValueAt(cues, elapsed) {
  if (!cues.length) return null;
  const period = loopLength(cues);
  if (Number.isFinite(period) && period > 0) elapsed %= period;

  let lo = 0, hi = cues.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].t <= elapsed) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans < 0 ? null : cues[ans].value;
}