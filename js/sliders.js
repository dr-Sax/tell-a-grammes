// ── sliders: the one slider factory ───────────────────────────────────────────
// Every slider in the app — the detection controls, the stereo controls, and
// the per-piece media framing rows — is the same widget: a label, a range
// input, and a live value readout, wired to a get/set pair. This module is
// that widget, built once. It has no imports and knows nothing about what any
// slider controls; callers hand it closures.
//
// Two skins, matching the two contexts in styles.css:
//   default  — .ctrl-group: the roomy top-bar style (detection + stereo).
//              Value sits inside the label, before the range.
//   compact  — .adjust-group: the dense per-piece framing style. Tag on the
//              left (tap to reset), value on the right in monospace.
//
// makeSlider returns { el, sync }:
//   el   — the DOM node to append
//   sync — re-reads get() into the range + readout. Callers that mutate the
//          underlying value outside the slider (config load, reset) call this
//          instead of reaching into the DOM by id, which is what the old
//          syncSliders had to do.

export function makeSlider({
  label, min, max, step,
  get, set,
  format = v => String(v),
  compact = false,
  resetTo = undefined,   // compact only: tapping the tag resets to this value
}) {
  const range = document.createElement('input');
  range.type = 'range';
  range.min = min; range.max = max; range.step = step;

  const val = document.createElement('span');

  const sync = () => {
    range.value = get();
    val.textContent = format(get());
  };

  range.oninput = () => {
    set(+range.value);
    val.textContent = format(get());
  };

  let el;
  if (compact) {
    // <label.adjust-group> <span.adjust-tag/> <range/> <span.adjust-val/> </label>
    el = document.createElement('label');
    el.className = 'adjust-group';

    const tag = document.createElement('span');
    tag.className = 'adjust-tag';
    tag.textContent = label;
    if (resetTo !== undefined) {
      tag.title = 'reset';
      tag.onclick = () => { set(resetTo); sync(); };
    }

    val.className = 'adjust-val';
    el.append(tag, range, val);
  } else {
    // <div.ctrl-group> <label>text <span/></label> <range flex/> </div>
    el = document.createElement('div');
    el.className = 'ctrl-group';

    const lbl = document.createElement('label');
    lbl.append(label + ' ', val);

    range.style.flex = '1';
    el.append(lbl, range);
  }

  sync();
  return { el, sync };
}