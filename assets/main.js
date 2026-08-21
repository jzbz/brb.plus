/* brb.plus — Blu-ray Backup
   Vanilla ES6. Everything here is an enhancement: with JS off the page is
   complete, every line of the terminal is on screen, and no content is hidden. */

'use strict';

/* Tell the head snippet the enhancement script really ran; without this it
   withdraws the .js class and every .reveal stays visible. */
document.documentElement.dataset.enhanced = '1';

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ─────────────────────────────  helpers  ───────────────────────────── */

/* A port of brb's ui.HumanBytes (internal/ui/ui.go): binary units, no
   decimals below 1 KiB, exactly two above, capped at TiB. */
function humanBytes(n) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return (i === 0 ? Math.round(v).toString() : v.toFixed(2)) + ' ' + units[i];
}

/* internal/ui/progress.go: "[%s%s] %5.1f%%  %s / %s", 24 cells, '=' and ' '. */
const BAR_WIDTH = 24;

function progressBar(cur, total) {
  let frac = total > 0 ? cur / total : 0;
  frac = Math.min(1, Math.max(0, frac));
  const filled = Math.floor(frac * BAR_WIDTH);
  const pct = (frac * 100).toFixed(1).padStart(5, ' ');
  return '[' + '='.repeat(filled) + ' '.repeat(BAR_WIDTH - filled) + '] ' +
    pct + '%  ' + humanBytes(cur) + ' / ' + humanBytes(total);
}

const groupDigits = (n) => n.toLocaleString('en-US');

/* Small counts read better as words in a sentence; the readout keeps digits. */
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve'];
const spell = (n) => (n < WORDS.length ? WORDS[n] : String(n));

/* Name a set of discs without letting the sentence grow with it: enumerating
   ten of them both reads badly and makes the readout two lines taller than the
   states either side of it. */
const pad2 = (d) => String(d.n).padStart(2, '0');

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function nameDiscs(list, noun) {
  const plural = noun + 's';
  if (list.length === 1) return noun + ' ' + pad2(list[0]);
  if (list.length <= 3) {
    return plural + ' ' + list.slice(0, -1).map(pad2).join(', ') +
      ' and ' + pad2(list[list.length - 1]);
  }
  return spell(list.length) + ' ' + plural;
}

/* ──────────────────────  background: a disc surface  ───────────────── */
/* Concentric data tracks with a slowly rotating sheen, drawn as two
   composited passes so the per-frame cost stays at one image blit and one
   gradient fill however many rings there are. */
class DiscSurface {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.off = document.createElement('canvas');
    this.angle = 0;
    this.running = false;

    this.resize();
    this.bind();
    this.start();
  }

  bind() {
    let t;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => this.resize(), 150);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
      else this.start();
    });
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.w = w;
    this.h = h;
    this.dpr = dpr;

    for (const c of [this.canvas, this.off]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    /* Sit the spindle off to the side on wide screens so the tracks read as a
       disc rather than as a target centred on the copy. */
    this.cx = w > 900 ? w * 0.74 : w * 0.5;
    this.cy = w > 900 ? h * 0.36 : h * 0.28;

    this.buildTracks();
  }

  buildTracks() {
    const c = this.off.getContext('2d');
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.strokeStyle = 'rgba(255,255,255,0.15)';
    c.lineWidth = 1;

    const maxR = Math.hypot(
      Math.max(this.cx, this.w - this.cx),
      Math.max(this.cy, this.h - this.cy)
    );
    const step = this.w < 760 ? 12 : 9;

    for (let r = 44; r < maxR; r += step) {
      c.beginPath();
      c.arc(this.cx, this.cy, r, 0, Math.PI * 2);
      c.stroke();
    }

    /* the hub */
    c.strokeStyle = 'rgba(255,255,255,0.3)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(this.cx, this.cy, 26, 0, Math.PI * 2);
    c.stroke();
  }

  sheen() {
    const ctx = this.ctx;
    let g;
    if (typeof ctx.createConicGradient === 'function') {
      g = ctx.createConicGradient(this.angle, this.cx, this.cy);
    } else {
      /* No conic gradient: a rotating linear one still reads as a sweep. */
      const r = Math.max(this.w, this.h);
      g = ctx.createLinearGradient(
        this.cx - Math.cos(this.angle) * r, this.cy - Math.sin(this.angle) * r,
        this.cx + Math.cos(this.angle) * r, this.cy + Math.sin(this.angle) * r
      );
    }
    g.addColorStop(0.00, '#3B82F6');
    g.addColorStop(0.24, '#4CC9F0');
    g.addColorStop(0.46, '#A9E8FF');
    g.addColorStop(0.66, '#8B5CF6');
    g.addColorStop(0.84, '#3B82F6');
    g.addColorStop(1.00, '#3B82F6');
    return g;
  }

  /* The sheen turns once every ~63 seconds, so 30fps is indistinguishable from
     60 and costs half the full-viewport gradient fills. The angle comes from
     the clock rather than a frame counter, so the speed is the same on a 144Hz
     panel as on a throttled tab. */
  frame(now) {
    if (!this.running) return;
    this.rafId = requestAnimationFrame((t) => this.frame(t));

    if (this.last !== undefined && now - this.last < 32) return;
    this.last = now;
    this.angle = (now / 1000) * 0.1;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.drawImage(this.off, 0, 0, this.w, this.h);

    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = this.sheen();
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = 'source-over';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = undefined;
    this.rafId = requestAnimationFrame((t) => this.frame(t));
  }

  /* Cancelling matters: a frame is always already queued, and without this
     every tab switch would leave another live loop behind. */
  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }
}

/* ────────────────────  the disc set (signature piece)  ─────────────── */
/* The discs live in the markup — they are worth looking at with the script
   off — so the file counts here have one home, and they are the same numbers
   the plan output in the terminal above prints. */
const STATES = ['ok', 'scratched', 'lost'];

class DiscSet {
  constructor(root) {
    this.root = root;
    this.grid = root.querySelector('#discs');
    this.mode = 'brb';

    this.discs = Array.from(root.querySelectorAll('.disc')).map((el, i) => ({
      n: i + 1,
      files: Number(el.dataset.files),
      gib: Number(el.dataset.gib),
      el,
      label: el.querySelector('.disc-label')
    }));

    this.totalFiles = this.discs.reduce((a, d) => a + d.files, 0);
    this.totalGib = this.discs.reduce((a, d) => a + d.gib, 0);
    this.state = this.discs.map(() => 'ok');

    this.out = {
      set: root.querySelector('#ro-set'),
      files: root.querySelector('#ro-files'),
      data: root.querySelector('#ro-data'),
      note: root.querySelector('#ro-note'),
      hint: root.querySelector('#discset-hint')
    };

    this.bind();
    this.render();

    root.querySelectorAll('input[name="setmode"]').forEach((r) => {
      r.addEventListener('change', () => {
        this.mode = r.value;
        this.state = this.state.map(() => 'ok');
        this.grid.classList.toggle('stream', this.mode === 'split');
        this.render();
      });
    });

    root.querySelector('#discs-reset').addEventListener('click', () => {
      this.state = this.state.map(() => 'ok');
      this.render();
    });
  }

  bind() {
    this.discs.forEach((d, i) => {
      d.el.addEventListener('click', () => this.cycle(i));
    });
  }

  cycle(i) {
    const next = STATES[(STATES.indexOf(this.state[i]) + 1) % STATES.length];

    /* Both formats get the same three states. A scratch is where the two
       genuinely agree — par2 over a piece works the same however the bytes
       were cut — so denying the alternative its repairable state would win the
       comparison on the one failure mode that is not actually different. The
       divergence is at 'lost', and that is enough. */
    if (this.mode === 'split' && next === 'lost') {
      /* One compressed, encrypted stream: a gap takes everything after it. */
      this.state = this.discs.map((_, j) => (j > i ? 'lost' : this.state[j]));
      this.state[i] = 'lost';
    } else if (this.mode === 'split' && next === 'ok') {
      /* Putting a piece back puts the tail it took with it back too. */
      this.state = this.discs.map((_, j) => (j >= i ? 'ok' : this.state[j]));
    } else {
      this.state[i] = next;
    }
    this.render();
  }

  render() {
    const split = this.mode === 'split';
    const lost = [];
    const scratched = [];

    this.discs.forEach((d, i) => {
      const s = this.state[i];
      d.el.dataset.state = s;
      d.label.textContent = (split ? 'piece ' : 'disc ') + String(d.n).padStart(2, '0');
      d.el.setAttribute('aria-label',
        (split ? 'piece ' : 'disc ') + String(d.n).padStart(2, '0') + ', ' +
        groupDigits(d.files) + ' files, ' +
        (s === 'ok' ? 'readable' : s === 'scratched' ? 'scratched but repairable' : 'lost') +
        '. Activate to change.');
      if (s === 'lost') lost.push(d);
      if (s === 'scratched') scratched.push(d);
    });

    const filesLeft = this.totalFiles - lost.reduce((a, d) => a + d.files, 0);
    const gibLeft = this.totalGib - lost.reduce((a, d) => a + d.gib, 0);
    const independent = split ? 0 : this.discs.length - lost.length;
    const tone = lost.length ? 'badish' : scratched.length ? 'warnish' : '';
    const b = (v) => '<b class="' + tone + '">' + v + '</b>';

    this.out.set.innerHTML = b(independent) + ' of ' + this.discs.length +
      ' discs restore on their own';
    this.out.files.innerHTML = b(groupDigits(filesLeft)) + ' of ' +
      groupDigits(this.totalFiles) + ' still restore';
    this.out.data.innerHTML = b(gibLeft.toFixed(2) + ' GiB') + ' of ' +
      this.totalGib.toFixed(2) + ' GiB still restore';

    /* The two read to the same length on purpose: a hint that rewraps as you
       switch mode shifts everything under it. */
    this.out.hint.textContent = split
      ? 'Click a piece to scratch it, again to lose it. Then switch the format ' +
        'back and lose the same one.'
      : 'Click a disc to scratch it, again to lose it. Then switch the format ' +
        'underneath and lose the same one.';

    this.out.note.innerHTML = split
      ? this.splitNote(lost, scratched)
      : this.note(lost, scratched);
  }

  /* ── brb: one image per disc ── */
  /* Every branch below is written to about the same length. A readout that
     grows and shrinks as you click moves the discs out from under the pointer,
     and the reasoning behind each state is already in the cards underneath. */
  note(lost, scratched) {
    if (!lost.length && !scratched.length) {
      return 'Nothing is damaged. Any one of these discs restores its own files ' +
        'without the other ' + spell(this.discs.length - 1) + ' — no catalogue to ' +
        'find first, no volume order, no parity spread across the set.';
    }

    if (!lost.length) {
      const many = scratched.length > 1;
      return '<b class="warnish">' + capitalise(nameDiscs(scratched, 'disc')) + '</b> ' +
        (many ? 'no longer read' : 'no longer reads') + ' cleanly. Copy ' +
        (many ? 'the images off and par2 rebuilds them' : 'the image off and par2 rebuilds it') +
        ' from the 10% recovery data beside ' +
        (many ? 'each' : 'it') + ', computed over the <em>encrypted</em> bytes. ' +
        'Nothing is lost.';
    }

    const gone = lost.reduce((a, d) => a + d.files, 0);
    const many = lost.length > 1;
    const left = this.discs.length - lost.length;

    return '<b class="badish">' + capitalise(nameDiscs(lost, 'disc')) + '</b> ' +
      (many ? 'are' : 'is') +
      ' gone — par2 could not repair ' + (many ? 'them' : 'it') + ', and brb refuses ' +
      'to decrypt what it cannot prove is whole. That costs ' +
      '<b class="badish">' + groupDigits(gone) + ' files</b> and nothing else; ' +
      (left ? 'the other ' + spell(left) + ' discs are untouched.'
            : 'there is nothing left for it to take with it.');
  }

  /* ── the alternative: one stream cut into pieces ── */
  splitNote(lost, scratched) {
    if (!lost.length && scratched.length) {
      const many = scratched.length > 1;
      return '<b class="warnish">' + capitalise(nameDiscs(scratched, 'piece')) +
        '</b> ' + (many ? 'no longer read' : 'no longer reads') + ' cleanly, and ' +
        'par2 repairs ' + (many ? 'them' : 'it') + ' exactly as it repairs a brb ' +
        'disc. <b>This is where the two formats agree</b> — rot is not the ' +
        'interesting failure.';
    }

    if (!lost.length) {
      return 'The same tree, the same ten discs, but as one stream compressed and ' +
        'encrypted once and then cut into pieces. It packs tighter than brb can. ' +
        '<b>Not one of these pieces restores anything on its own.</b>';
    }

    const first = lost[0];
    const last = this.discs[this.discs.length - 1];
    const gone = lost.reduce((a, d) => a + d.files, 0);
    const cost = '<b class="badish">' + groupDigits(gone) + ' files</b>';

    /* The last piece is the one case where a split stream is no worse. */
    if (lost.length === 1) {
      return 'Piece <b class="badish">' + pad2(first) + '</b> is gone — ' + cost +
        '. It is the last piece, so nothing was waiting on it: the one position ' +
        'where a stream costs no more than brb, and you do not choose which disc ' +
        'you lose.';
    }

    return 'Piece <b class="badish">' + pad2(first) + '</b> is gone, and pieces ' +
      pad2(this.discs[first.n]) + ' through ' + pad2(last) + ' go with it — ' + cost +
      '. A compressor cannot resume mid-dictionary and a single age stream cannot ' +
      'resume mid-ciphertext.';
  }
}

/* ─────────────────────────  terminal replay  ───────────────────────── */
class Terminal {
  constructor(root) {
    this.root = root;
    this.lines = Array.from(root.querySelectorAll('.l'));
    this.bar = root.querySelector('.bar');
    this.barFinal = this.bar ? this.bar.textContent : '';
    this.barBytes = this.bar ? Number(this.bar.dataset.bytes) : 0;
    this.timers = [];
    this.playing = false;

    const replay = document.getElementById('term-replay');
    if (replay) replay.addEventListener('click', () => this.play());

    if (REDUCED) return;

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          io.disconnect();
          this.play();
        }
      }
    }, { threshold: 0.25 });
    io.observe(root);
  }

  clear() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  at(ms, fn) {
    this.timers.push(setTimeout(fn, ms));
  }

  play() {
    if (REDUCED) return;
    this.clear();

    this.root.classList.add('playing');
    this.lines.forEach((l) => l.classList.remove('shown'));
    if (this.bar) this.bar.textContent = progressBar(0, this.barBytes);

    let t = 120;
    this.lines.forEach((line) => {
      const text = line.textContent;
      const isCmd = line.querySelector('.p-cmd');
      const isBar = line.contains(this.bar);

      /* A prompt lands, then a beat while the program does the work. */
      if (isCmd) t += 320;

      this.at(t, () => {
        line.classList.add('shown');
        if (isBar) this.runBar();
      });

      t += isCmd ? 240 : isBar ? 1150 : Math.min(34 + text.length * 1.1, 120);
    });

    this.at(t + 300, () => {
      this.playing = false;
    });
    this.playing = true;
  }

  runBar() {
    if (!this.bar) return;
    const start = performance.now();
    const dur = 1050;

    /* rAF is throttled to nothing in a backgrounded tab, which would leave the
       bar frozen at 0.0%. Timers still fire, so one guarantees the end state. */
    this.at(dur + 150, () => {
      this.bar.textContent = this.barFinal;
    });

    const step = (now) => {
      /* clamped at both ends: a clock that reads backwards must not produce a
         negative byte count */
      const p = Math.min(1, Math.max(0, (now - start) / dur));
      /* ease out, so it slows into completion the way a real one does */
      const eased = 1 - Math.pow(1 - p, 2.2);
      this.bar.textContent = progressBar(Math.round(this.barBytes * eased), this.barBytes);
      if (p < 1) this.raf = requestAnimationFrame(step);
      else this.bar.textContent = this.barFinal;
    };
    this.raf = requestAnimationFrame(step);
  }
}

/* ──────────────────────────  copy buttons  ─────────────────────────── */
class CopyButtons {
  constructor() {
    this.timers = new WeakMap();
    document.querySelectorAll('[data-copy]').forEach((block) => {
      const btn = block.querySelector('.copy');
      const code = block.querySelector('code');
      if (!btn || !code) return;
      /* Remember the resting label now: reading it back mid-feedback would
         make "copied" the new resting label on a fast second click. */
      btn.dataset.label = btn.textContent;
      btn.addEventListener('click', () => this.copy(btn, code));
    });
  }

  async copy(btn, code) {
    const text = code.textContent;
    let ok = true;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        ok = this.execCopy(text);
      }
    } catch (_) {
      ok = this.execCopy(text);
    }

    /* When the clipboard is refused outright — an insecure origin, a denied
       permission — select the command in place so the keyboard still works. */
    if (!ok) this.select(code);

    btn.textContent = ok ? 'copied' : 'press ctrl-c';
    btn.dataset.done = '1';
    /* per button, not per instance: clicking a second command must not strand
       the first one showing "copied" */
    clearTimeout(this.timers.get(btn));
    this.timers.set(btn, setTimeout(() => {
      btn.textContent = btn.dataset.label;
      delete btn.dataset.done;
    }, ok ? 1400 : 2600));
  }

  execCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  select(code) {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/* ───────────────────────────  scroll reveal  ───────────────────────── */
class Reveal {
  constructor() {
    const els = document.querySelectorAll('.reveal');
    if (REDUCED || !('IntersectionObserver' in window)) {
      els.forEach((e) => e.classList.add('visible'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('visible');
        io.unobserve(e.target);
      }
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    els.forEach((e) => io.observe(e));
  }
}

/* ──────────────────────────  nav highlight  ────────────────────────── */
class NavSpy {
  constructor() {
    this.links = new Map();
    document.querySelectorAll('.site-nav a[href^="#"]').forEach((a) => {
      const sec = document.querySelector(a.getAttribute('href'));
      if (sec) this.links.set(sec, a);
    });
    if (!this.links.size || !('IntersectionObserver' in window)) return;

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const a = this.links.get(e.target);
        if (!a) continue;
        if (e.isIntersecting) {
          this.links.forEach((x) => x.classList.remove('active'));
          a.classList.add('active');
        }
      }
    }, { rootMargin: '-45% 0px -50% 0px' });

    this.links.forEach((_, sec) => io.observe(sec));
  }
}

/* ─────────────────────────────  bootstrap  ─────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  new Reveal();
  new CopyButtons();
  new NavSpy();

  const canvas = document.getElementById('rot');
  if (canvas && !REDUCED) new DiscSurface(canvas);

  const discset = document.getElementById('discset');
  if (discset) new DiscSet(discset);

  const term = document.getElementById('term');
  if (term) new Terminal(term);
});
