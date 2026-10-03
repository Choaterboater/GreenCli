// GreenCLI site: the photo viewer and the Mac / Windows switch on the help
// page. No tracking, no network calls. Pages work without it: a photo link
// opens the picture, and the help shows both Mac and Windows lines.
(function () {
  var root = document.documentElement;
  root.classList.add('js');

  // ── Mac / Windows keys (help page) ──
  var KEY = 'greencli-site-os';
  var os = null;
  try {
    os = localStorage.getItem(KEY);
  } catch (e) {
    /* storage blocked: fall back to the visitor's system */
  }
  if (os !== 'mac' && os !== 'win') {
    os = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '') ? 'mac' : 'win';
  }
  root.setAttribute('data-os', os);

  function pickOs(next) {
    root.setAttribute('data-os', next);
    try {
      localStorage.setItem(KEY, next);
    } catch (e) {
      /* fine: the choice just isn't remembered */
    }
    var buttons = document.querySelectorAll('[data-os-pick]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-os-pick') === next));
    }
  }

  // ── Photo viewer ──
  // One entry per picture, even when two links show it (the top photo is
  // also in the grid).
  var photos = [];
  var at = 0;
  var box = null;
  var opener = null;
  var img = null;
  var caption = null;

  function button(cls, label, text) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'lb-btn ' + cls;
    b.setAttribute('aria-label', label);
    b.textContent = text;
    return b;
  }

  function show(i) {
    at = (i + photos.length) % photos.length;
    var p = photos[at];
    img.src = p.href;
    img.alt = p.alt;
    caption.textContent = at + 1 + ' of ' + photos.length + ' · ' + p.caption;
  }

  function build() {
    box = document.createElement('dialog');
    box.className = 'lightbox';
    box.setAttribute('aria-label', 'Photo');
    var close = button('lb-close', 'Close', '×');
    var prev = button('lb-prev', 'Previous photo', '‹');
    var next = button('lb-next', 'Next photo', '›');
    img = document.createElement('img');
    img.className = 'lb-img';
    caption = document.createElement('p');
    caption.className = 'lb-caption';
    var stage = document.createElement('div');
    stage.className = 'lb-stage';
    stage.appendChild(img);
    box.appendChild(close);
    box.appendChild(prev);
    box.appendChild(next);
    box.appendChild(stage);
    box.appendChild(caption);
    document.body.appendChild(box);
    close.addEventListener('click', function () {
      box.close();
    });
    prev.addEventListener('click', function () {
      show(at - 1);
    });
    next.addEventListener('click', function () {
      show(at + 1);
    });
    // A click on the dark area around the photo closes it.
    stage.addEventListener('click', function (e) {
      if (e.target === stage) box.close();
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') show(at - 1);
      else if (e.key === 'ArrowRight') show(at + 1);
    });
    box.addEventListener('close', function () {
      img.removeAttribute('src');
      if (opener) opener.focus();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var picks = document.querySelectorAll('[data-os-pick]');
    for (var i = 0; i < picks.length; i++) {
      picks[i].addEventListener('click', function (e) {
        pickOs(e.currentTarget.getAttribute('data-os-pick'));
      });
    }
    pickOs(os);

    var links = document.querySelectorAll('a[data-zoom]');
    if (!links.length || typeof HTMLDialogElement === 'undefined') return;
    var hrefs = [];
    Array.prototype.forEach.call(links, function (a) {
      var href = a.getAttribute('href');
      var i = hrefs.indexOf(href);
      if (i === -1) {
        i = hrefs.push(href) - 1;
        var pic = a.querySelector('img');
        var alt = pic ? pic.alt : '';
        photos.push({ href: href, alt: alt, caption: a.getAttribute('data-caption') || alt });
      }
      a.addEventListener('click', function (e) {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return; // new tab etc.
        e.preventDefault();
        if (!box) build();
        opener = a;
        show(i);
        box.showModal();
      });
    });
  });
})();
