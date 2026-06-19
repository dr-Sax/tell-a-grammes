// ── HID detect: "is the Arduino-as-mouse connected?" ───────────────────────────
// There is no browser API (iOS Safari included) that reports HID device
// identity for a standard mouse — once the Arduino enumerates as a mouse it is
// indistinguishable from any other mouse/trackpad. So "detection" here means
// passive activity sensing: did *any* pointer/wheel input arrive recently?
// That's sufficient on iOS, where there's normally no other mouse around to
// confuse it with.
//
// WebHID (navigator.hid) WOULD give real device identity (vendor/product ID)
// but is Chrome/Edge-only and unsupported on every iOS browser, since iOS
// browsers are all WebKit under the hood. It's included below as an optional
// desktop-only diagnostic — never rely on it for the iPad/iPhone target.

export const hidState = {
  connected: false,     // true if pointer/wheel activity seen within TIMEOUT_MS
  lastEventType: null,  // 'pointermove' | 'wheel' | 'pointerdown' | null
  lastDelta: { dx: 0, dy: 0 },
  lastSeen: 0,           // performance.now() of the last qualifying event
  eventCount: 0,         // events seen since the last rate sample (debug use)
  webHidDevices: [],     // populated only if WebHID is available (desktop)
};

const TIMEOUT_MS = 700;  // no activity for this long ⇒ treat as disconnected
let timeoutHandle = null;

function markActive(type, dx, dy) {
  hidState.connected = true;
  hidState.lastEventType = type;
  hidState.lastDelta.dx = dx;
  hidState.lastDelta.dy = dy;
  hidState.lastSeen = performance.now();
  hidState.eventCount++;

  clearTimeout(timeoutHandle);
  timeoutHandle = setTimeout(() => { hidState.connected = false; }, TIMEOUT_MS);
}

// Start passive listening. Call once at boot, same as the other wire* fns.
export function startHidWatch() {
  document.addEventListener('pointermove', e => {
    if (e.movementX === 0 && e.movementY === 0) return;  // ignore zero-delta noise
    markActive('pointermove', e.movementX, e.movementY);
  });

  document.addEventListener('wheel', e => {
    markActive('wheel', e.deltaX, e.deltaY);
  }, { passive: true });

  // A click/tap from the device counts as activity too (e.g. a knob's push-button).
  document.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') markActive('pointerdown', 0, 0);
  });

  tryWebHidDiagnostic();  // no-op on iOS; fine to call unconditionally
}

// Desktop-only diagnostic. Does nothing useful on iOS Safari (API absent).
// Lists HID devices the user has previously granted permission to, plus
// listens for new connect/disconnect events while the page is open.
async function tryWebHidDiagnostic() {
  if (!('hid' in navigator)) return;  // WebHID unsupported — expected on iOS
  try {
    hidState.webHidDevices = await navigator.hid.getDevices();
    navigator.hid.addEventListener('connect', ({ device }) => {
      hidState.webHidDevices.push(device);
    });
    navigator.hid.addEventListener('disconnect', ({ device }) => {
      hidState.webHidDevices = hidState.webHidDevices.filter(d => d !== device);
    });
  } catch (e) {
    // permissions API quirks, ignore — this path is a bonus diagnostic only
  }
}

// Optional: trigger the WebHID permission picker (desktop Chrome/Edge only).
// Not called automatically — wire to a button if you want it during desktop
// debugging. Filter by vendorId if you know the Arduino Due's USB VID.
export async function requestWebHidDevice() {
  if (!('hid' in navigator)) {
    throw new Error('WebHID not supported in this browser (expected on iOS)');
  }
  const devices = await navigator.hid.requestDevice({ filters: [] });
  hidState.webHidDevices.push(...devices);
  return devices;
}