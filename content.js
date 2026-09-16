// Floating "this week" progress widget injected into calendar.google.com.
// Two data sources: secret iCal feed ("ics") or reading the rendered
// calendar grid ("dom") for Workspace accounts whose admin hides the feed.
(async () => {
  // source '' = not chosen yet: page-reading by default, unless the user
  // had already configured feed URLs before this option existed.
  const DEFAULTS = { icsUrls: [], tracked: [], widgetCollapsed: false, source: '' };
  let settings = await chrome.storage.sync.get(DEFAULTS);
  if (!settings.source) settings.source = settings.icsUrls.length ? 'ics' : 'dom';
  let lastRows = [];
  let domEventsRead = 0;
  let viewWeekTs = null; // week shown in the widget (dom mode follows the view)
  let refreshBusy = false; // manual refresh in flight: drives the spinner and the note text
  let refreshWeekTs = null; // week the manual refresh asked for, so only its data clears the spinner
  let refreshError = false; // last manual refresh failed outright (dead context, no receiver)
  let refreshTimer = null; // failsafe, armed at click time so it bounds the busy window
  let refreshGen = 0; // generation counter: a stale failsafe must not clear a newer refresh

  // On Notion Calendar there is nothing to scan (its DOM is not supported
  // yet) — the widget renders from the data collected on calendar.google.com
  // and live-updates via storage events.
  const onNotion = location.hostname.endsWith('notion.so');

  // Remember which Google account's calendar to open for background
  // refreshes (multi-account /u/N/ paths).
  if (location.hostname === 'calendar.google.com') {
    const m = location.pathname.match(/^\/calendar\/u\/\d+\//);
    chrome.storage.local.set({ gttGcalPath: m ? m[0] : '/calendar/u/0/' });
  }

  const agoText = (ts) => {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  };

  const fmtH = (h) => (Math.round(h * 10) / 10).toString();

  const root = document.createElement('div');
  root.id = 'gtt-widget';
  document.documentElement.appendChild(root);

  const computeRows = (occurrences, refDate = new Date()) =>
    settings.tracked.map(({ name, target }) => {
      const rows = CalHours.weeklyHours(occurrences, name, 0, refDate);
      return { name, target, hours: rows[rows.length - 1].hours };
    });

  const render = () => {
    // The card is rebuilt on every render, so remember which control had focus
    // and hand it back, else keyboard users lose their place in the widget.
    const focused = document.activeElement?.classList?.contains('gtt-refresh')
      ? 'refresh'
      : document.activeElement?.classList?.contains('gtt-collapse')
        ? 'collapse'
        : null;
    root.textContent = '';
    const configured =
      settings.tracked.length && (settings.source === 'dom' || settings.icsUrls.length);
    if (!configured) {
      root.hidden = true;
      return;
    }
    root.hidden = false;

    if (settings.widgetCollapsed) {
      const pill = document.createElement('button');
      pill.className = 'gtt-pill';
      pill.title = 'GCal Time Tracker';
      const first = lastRows[0];
      pill.textContent = first
        ? `⏱ ${fmtH(first.hours)}${first.target ? `/${first.target}` : ''}h`
        : '⏱';
      pill.addEventListener('click', () => {
        settings.widgetCollapsed = false;
        chrome.storage.sync.set({ widgetCollapsed: false });
        render();
      });
      root.appendChild(pill);
      return;
    }

    const card = document.createElement('div');
    card.className = 'gtt-card';

    const head = document.createElement('div');
    head.className = 'gtt-head';
    const title = document.createElement('strong');
    const curTs = CalHours.weekStart(new Date()).getTime();
    const shownTs = viewWeekTs ?? curTs;
    title.textContent =
      shownTs === curTs
        ? 'This week'
        : `Week of ${new Date(shownTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    const collapse = document.createElement('button');
    collapse.className = 'gtt-collapse';
    collapse.textContent = '—';
    collapse.title = 'Collapse';
    collapse.addEventListener('click', () => {
      settings.widgetCollapsed = true;
      chrome.storage.sync.set({ widgetCollapsed: true });
      render();
    });
    head.append(title, collapse);
    card.appendChild(head);

    for (const row of lastRows) {
      const line = document.createElement('div');
      line.className = 'gtt-row';
      const label = document.createElement('span');
      label.className = 'gtt-name';
      label.textContent = row.name;
      const over = row.target && row.hours > row.target ? row.hours - row.target : 0;
      const under = row.target && row.hours < row.target ? row.target - row.hours : 0;
      const delta = over ? ` · +${fmtH(over)}h` : under ? ` · −${fmtH(under)}h` : '';
      const value = document.createElement('span');
      value.className = 'gtt-value';
      value.textContent = row.target ? `${fmtH(row.hours)} / ${row.target}h${delta}` : `${fmtH(row.hours)}h`;
      if (row.target && row.hours >= row.target) value.classList.add('gtt-hit');
      if (over) value.classList.add('gtt-over');
      if (under) value.classList.add('gtt-under');
      const bar = document.createElement('div');
      bar.className = 'gtt-bar';
      const fill = document.createElement('div');
      fill.className = 'gtt-fill';
      const pct = row.target ? Math.min(100, (row.hours / row.target) * 100) : 100;
      fill.style.width = `${pct}%`;
      if (row.target && row.hours >= row.target) fill.classList.add('gtt-hit');
      if (over) fill.classList.add('gtt-over');
      if (under) fill.classList.add('gtt-under');
      bar.appendChild(fill);
      line.append(label, value, bar);
      card.appendChild(line);
    }

    // Bottom row: where the data came from on the left, manual refresh in the corner.
    const foot = document.createElement('div');
    foot.className = 'gtt-foot';
    if (onNotion) {
      const note = document.createElement('div');
      note.className = 'gtt-note';
      note.setAttribute('role', 'status');
      const hasViewData = ((domWeeks && domWeeks[viewWeekTs]) || []).length > 0;
      note.textContent = refreshError
        ? "couldn't reach Google Calendar"
        : refreshBusy
          ? 'refreshing from Google Calendar…'
          : hasViewData
            ? `from Google Calendar · ${agoText(domWeeksAt)}`
            : 'fetching from Google Calendar…';
      foot.appendChild(note);
    } else if (settings.source === 'dom') {
      const note = document.createElement('div');
      note.className = 'gtt-note';
      note.setAttribute('role', 'status');
      note.textContent = refreshBusy
        ? 'rescanning the grid…'
        : refreshError
          ? 'refresh failed'
          : `page mode · ${domEventsRead} events read in view`;
      foot.appendChild(note);
    }

    const refreshBtn = document.createElement('button');
    refreshBtn.className = refreshBusy ? 'gtt-refresh gtt-busy' : 'gtt-refresh';
    refreshBtn.type = 'button';
    refreshBtn.title = refreshBusy ? 'Refreshing…' : 'Refresh now';
    refreshBtn.setAttribute('aria-label', refreshBusy ? 'Refreshing…' : 'Refresh now');
    refreshBtn.setAttribute('aria-busy', String(refreshBusy));
    refreshBtn.disabled = refreshBusy;
    const refreshIcon = document.createElement('span');
    refreshIcon.className = 'gtt-icon';
    refreshIcon.setAttribute('aria-hidden', 'true');
    refreshIcon.textContent = '↻';
    refreshBtn.appendChild(refreshIcon);
    refreshBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      manualRefresh();
    });
    foot.appendChild(refreshBtn);
    card.appendChild(foot);
    root.appendChild(card);
    if (focused === 'refresh') refreshBtn.focus();
    else if (focused === 'collapse') collapse.focus();
  };

  const refreshIcs = async () => {
    if (!settings.icsUrls.length || !settings.tracked.length) {
      render();
      return;
    }
    try {
      const { from, to } = CalHours.range(4);
      const texts = await Promise.all(
        settings.icsUrls.map((u) => fetch(u).then((r) => r.text()))
      );
      const occurrences = texts.flatMap((t) => CalHours.expandICS(t, from, to));
      lastRows = computeRows(occurrences);
      viewWeekTs = null; // feed mode always shows the current week
    } catch {
      // Keep the last good rows — transient fetch failures shouldn't blank the widget.
    }
    render();
  };

  const hydrate = (o) => ({ start: new Date(o.s), end: new Date(o.e), summary: o.m });

  // In-memory mirror of storage.local.gttDomWeeks — loaded once, written
  // through only when a week's data actually changes. Keeps every scan
  // synchronous after startup.
  let domWeeks = null;
  let domWeeksAt = 0;
  let renderSig = '';

  const loadDomWeeks = async () => {
    if (domWeeks) return;
    const got = await chrome.storage.local.get(['gttDomWeeks', 'gttDomWeeksAt']);
    domWeeks = got.gttDomWeeks || {};
    domWeeksAt = got.gttDomWeeksAt || 0;
  };

  // Ask the background worker to scan a specific week on calendar.google.com
  // when Notion shows a week we have no (or stale) data for. Throttled.
  const weekFetches = new Map(); // weekTs -> last request time
  const maybeFetchWeek = (ts) => {
    const hasData = (domWeeks[ts] || []).length > 0;
    const curTs = CalHours.weekStart(new Date()).getTime();
    const stale = ts === curTs ? Date.now() - domWeeksAt > 15 * 60 * 1000 : !hasData;
    if (!stale) return;
    if (Date.now() - (weekFetches.get(ts) || 0) < 5 * 60 * 1000) return;
    weekFetches.set(ts, Date.now());
    const d = new Date(ts);
    try {
      chrome.runtime
        .sendMessage?.({
          type: 'gtt-refresh-gcal',
          week: `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`,
        })
        ?.catch?.(() => {});
    } catch {
      // Extension context gone (reload/update): nothing to request, and a bare
      // throw here would surface as an uncaught error on the host page.
    }
  };

  const refreshNotion = async () => {
    await loadDomWeeks();
    // Follow the week shown in Notion's tab title ("8 – 14 Jun 2026 · …").
    const viewDate = CalDom.notionViewDate(document.title) || new Date();
    viewWeekTs = CalHours.weekStart(viewDate).getTime();
    lastRows = computeRows((domWeeks[viewWeekTs] || []).map(hydrate), new Date(viewWeekTs));
    maybeFetchWeek(viewWeekTs);
    const sig = JSON.stringify([viewWeekTs, lastRows, domWeeksAt, settings.widgetCollapsed]);
    if (sig !== renderSig) {
      renderSig = sig;
      render();
    }
  };

  const refreshDom = async () => {
    await loadDomWeeks();
    const occurrences = CalDom.scan();
    domEventsRead = occurrences.length;

    // Persist what's visible per week — history accumulates as you browse.
    const byWeek = new Map();
    for (const occ of occurrences) {
      const ts = CalHours.weekStart(occ.start).getTime();
      if (!byWeek.has(ts)) byWeek.set(ts, []);
      byWeek.get(ts).push({ s: +occ.start, e: +occ.end, m: occ.summary });
    }
    let dirty = false;
    for (const [ts, arr] of byWeek) {
      if (JSON.stringify(domWeeks[ts]) !== JSON.stringify(arr)) {
        domWeeks[ts] = arr;
        dirty = true;
      }
    }
    if (dirty) {
      domWeeksAt = Date.now();
      chrome.storage.local.set({ gttDomWeeks: domWeeks, gttDomWeeksAt: domWeeksAt });
    }

    // Follow the week the user is looking at — going back a week shows that
    // week's totals (and stores them for the popup history).
    const viewDate = CalDom.visibleWeekDate();
    viewWeekTs = CalHours.weekStart(viewDate || new Date()).getTime();
    lastRows = computeRows((domWeeks[viewWeekTs] || []).map(hydrate), new Date(viewWeekTs));

    // Skip DOM churn when nothing visible changed.
    const sig = JSON.stringify([viewWeekTs, lastRows, domEventsRead, settings.widgetCollapsed]);
    if (sig !== renderSig) {
      renderSig = sig;
      render();
    }
  };

  const refresh = () =>
    onNotion ? refreshNotion() : settings.source === 'dom' ? refreshDom() : refreshIcs();

  // Manual refresh from the widget. Same sources as the automatic path, but
  // every throttle is skipped so one click really is one fresh pull: the
  // background GCal tab is asked again, and the feed or grid is re-read now.
  // Last known numbers stay on screen while it works.
  const manualRefresh = async () => {
    if (refreshBusy) return;
    refreshBusy = true;
    refreshError = false;
    const gen = ++refreshGen;
    // Arm the failsafe at click time, not inside the promise chain: a promise
    // that never settles must not hold the button hostage, and the background
    // worker's own give-up path takes 20s, longer than we want to spin.
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (refreshGen === gen && refreshBusy) {
        refreshBusy = false;
        render();
      }
    }, 12_000);
    render();
    try {
      if (onNotion) {
        await loadDomWeeks();
        const ts = viewWeekTs ?? CalHours.weekStart(new Date()).getTime();
        // Stamp the throttle instead of deleting it: this request is itself the
        // fresh pull, so the automatic path must stay quiet for its 5 minutes
        // rather than opening a second background tab on the same week.
        weekFetches.set(ts, Date.now());
        refreshWeekTs = ts;
        const d = new Date(ts);
        await chrome.runtime.sendMessage?.({
          type: 'gtt-refresh-gcal',
          week: `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`,
        });
        return; // fresh week data lands through onChanged and clears the spinner
      }
      if (settings.source === 'dom') await refreshDom();
      else await refreshIcs();
    } catch {
      // Dead extension context, no receiving end, or a failed feed read: nothing
      // is going to land, so stop spinning instead of waiting out the failsafe.
      refreshError = true;
    }
    if (refreshGen === gen) {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      refreshBusy = false;
      render();
    }
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    // A Google Calendar tab updated the shared week data — mirror it live.
    if (area === 'local' && changes.gttDomWeeks) {
      const incoming = changes.gttDomWeeks.newValue || {};
      // Merge, never replace: another tab may hold a newer map for other weeks.
      domWeeks = { ...domWeeks, ...incoming };
      if (changes.gttDomWeeksAt) domWeeksAt = changes.gttDomWeeksAt.newValue || 0;
      // Stop the spinner only when the week we asked for actually arrived, so an
      // unrelated week's write cannot end the pending state early.
      if (refreshBusy && (refreshWeekTs === null || (incoming[refreshWeekTs] || []).length > 0)) {
        if (refreshTimer) {
          clearTimeout(refreshTimer);
          refreshTimer = null;
        }
        refreshBusy = false;
        refreshError = false;
      }
      if (onNotion) refreshNotion();
      return;
    }
    if (area !== 'sync') return;
    let needsRefresh = false;
    for (const [k, v] of Object.entries(changes)) {
      if (k in settings) settings[k] = v.newValue;
      if (k === 'icsUrls' || k === 'tracked' || k === 'source') needsRefresh = true;
    }
    needsRefresh ? refresh() : render();
  });

  // The calendar grid re-renders constantly; debounce DOM scans.
  let debounce;
  const observer = new MutationObserver(() => {
    if (onNotion || settings.source !== 'dom') return;
    clearTimeout(debounce);
    debounce = setTimeout(refreshDom, 150);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Notion is an SPA — week navigation surfaces only in the tab title.
  if (onNotion) {
    const titleEl = document.querySelector('title');
    if (titleEl) {
      let titleDebounce;
      new MutationObserver(() => {
        clearTimeout(titleDebounce);
        titleDebounce = setTimeout(refreshNotion, 250);
      }).observe(titleEl, { childList: true });
    }
  }

  refresh();
  // The grid often isn't rendered yet at document_idle — retry shortly.
  setTimeout(refresh, 1000);
  setTimeout(refresh, 3000);
  setInterval(refresh, 30 * 60 * 1000);
})();
