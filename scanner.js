// ===== SNS Tyres — scanner.js =====
// One shared scanner for all four scan points (Intake serial, Sell, Claim,
// Sub-Dealer move), so the camera lifecycle is written and fixed once.
//
// Decoding is the native BarcodeDetector API, which reads QR codes *and* 1D
// barcodes — so it reads whatever the manufacturer printed on the tyre, with
// no library to load. No iOS browser implements it (they are all WebKit), but
// SNS staff are on Android — confirmed 20/7/2026, iPhone support explicitly
// not needed. Any browser that lacks it still gets a clear "type it in"
// message rather than a dead camera.
//
// Pattern credit: the freeze-and-confirm flow, the camera-track cleanup and
// the onloadedmetadata fix all come from the battery-dealership scanner POC.

window.SNSScanner = (function () {
  'use strict';

  var stylesInjected = false;

  // A tyre's own printed barcode is most likely Code128 or an EAN/UPC
  // variant; the rest cost nothing to include.
  var FORMATS = [
    'qr_code', 'data_matrix',
    'code_128', 'code_39', 'code_93', 'codabar',
    'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e',
  ];

  function supported() {
    return 'BarcodeDetector' in window;
  }

  async function buildDetector_() {
    var available = [];
    try {
      available = await window.BarcodeDetector.getSupportedFormats();
    } catch (e) { /* fall back to requesting the full set */ }
    var formats = available.length
      ? FORMATS.filter(function (f) { return available.indexOf(f) !== -1; })
      : FORMATS;
    if (!formats.length) throw new Error('This browser cannot decode barcodes.');
    return new window.BarcodeDetector({ formats: formats });
  }

  function injectStyles_() {
    if (stylesInjected) return;
    stylesInjected = true;
    var css = [
      '.snsscan { display:none; margin-top:10px; border:1px solid #E7E3DD; border-radius:12px; overflow:hidden; background:#000; }',
      '.snsscan.open { display:block; }',
      '.snsscan-stage { position:relative; }',
      '.snsscan-stage video { width:100%; display:block; max-height:52vh; object-fit:cover; background:#000; }',
      // Aiming frame — gives staff something to centre the code in.
      '.snsscan-frame { position:absolute; inset:18% 12%; border:2px solid rgba(255,255,255,0.7); border-radius:12px; pointer-events:none; }',
      '.snsscan-bar { display:flex; gap:8px; padding:8px; background:#262B36; }',
      '.snsscan-bar button { margin:0; flex:1; width:auto; padding:10px; font-size:14px; font-weight:700; border:0; border-radius:8px; cursor:pointer; color:#fff; background:#3D4453; }',
      '.snsscan-msg { padding:8px 10px; font-size:12px; line-height:1.4; color:#EDEDED; background:#262B36; }',
      '.snsscan-msg.err { color:#FFB4B4; }',
      // Confirm panel — a detected code is shown for approval, never applied silently.
      '.snsscan-confirm { display:none; padding:10px; background:#FDF6E7; border-top:1px solid #F0DFB5; }',
      '.snsscan-confirm.open { display:block; }',
      '.snsscan-confirm .val { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:16px; font-weight:700; word-break:break-all; color:#23262B; margin-bottom:8px; }',
      '.snsscan-confirm .row { display:flex; gap:8px; }',
      '.snsscan-confirm button { margin:0; flex:1; width:auto; padding:11px; font-size:14px; font-weight:700; border:0; border-radius:8px; cursor:pointer; }',
      '.snsscan-confirm .yes { background:#1E7A46; color:#fff; }',
      '.snsscan-confirm .no { background:#E7E3DD; color:#23262B; }',
    ].join('\n');
    var el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  // Attaches a scanner to one button + one input. Each call keeps its own
  // camera and confirmation state in closure, so the several scanners on a
  // page never interfere with each other.
  //
  //   opts.buttonId — button that opens the camera
  //   opts.inputId  — input the confirmed value is written into
  //   opts.mountId  — empty element the scanner UI is built inside
  //   opts.onResult — optional callback(value)
  function attach(opts) {
    var button = document.getElementById(opts.buttonId);
    var input = document.getElementById(opts.inputId);
    var mount = document.getElementById(opts.mountId);
    if (!button || !input || !mount) return null;

    injectStyles_();
    mount.className = 'snsscan';
    mount.innerHTML =
      '<div class="snsscan-stage"><video playsinline muted autoplay></video><div class="snsscan-frame"></div></div>' +
      '<div class="snsscan-msg"></div>' +
      '<div class="snsscan-confirm"><div class="val"></div>' +
      '<div class="row"><button type="button" class="yes">Use this</button>' +
      '<button type="button" class="no">Scan again</button></div></div>' +
      '<div class="snsscan-bar"><button type="button" class="close">Close camera</button></div>';

    var video = mount.querySelector('video');
    var msgEl = mount.querySelector('.snsscan-msg');
    var confirmEl = mount.querySelector('.snsscan-confirm');
    var valueEl = mount.querySelector('.val');

    var stream = null;
    var detector = null;
    var awaitingConfirm = false;
    var pendingValue = null;
    var starting = false;

    function say(text, cls) {
      msgEl.textContent = text;
      msgEl.className = 'snsscan-msg' + (cls ? ' ' + cls : '');
    }

    function close() {
      if (stream) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        stream = null;
      }
      video.srcObject = null;
      awaitingConfirm = false;
      pendingValue = null;
      confirmEl.classList.remove('open');
      mount.classList.remove('open');
    }

    function scanLoop() {
      // A null stream means close() ran — end the loop rather than spinning
      // requestAnimationFrame against a dead video element.
      if (!stream) return;
      if (!awaitingConfirm) {
        detector.detect(video)
          .then(function (codes) {
            if (!codes.length || awaitingConfirm || !stream) return;
            pendingValue = String(codes[0].rawValue).trim();
            awaitingConfirm = true;
            // Freeze the exact frame that decoded, so staff confirm something
            // concrete instead of a value appearing from a moving picture.
            video.pause();
            valueEl.textContent = pendingValue;
            confirmEl.classList.add('open');
            say('Code detected — check it matches the tyre, then confirm.');
          })
          .catch(function () { /* transient decode failure — keep scanning */ });
      }
      requestAnimationFrame(scanLoop);
    }

    async function open() {
      if (starting || stream) return;

      if (!supported()) {
        say('');
        alert('This browser cannot scan barcodes. Please type the code in manually.');
        input.focus();
        return;
      }

      starting = true;
      mount.classList.add('open');
      confirmEl.classList.remove('open');
      say('Starting camera…');

      try {
        if (!detector) detector = await buildDetector_();
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (err) {
        starting = false;
        close();
        say('Camera unavailable (' + (err.name || err.message) + '). Type the code instead.', 'err');
        mount.classList.add('open');
        input.focus();
        return;
      }

      video.srcObject = stream;
      // Some Android Chrome builds paint a black frame if play() races the
      // stream's metadata — wait for it explicitly.
      video.onloadedmetadata = function () { video.play().catch(function () {}); };

      starting = false;
      say('Point the camera at the barcode printed on the tyre.');
      scanLoop();
    }

    mount.querySelector('.yes').addEventListener('click', function () {
      input.value = pendingValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      var applied = pendingValue;
      close();
      if (opts.onResult) opts.onResult(applied);
    });

    mount.querySelector('.no').addEventListener('click', function () {
      confirmEl.classList.remove('open');
      awaitingConfirm = false;
      pendingValue = null;
      video.play().catch(function () {});
      say('Point the camera at the barcode printed on the tyre.');
      scanLoop();
    });

    mount.querySelector('.close').addEventListener('click', close);
    button.addEventListener('click', open);

    // Release the camera if the page is hidden or torn down — otherwise the
    // camera indicator stays lit and the device stays locked to this tab.
    window.addEventListener('pagehide', close);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) close();
    });

    return { open: open, close: close };
  }

  return { attach: attach, supported: supported };
})();
