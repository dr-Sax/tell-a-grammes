// ── ui-media: per-piece media row + framing sliders ───────────────────────────
// The media-attachment controls (thumbnail, upload/URL/link buttons) and the
// zoom/rotate/x/y framing sliders for a single piece. Split out of ui.js since
// this is really "the media panel," not "the piece list" — buildUI() in ui.js
// just calls buildMediaRow(i) per piece and appends the result.

import { PIECES, MEDIA_SLIDERS } from './config.js';
import { state } from './state.js';
import { overlayPanel, statusEl } from './dom.js';
import { pieceMedia, disposeMedia, loadMediaFile, loadMediaFromURL } from './media.js';
import { captionThumbURL } from './caption.js';
// Circular with ui.js (which imports buildMediaRow from here) — safe because
// buildUI is only ever called from inside event handlers below, never at
// module-evaluation time, so it's always resolved by the time it's needed.
import { buildUI } from './ui.js';

// Shared by every attach path (file picker, URL prompt) that changes a
// piece's media: re-render the piece list and collapse the panel so there's
// an unobstructed view of the newly-attached media. Only called on a
// SUCCESSFUL attach — failure paths just set statusEl text instead, so the
// panel doesn't collapse on an error.
function closePanelAndRefresh() {
  buildUI();
  overlayPanel.classList.remove('open');
}

// Per-piece framing sliders (zoom / x-shift / y-shift). Mutates the piece's
// state.mediaAdjust object IN PLACE on input — the rAF loop reads it next frame,
// so changes are immediate. Never calls buildUI (that would interrupt the drag).
function buildAdjustRow(i) {
  const row = document.createElement('div');
  row.className = 'piece-adjust';
  const adj = state.mediaAdjust[i];

  for (const s of MEDIA_SLIDERS) {
    const group = document.createElement('label');
    group.className = 'adjust-group';

    const tag = document.createElement('span');
    tag.className = 'adjust-tag';
    tag.textContent = s.label;
    tag.title = 'reset';
    tag.onclick = () => { adj[s.key] = s.def; range.value = s.def; val.textContent = (+s.def).toFixed(2); };

    const range = document.createElement('input');
    range.type = 'range';
    range.min = s.min; range.max = s.max; range.step = s.step;
    range.value = adj[s.key];

    const val = document.createElement('span');
    val.className = 'adjust-val';
    val.textContent = (+adj[s.key]).toFixed(2);

    range.oninput = () => { adj[s.key] = +range.value; val.textContent = (+range.value).toFixed(2); };

    group.append(tag, range, val);
    row.appendChild(group);
  }
  return row;
}

export function buildMediaRow(i) {
  const mediaRow = document.createElement('div');
  mediaRow.className = 'piece-media';
  const m = pieceMedia[i];

  const thumb = document.createElement('img');
  thumb.className = 'media-thumb' + (m ? ' on' : '');
  thumb.id = `thumb${i}`;
  if (m) {
    if (m.type === 'image') {
      thumb.src = m.el.src;
    } else if (m.type === 'caption') {
      // captions have no frame — show a "CC" badge instead
      thumb.src = captionThumbURL();
    } else if (m.type === 'sequence') {
      // sequences draw from the shared pool, not their own el — badge it
      const tc = document.createElement('canvas');
      tc.width = 40; tc.height = 28;
      const g = tc.getContext('2d');
      g.fillStyle = '#1e2a16'; g.fillRect(0, 0, 40, 28);
      g.fillStyle = '#8fd16f'; g.font = '700 11px system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('SEQ', 20, 15);
      thumb.src = tc.toDataURL();
    } else {
      // video or gif: el is a video/canvas — snapshot the current frame
      const tc = document.createElement('canvas');
      tc.width = 40; tc.height = 28;
      try { tc.getContext('2d').drawImage(m.el, 0, 0, 40, 28); } catch (e) {}
      thumb.src = tc.toDataURL();
    }
  }

  const nameEl = document.createElement('span');
  nameEl.className = 'media-name';
  nameEl.textContent = m ? m.name : 'no media';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  // image/video frames + JSON caption cue files. The explicit .json extension
  // is needed alongside the MIME type so iOS Safari's picker doesn't grey it out.
  fileInput.accept = 'image/*,video/*,application/json,.json';
  fileInput.style.display = 'none';
  fileInput.onchange = e => {
    const file = e.target.files[0];
    // loadMediaFile only calls this refresh callback on a SUCCESSFUL attach
    // (failure paths just set statusEl text) — so closing the panel here means
    // it collapses right when there's something new to look at, not on errors.
    if (file) loadMediaFile(i, file, closePanelAndRefresh);
    e.target.value = '';
  };

  const upBtn = document.createElement('button');
  upBtn.className = 'upload-btn';
  upBtn.textContent = m ? '⟳ swap' : '+ media';
  upBtn.onclick = () => fileInput.click();

  // Attaching from a URL (vs. a local file) is what lets this piece's media
  // round-trip through a saved config — see getCalData() in configIO.js,
  // which can only reference media by URL, not re-embed a local pick. Kept
  // deliberately minimal (a native prompt) rather than a whole persistent
  // input field, matching the rest of this UI's style.
  const urlBtn = document.createElement('button');
  urlBtn.className = 'upload-btn';
  urlBtn.title = 'Attach media by URL — required for this piece\'s media to be included when you save a config';
  urlBtn.textContent = '🔗';
  urlBtn.onclick = () => {
    const url = prompt(`${PIECES[i].name}: media URL`, m && m.sourceURL || '');
    if (!url) return;
    statusEl.textContent = `${PIECES[i].name}: loading…`;
    loadMediaFromURL(i, url, closePanelAndRefresh)
      .catch(err => { statusEl.textContent = `${PIECES[i].name}: ${err.message || 'load failed'}`; });
  };

  const clrMediaBtn = document.createElement('button');
  clrMediaBtn.className = 'clear-media-btn';
  clrMediaBtn.textContent = '✕';
  clrMediaBtn.disabled = !m;
  clrMediaBtn.onclick = () => { disposeMedia(i); buildUI(); };

  const rowButtons = [thumb, nameEl, fileInput, upBtn, urlBtn];

  // Click-through link — only meaningful once there's media to tap on. This
  // is deliberately separate from urlBtn: the asset's own URL (what's drawn
  // on the piece) and the link it opens when tapped can be totally different
  // domains — see links.js for where the tap is actually handled.
  if (m) {
    const linkBtn = document.createElement('button');
    linkBtn.className = 'upload-btn';
    linkBtn.title = 'Set a link to open when this piece is tapped (separate from the media\'s own URL)';
    linkBtn.textContent = m.link ? '↗ linked' : '↗ link';
    if (m.link) linkBtn.classList.add('done');
    linkBtn.onclick = () => {
      const link = prompt(`${PIECES[i].name}: open this URL when tapped (blank to remove)`, m.link || '');
      if (link === null) return;
      m.link = link.trim() || null;
      buildUI();
    };
    rowButtons.push(linkBtn);
  }

  rowButtons.push(clrMediaBtn);
  mediaRow.append(...rowButtons);
  if (!m) return mediaRow;

  const wrap = document.createElement('div');
  wrap.append(mediaRow, buildAdjustRow(i));
  return wrap;
}