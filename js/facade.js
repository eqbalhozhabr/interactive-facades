// Interactive facade viewer: swappable building views, clickable unit shapes, info tooltip,
// and video transitions between views that can also be scrubbed by dragging. One class serves
// every project; everything project specific comes from projects.json and the project's
// units.json / data.json / assets.
//
// Transitions: assets/transitions/trans-N-to-M.mp4 exist only for the forward direction
// (view N -> N+1, last -> first). Going backwards plays the same file in reverse. Playback is
// always "seek the video to a position", so one code path serves buttons, keys and dragging.

const wrap = (v, n) => ((v - 1 + n) % n) + 1;
const isSold = (d) => /sold/i.test(d?.status ?? '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const getJson = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });
const idle = (fn) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 500));

const TEMPLATE = `
  <div class="stage">
    <img class="bg" alt="Building facade" decoding="async">
    <svg class="units" preserveAspectRatio="xMidYMid meet"></svg>
    <video class="transition" muted playsinline preload="auto" disablepictureinpicture hidden></video>
    <div class="hint" aria-hidden="true">Drag to rotate</div>
    <a class="back" hidden></a>
    <nav class="view-nav" aria-label="Building views">
      <button class="nav-arrow" data-dir="-1" aria-label="Previous view">&#10094;</button>
      <div class="view-label" aria-live="polite"></div>
      <button class="nav-arrow" data-dir="1" aria-label="Next view">&#10095;</button>
    </nav>
  </div>
  <div class="tooltip" role="dialog" aria-label="Unit details">
    <button class="close-icon" aria-label="Close">&times;</button>
    <img class="plan-img" alt="Floor plan">
    <div class="data-tags">
      <span class="tag type-tag"></span>
      <span class="tag unit-tag"></span>
      <span class="tag status-tag"></span>
    </div>
    <div class="details-row">
      <div class="detail-item">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 12 12 17 22 12"></polyline><polyline points="2 17 12 22 22 17"></polyline></svg>
        <span class="floor"></span>
      </div>
      <div class="detail-item">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><path d="M3 9h18"></path><path d="M9 21V9"></path></svg>
        <span class="area"></span>
      </div>
    </div>
    <button class="main-btn" type="button"></button>
  </div>`;

export class Facade {
  #root; #project; #cfg;
  #ac = new AbortController();
  #raf = 0;
  #units; #data;
  #view = 1;
  #busy = false;
  #tx = null;                  // active transition: { to, reverse, p } with p = 0..1 away from the current view
  #wantT = null;               // latest requested video time (seeks are coalesced)
  #drag = null;
  #suppressClick = false;
  #tourLink = '';
  #tours = true;
  #back = null;
  #activeUnit = null;
  #fine = matchMedia('(hover: hover) and (pointer: fine)');
  #prefetched = new Set();
  #blobs = new Map();          // video url -> Promise<object URL>
  #el = {};

  // features.tours === false: showcase mode. No virtual-tour button and no link ever opens.
  constructor(root, project, features = {}) {
    this.#root = root;
    this.#project = project;
    this.#cfg = project.facade;
    this.#tours = features.tours !== false;
    this.#back = features.back ?? null;   // { href, label } shows a back link top-left; omit for none
  }

  async init() {
    const { dir, viewBox } = this.#cfg;
    [this.#units, this.#data] = await Promise.all([getJson(`${dir}/units.json`), getJson(`${dir}/data.json`)]);

    this.#root.innerHTML = TEMPLATE;
    this.#root.classList.toggle('no-tours', !this.#tours);
    const q = (s) => this.#root.querySelector(s);
    this.#el = {
      stage: q('.stage'), bg: q('.bg'), svg: q('.units'), video: q('.transition'), hint: q('.hint'), label: q('.view-label'),
      tip: q('.tooltip'), plan: q('.plan-img'), type: q('.type-tag'), unitNo: q('.unit-tag'),
      status: q('.status-tag'), floor: q('.floor'), area: q('.area'), btn: q('.main-btn'), close: q('.close-icon'),
    };
    this.#el.stage.style.setProperty('--ratio', viewBox[0] / viewBox[1]);
    this.#el.svg.setAttribute('viewBox', `0 0 ${viewBox[0]} ${viewBox[1]}`);

    if (this.#back) {
      const a = q('.back');
      a.href = this.#back.href;
      a.textContent = `❮ ${this.#back.label ?? 'Back'}`;
      a.hidden = false;
    }

    this.#bind();
    await this.#showView(1, true);
    idle(() => this.#prefetchNeighbours());
  }

  destroy() {
    this.#ac.abort();
    cancelAnimationFrame(this.#raf);
    this.#el.video?.removeAttribute('src');
    for (const p of this.#blobs.values()) p.then((u) => URL.revokeObjectURL(u), () => {});
    this.#blobs.clear();
  }

  // ---------- events ----------
  #bind() {
    const { signal } = this.#ac;
    const { svg, stage, tip, btn, close } = this.#el;

    const syncMode = () => this.#root.classList.toggle('touch', !this.#fine.matches);
    syncMode();
    this.#fine.addEventListener('change', syncMode, { signal });

    stage.querySelectorAll('.nav-arrow').forEach((b) =>
      b.addEventListener('click', () => this.#go(Number(b.dataset.dir)), { signal }));
    addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') this.#go(1);
      else if (e.key === 'ArrowLeft') this.#go(-1);
      else if (e.key === 'Escape') this.#hideTip();
    }, { signal });

    // The video drives scrubbing: when a seek lands, issue the newest pending one.
    this.#el.video.addEventListener('seeked', () => this.#issueSeek(), { signal });

    // Drag horizontally to rotate. Dragging left turns to the next view, right to the previous one.
    stage.addEventListener('pointerdown', (e) => this.#dragStart(e), { signal });
    stage.addEventListener('pointermove', (e) => this.#dragMove(e), { signal });
    stage.addEventListener('pointerup', (e) => this.#dragEnd(e), { signal });
    stage.addEventListener('pointercancel', (e) => this.#dragEnd(e), { signal });
    // A drag that started on a unit must not count as a click on it.
    stage.addEventListener('click', (e) => {
      if (this.#suppressClick) { e.stopPropagation(); e.preventDefault(); }
    }, { signal, capture: true });

    const unitOf = (e) => e.target.closest?.('.unit:not(.nodata)');

    svg.addEventListener('pointerover', (e) => {
      const u = unitOf(e);
      if (u && e.pointerType === 'mouse' && this.#fine.matches) { this.#fill(u.dataset.id); this.#place(e.clientX, e.clientY); }
    }, { signal });
    svg.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' && this.#fine.matches && unitOf(e)) this.#place(e.clientX, e.clientY);
    }, { signal });
    svg.addEventListener('pointerout', (e) => {
      if (unitOf(e) && e.pointerType === 'mouse' && this.#fine.matches) this.#hideTip();
    }, { signal });
    svg.addEventListener('click', (e) => {
      const u = unitOf(e);
      if (u) this.#activate(u);
    }, { signal });

    // Keyboard: focusing a unit previews it, Enter / Space activates it.
    svg.addEventListener('focusin', (e) => {
      const u = unitOf(e);
      if (!u) return;
      this.#fill(u.dataset.id);
      const r = u.getBoundingClientRect();
      this.#place(r.right, r.top + r.height / 2);
    }, { signal });
    svg.addEventListener('focusout', () => { if (this.#fine.matches) this.#hideTip(); }, { signal });
    svg.addEventListener('keydown', (e) => {
      const u = unitOf(e);
      if (u && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.#activate(u); }
    }, { signal });

    btn.addEventListener('click', () => this.#openTour(this.#tourLink), { signal });
    close.addEventListener('click', (e) => { e.stopPropagation(); this.#hideTip(); }, { signal });
  }

  // Mouse users jump straight into the tour (hover already shows the details); touch users get the details sheet first.
  #activate(unit) {
    const data = this.#data[unit.dataset.id.toLowerCase()];
    if (this.#fine.matches) {
      if (data && !isSold(data)) this.#openTour(data.tourLink);
      return;
    }
    this.#activeUnit?.classList.remove('active');
    this.#activeUnit = unit;
    unit.classList.add('active');
    this.#fill(unit.dataset.id);
  }

  #openTour(link) {
    if (this.#tours && link) window.open(link, '_blank', 'noopener');
  }

  // ---------- tooltip ----------
  #fill(id) {
    const d = this.#data[id.toLowerCase()];
    if (!d) return;
    const { plan, type, unitNo, status, floor, area, btn, tip } = this.#el;
    if (d.planImg) {
      plan.hidden = false;
      plan.onerror = () => { plan.hidden = true; };
      plan.src = `${this.#cfg.dir}/${d.planImg}`;
    } else plan.hidden = true;
    type.textContent = d.type;
    unitNo.textContent = d.unitNumber;
    status.textContent = d.status;
    floor.textContent = `${d.floor} floor`;
    area.textContent = d.area;

    const sold = isSold(d);
    this.#tourLink = this.#tours ? d.tourLink : '';
    status.classList.toggle('available', !sold);
    btn.classList.toggle('available', !sold && !!d.tourLink);
    btn.disabled = sold || !d.tourLink;
    btn.textContent = sold ? 'SOLD' : d.tourLink ? 'VIEW VIRTUAL TOUR' : 'TOUR COMING SOON';
    tip.classList.add('visible');
  }

  #place(cx, cy) {
    const { tip } = this.#el;
    const w = tip.offsetWidth, h = tip.offsetHeight, m = 8;
    let x = cx + 20, y = cy + 20;
    if (x + w > innerWidth - m) x = cx - w - 20;
    if (y + h > innerHeight - m) y = cy - h - 20;
    x = Math.max(m, Math.min(x, innerWidth - w - m));
    y = Math.max(m, Math.min(y, innerHeight - h - m));
    tip.style.transform = `translate(${x}px, ${y}px)`;
  }

  #hideTip() {
    this.#el.tip.classList.remove('visible');
    this.#activeUnit?.classList.remove('active');
    this.#activeUnit = null;
  }

  // ---------- views ----------
  async #showView(n, first = false) {
    this.#view = n;
    const { bg, label } = this.#el;
    await this.#setImage(bg, `${this.#cfg.dir}/assets/view-${n}.webp`);
    this.#renderUnits(n);
    label.textContent = `View ${n} / ${this.#cfg.views}`;
    if (!first) idle(() => this.#prefetchNeighbours());
  }

  #renderUnits(n) {
    const html = (this.#units.views[n] ?? []).map(({ id, d }) => {
      const data = this.#data[id.toLowerCase()];
      if (!data) return `<path class="unit nodata" data-id="${esc(id)}" d="${d}"/>`;
      const aria = `Unit ${data.unitNumber}, ${data.type}, ${data.status}`;
      return `<path class="unit ${isSold(data) ? 'sold' : 'avail'}" data-id="${esc(id)}" d="${d}" tabindex="0" role="button" aria-label="${esc(aria)}"/>`;
    }).join('');
    this.#el.svg.innerHTML = html;
  }

  #setImage(img, src) {
    return new Promise((resolve) => {
      const probe = new Image();
      probe.onload = probe.onerror = () => { img.src = src; resolve(); };
      probe.src = src;
    });
  }

  // ---------- transitions ----------
  #transitionFor(from, to) {
    const n = this.#cfg.views;
    if (to === wrap(from + 1, n)) return { file: `trans-${from}-to-${to}.mp4`, reverse: false };
    return { file: `trans-${to}-to-${from}.mp4`, reverse: true };
  }

  #videoUrl(file) {
    return `${this.#cfg.dir}/assets/transitions/${file}`;
  }

  // Button / key: play the whole transition.
  async #go(dir) {
    if (this.#busy) return;
    this.#busy = true;
    this.#hint();
    try {
      await this.#prepare(dir);
      await this.#animate(1);
      await this.#finish(true);
    } catch (err) {
      console.warn('Transition unavailable, switching without animation:', err.message);
      await this.#finish(true, wrap(this.#view + dir, this.#cfg.views));
    }
  }

  // Load the video for the step from the current view in `dir` and show its first frame.
  async #prepare(dir) {
    const from = this.#view;
    const to = wrap(from + dir, this.#cfg.views);
    const { file, reverse } = this.#transitionFor(from, to);
    await this.#loadVideo(this.#videoUrl(file));
    this.#hideTip();
    this.#el.svg.replaceChildren();
    this.#tx = { to, reverse, p: 0 };
    const landed = this.#seeked();
    this.#seekP(0);
    await landed;                               // show the video only once the right frame is decoded
    this.#el.video.hidden = false;
  }

  // Videos are small (~1-2 MB), so they are fetched whole into a blob: playback never waits on
  // range requests, seeking is instant, and a prefetched file is never downloaded twice.
  #blobUrl(url) {
    let p = this.#blobs.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.blob(); })
        .then((b) => URL.createObjectURL(b));
      p.catch(() => this.#blobs.delete(url));
      this.#blobs.set(url, p);
    }
    return p;
  }

  async #loadVideo(url) {
    const v = this.#el.video;
    const src = await this.#blobUrl(url);
    if (v.dataset.url === url && v.readyState >= 2) return;
    await new Promise((resolve, reject) => {
      v.dataset.url = url;
      v.onloadeddata = () => resolve();
      v.onerror = () => reject(new Error(`could not load ${url}`));
      v.src = src;
      v.load();
    });
  }

  // Position p (0..1) means "p of the way from the current view to the neighbour".
  // The file runs forward in time for the next view and backwards for the previous one.
  #seekP(p) {
    const { frames, fps } = this.#cfg.transition;
    const tx = this.#tx;
    tx.p = p;
    const q = tx.reverse ? 1 - p : p;
    this.#seek((0.5 + q * (frames - 1)) / fps);   // +0.5 lands in the middle of the frame, never on its edge
  }

  // Seeks are coalesced: while one is in flight only the newest request is kept.
  #seek(t) {
    this.#wantT = t;
    if (!this.#el.video.seeking) this.#issueSeek();
  }

  #issueSeek() {
    if (this.#wantT === null) return;
    const t = this.#wantT;
    this.#wantT = null;
    this.#el.video.currentTime = t;
  }

  // Resolves when the video has shown the frame it was last asked for (or after a short timeout).
  #seeked() {
    const v = this.#el.video;
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); v.removeEventListener('seeked', done); resolve(); };
      const timer = setTimeout(done, 400);
      v.addEventListener('seeked', done);
    });
  }

  // Move to p1 at the speed the original sprite animation had.
  #animate(p1) {
    const { frames, fps } = this.#cfg.transition;
    const p0 = this.#tx.p;
    const ms = Math.abs(p1 - p0) * ((frames - 1) / fps) * 1000;
    return new Promise((resolve) => {
      if (ms < 16) { this.#seekP(p1); resolve(); return; }
      let t0 = null;
      const tick = (now) => {
        t0 ??= now;
        const u = Math.min(1, (now - t0) / ms);
        this.#seekP(p0 + (p1 - p0) * u);
        if (u < 1) this.#raf = requestAnimationFrame(tick);
        else resolve();
      };
      this.#raf = requestAnimationFrame(tick);
    });
  }

  // Swap in the still image of the destination (or the original view when a drag was cancelled).
  async #finish(commit, forced) {
    const target = forced ?? (commit ? this.#tx.to : this.#view);
    if (this.#wantT !== null || this.#el.video.seeking) await this.#seeked();
    await this.#showView(target);
    this.#el.video.hidden = true;
    this.#tx = null;
    this.#busy = false;
  }

  // ---------- drag to rotate ----------
  #dragStart(e) {
    if (this.#busy || e.button > 0 || e.target.closest('.view-nav, .back')) return;
    this.#drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, active: false, dir: 0, ready: false, last: [e.clientX, performance.now()], vx: 0 };
  }

  #dragMove(e) {
    const d = this.#drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0;
    if (!d.active) {
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(e.clientY - d.y0)) return;
      d.active = true;
      d.dir = dx < 0 ? 1 : -1;
      this.#busy = true;
      this.#hint();
      this.#hideTip();
      this.#el.stage.setPointerCapture(e.pointerId);
      this.#el.stage.classList.add('dragging');
      this.#prepare(d.dir).then(() => { d.ready = true; }, () => { d.failed = true; });
    }
    const now = performance.now();
    d.vx = (e.clientX - d.last[0]) / Math.max(1, now - d.last[1]);
    d.last = [e.clientX, now];
    if (!d.ready) return;
    const along = Math.max(0, d.dir > 0 ? -dx : dx);   // only movement in the direction it started counts
    this.#seekP(Math.min(1, along / (this.#el.stage.clientWidth * 0.6)));
  }

  async #dragEnd(e) {
    const d = this.#drag;
    if (!d || e.pointerId !== d.id) return;
    this.#drag = null;
    if (!d.active) return;
    this.#el.stage.classList.remove('dragging');
    this.#suppressClick = true;
    setTimeout(() => { this.#suppressClick = false; }, 50);
    try {
      if (d.failed) throw new Error('transition video missing');
      while (!d.ready) await new Promise((r) => setTimeout(r, 30));
      const flick = d.vx * -d.dir > 0.5;               // fast flick in the drag direction commits too
      const commit = this.#tx.p > 0.35 || (flick && this.#tx.p > 0.05);
      await this.#animate(commit ? 1 : 0);
      await this.#finish(commit);
    } catch (err) {
      console.warn(err.message);
      await this.#finish(false);
    }
  }

  // The "Drag to rotate" hint disappears after the first interaction.
  #hint() {
    this.#el.hint?.classList.add('gone');
  }

  // Warm the HTTP cache for the neighbouring views (videos are about 1 MB each).
  #prefetchNeighbours() {
    const conn = navigator.connection;
    if (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? '')) return;
    const { dir, views } = this.#cfg;
    const keep = new Set();
    for (const to of [wrap(this.#view + 1, views), wrap(this.#view - 1, views)]) {
      const videoUrl = this.#videoUrl(this.#transitionFor(this.#view, to).file);
      keep.add(videoUrl);
      this.#blobUrl(videoUrl).catch(() => {});
      const still = `${dir}/assets/view-${to}.webp`;
      if (!this.#prefetched.has(still)) {
        this.#prefetched.add(still);
        fetch(still, { priority: 'low' }).catch(() => this.#prefetched.delete(still));
      }
    }
    // Drop videos that are no longer one step away.
    for (const [url, p] of this.#blobs) {
      if (keep.has(url)) continue;
      this.#blobs.delete(url);
      p.then((u) => URL.revokeObjectURL(u), () => {});
    }
  }
}
