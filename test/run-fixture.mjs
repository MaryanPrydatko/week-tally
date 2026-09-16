// Offline smoke test for the hours engine, popup, and calendar widget.
// The sample ICS is generated relative to today, so expectations are stable:
//   - weekly recurring "Work" Mon+Wed 09:00-13:00 (8h/week)
//   - last week: Monday cancelled (EXDATE), Wednesday moved to Thursday 2h
//   - current week: one-off "Work: deep focus" Wed 14:00-16:00 (+2h)
//   - "Gym" Tue 07:00-08:00 current week (must not match "work")
//   - all-day "Work conference" (must be ignored)
// Expected "work" hours per week: [8, 8, 8, 2, 10]
// Run: node test/run-fixture.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, name) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};

// --- build sample ICS relative to today ---------------------------------
const weekStart = (d) => {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
};
const at = (base, days, hours) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hours, 0, 0, 0);
  return d;
};
const fmt = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
  `T${String(d.getHours()).padStart(2, '0')}0000`;
const fmtDate = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

const cur = weekStart(new Date());
const dtstart = at(cur, -56, 9); // recurring start: Monday 8 weeks back, 09:00
const exMon = at(cur, -7, 9); // last week's Monday: cancelled
const movedFrom = at(cur, -5, 9); // last week's Wednesday: original start
const movedToStart = at(cur, -4, 10); // moved to Thursday 10:00
const movedToEnd = at(cur, -4, 12); // ...2h instead of 4h
const oneOffStart = at(cur, 2, 14); // current week Wednesday 14:00
const oneOffEnd = at(cur, 2, 16);
const gymStart = at(cur, 1, 7);
const gymEnd = at(cur, 1, 8);
const allDay = at(cur, 3, 0);

const ics = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//gtt test//EN',
  'BEGIN:VEVENT',
  'UID:work-recurring@test',
  `DTSTART:${fmt(dtstart)}`,
  `DTEND:${fmt(at(dtstart, 0, 13))}`,
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
  `EXDATE:${fmt(exMon)}`,
  'SUMMARY:Work',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:work-recurring@test',
  `RECURRENCE-ID:${fmt(movedFrom)}`,
  `DTSTART:${fmt(movedToStart)}`,
  `DTEND:${fmt(movedToEnd)}`,
  'SUMMARY:Work',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:work-oneoff@test',
  `DTSTART:${fmt(oneOffStart)}`,
  `DTEND:${fmt(oneOffEnd)}`,
  'SUMMARY:Work: deep focus',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:gym@test',
  `DTSTART:${fmt(gymStart)}`,
  `DTEND:${fmt(gymEnd)}`,
  'SUMMARY:Gym',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:conf@test',
  `DTSTART;VALUE=DATE:${fmtDate(allDay)}`,
  `DTEND;VALUE=DATE:${fmtDate(at(allDay, 1, 0))}`,
  'SUMMARY:Work conference',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

// --- 1. hours engine ------------------------------------------------------
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('about:blank');
await page.addScriptTag({ path: path.join(root, 'vendor', 'ical.min.js') });
await page.addScriptTag({ path: path.join(root, 'lib', 'hours.js') });

const sums = await page.evaluate((icsText) => {
  const { from, to } = CalHours.range(4);
  const occ = CalHours.expandICS(icsText, from, to);
  const hours = (q) => CalHours.weeklyHours(occ, q, 4).map((r) => Math.round(r.hours * 10) / 10);
  return { work: hours('work'), gym: hours('gym'), conf: hours('conference') };
}, ics);

check(JSON.stringify(sums.work) === '[8,8,8,2,10]', `work weeks = [8,8,8,2,10] (got ${JSON.stringify(sums.work)})`);
check(JSON.stringify(sums.gym) === '[0,0,0,0,1]', `gym weeks = [0,0,0,0,1] (got ${JSON.stringify(sums.gym)})`);
check(sums.conf.every((h) => h === 0), 'all-day events ignored');

// --- 2. popup render ------------------------------------------------------
const stub = (icsText) => `
  window.chrome = {
    storage: {
      sync: {
        get: async (d) => ({ ...d, icsUrls: ['https://example.test/cal.ics'],
          tracked: [{ name: 'work', target: 30 }, { name: 'gym', target: 0.5 }] }),
        set: async () => {},
      },
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
    runtime: { getManifest: () => ({ version: '1.0.0' }) },
  };
  window.fetch = async () => ({ ok: true, text: async () => ${JSON.stringify(icsText)} });
`;

const popup = await browser.newPage();
popup.on('pageerror', (e) => errors.push(String(e)));
await popup.addInitScript(stub(ics));
await popup.goto(`file://${path.join(root, 'popup.html')}`);
await popup.waitForTimeout(400);

check((await popup.locator('.card').count()) === 2, 'popup renders a card per tracked event');
const workValue = await popup.locator('.card .value').first().innerText();
check(workValue === '10 / 30h this week · −20h', `popup work card shows progress vs target (got "${workValue}")`);
const gymValue = await popup.locator('.card .value').nth(1).innerText();
check(
  gymValue === '1 / 0.5h this week · +0.5h over',
  `popup shows overage explicitly (got "${gymValue}")`
);
const avg = await popup.locator('.card .avg').first().innerText();
check(avg === 'avg 6.5h', `popup shows past-weeks average (got "${avg}")`);
check(!(await popup.locator('#setup').isVisible()), 'setup section hidden once configured');

// --- 2b. popup guides the user when the URL 404s (public-address mistake) --
const popup404 = await browser.newPage();
await popup404.addInitScript(`
  window.chrome = {
    storage: {
      sync: {
        get: async (d) => ({ ...d,
          icsUrls: ['https://calendar.google.com/calendar/ical/x%40y/public/basic.ics'],
          tracked: [{ name: 'work', target: 0 }] }),
        set: async () => {},
      },
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
    runtime: { getManifest: () => ({ version: '1.0.0' }) },
  };
  window.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
`);
await popup404.goto(`file://${path.join(root, 'popup.html')}`);
await popup404.waitForTimeout(400);
const status404 = await popup404.locator('#status').innerText();
check(status404.includes('Secret address'), `404 shows secret-address hint (got "${status404}")`);

// --- 3. calendar widget ---------------------------------------------------
const widget = await browser.newPage();
widget.on('pageerror', (e) => errors.push(String(e)));
await widget.addInitScript(stub(ics));
await widget.goto('about:blank');
await widget.addStyleTag({ path: path.join(root, 'content.css') });
await widget.addScriptTag({ path: path.join(root, 'vendor', 'ical.min.js') });
await widget.addScriptTag({ path: path.join(root, 'lib', 'hours.js') });
await widget.addScriptTag({ path: path.join(root, 'content.js') });
await widget.waitForTimeout(400);

check((await widget.locator('#gtt-widget .gtt-row').count()) === 2, 'widget renders a row per tracked event');
const widgetWork = await widget.locator('.gtt-value').first().innerText();
check(widgetWork === '10 / 30h · −20h', `widget shows work progress (got "${widgetWork}")`);
await widget.locator('.gtt-collapse').click();
check((await widget.locator('.gtt-pill').count()) === 1, 'widget collapses to pill');
await widget.locator('.gtt-pill').click();
check((await widget.locator('.gtt-card').count()) === 1, 'pill expands back to card');

// --- 3b. manual refresh button in the bottom corner -----------------------
check(
  (await widget.locator('#gtt-widget .gtt-foot .gtt-refresh').count()) === 1,
  'widget has a refresh button in the footer'
);
check(
  (await widget.locator('.gtt-refresh .gtt-icon').innerText()) === '↻',
  'refresh button renders the ↻ glyph'
);
check(
  (await widget.locator('.gtt-refresh').getAttribute('title')) === 'Refresh now',
  'refresh button carries a tooltip'
);
// A second feed payload with a different total, so a refresh that fetches and
// discards its result cannot pass: the current week goes from 10h to 12h.
const icsV2 = ics.replace(`DTEND:${fmt(oneOffEnd)}`, `DTEND:${fmt(at(cur, 2, 18))}`);
await widget.evaluate(
  (payload) => {
    window.__origFetch = window.fetch;
    window.__restoreFetch = () => {
      window.fetch = window.__origFetch;
    };
    window.__fetches = 0;
    // The wrapper is installed after the initial page load, so every call that
    // goes through it is the manual refresh and gets the new payload.
    window.fetch = async () => {
      window.__fetches += 1;
      return { ok: true, text: async () => payload.second };
    };
  },
  { first: ics, second: icsV2 }
);
const fetchesBefore = await widget.evaluate(() => window.__fetches);
await widget.locator('.gtt-refresh').click();
await widget.waitForFunction(() => !document.querySelector('.gtt-refresh').disabled);
const fetchesAfter = await widget.evaluate(() => window.__fetches);
check(
  fetchesAfter - fetchesBefore === 1,
  `one click re-fetches the feed exactly once (got ${fetchesAfter - fetchesBefore})`
);
check(
  (await widget.locator('.gtt-value').first().innerText()) === '12 / 30h · −18h',
  `the refreshed feed result is applied (got "${await widget.locator('.gtt-value').first().innerText()}")`
);
await widget.evaluate(() => window.__restoreFetch());
check(
  (await widget.locator('.gtt-foot .gtt-note').count()) === 0,
  'feed mode keeps the footer to the button alone'
);

// --- 4. page-reading (DOM) mode -------------------------------------------
const datekey = (d) =>
  ((d.getFullYear() - 1970) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
const mon = cur; // this week's Monday
const tue = at(cur, 1, 0);

const gridHtml = `
  <div role="grid">
    <div data-datekey="${datekey(mon)}">
      <div data-eventid="e1" role="button">
        <div>work</div><div>10:00 – 13:30</div>
        <div class="XuJrye">10:00 to 13:30, work, Maryan Prydatko</div>
      </div>
      <div data-eventid="e4" role="button">
        <div>Office</div>
        <div class="XuJrye">Office, All day</div>
      </div>
    </div>
    <div data-datekey="${datekey(tue)}">
      <div data-eventid="e2" role="button">
        <div>work</div><div>15:00 – 18:15</div>
        <div class="XuJrye">15:00 to 18:15, work, Maryan Prydatko</div>
      </div>
      <div data-eventid="e3" role="button">
        <div>Gym</div><div>7:00 – 8:00</div>
        <div class="XuJrye">7:00 to 8:00, Gym, Maryan Prydatko</div>
      </div>
    </div>
  </div>`;

const dom = await browser.newPage();
dom.on('pageerror', (e) => errors.push(String(e)));
await dom.addInitScript(`
  const localStore = {};
  window.chrome = {
    storage: {
      sync: {
        get: async (d) => ({ ...d, source: 'dom',
          tracked: [{ name: 'work', target: 20 }] }),
        set: async () => {},
      },
      local: {
        get: async (k) => (typeof k === 'string' ? { [k]: localStore[k] } : { ...k, ...localStore }),
        set: async (o) => Object.assign(localStore, o),
      },
      onChanged: { addListener: () => {} },
    },
    runtime: { getManifest: () => ({ version: '1.0.0' }) },
  };
`);
await dom.goto('about:blank');
await dom.setContent(`<body>${gridHtml}</body>`);
await dom.addStyleTag({ path: path.join(root, 'content.css') });
await dom.addScriptTag({ path: path.join(root, 'vendor', 'ical.min.js') });
await dom.addScriptTag({ path: path.join(root, 'lib', 'hours.js') });
await dom.addScriptTag({ path: path.join(root, 'dom-reader.js') });

const parse = await dom.evaluate(() => ({
  h24: CalDom.parseRange('10:00 – 13:30'),
  h12: CalDom.parseRange('11:30am – 1pm'),
  inherit: CalDom.parseRange('10 – 11am'),
  flip: CalDom.parseRange('11 – 1pm'),
  bad: CalDom.parseRange('All day'),
}));
check(parse.h24 && parse.h24.endMin - parse.h24.startMin === 210, '24h range parses (3.5h)');
check(parse.h12 && parse.h12.endMin - parse.h12.startMin === 90, '12h range parses (1.5h)');
check(parse.inherit && parse.inherit.endMin - parse.inherit.startMin === 60, 'am/pm inherited from end token');
check(parse.flip && parse.flip.endMin - parse.flip.startMin === 120, '"11 – 1pm" flips start to am');
check(parse.bad === null, 'all-day text rejected');

const scanned = await dom.evaluate(() => CalDom.scan().map((o) => ({
  summary: o.summary,
  hours: (o.end - o.start) / 3.6e6,
  day: o.start.getDay(),
})));
check(scanned.length === 3, `scan finds 3 timed events (got ${scanned.length})`);
check(
  scanned.filter((o) => o.summary === 'work').reduce((s, o) => s + o.hours, 0) === 6.75,
  'scanned work hours = 6.75'
);

await dom.addScriptTag({ path: path.join(root, 'content.js') });
await dom.waitForTimeout(400);
const domWidgetWork = await dom.locator('.gtt-value').first().innerText();
check(domWidgetWork === '6.8 / 20h · −13.3h', `dom-mode widget shows work progress (got "${domWidgetWork}")`);
const domNote = await dom.locator('.gtt-note').innerText();
check(/page mode · 3 events read/.test(domNote), `dom-mode widget shows read counter (got "${domNote}")`);

// --- 4a. refresh button works in page-reading mode too --------------------
check(
  (await dom.locator('#gtt-widget .gtt-foot .gtt-refresh').count()) === 1,
  'page-mode widget has the refresh button'
);
await dom.evaluate(() => {
  const original = CalDom.scan;
  window.__scans = 0;
  CalDom.scan = (...args) => {
    window.__scans += 1;
    return original(...args);
  };
});
const domBusy = await dom.evaluate(() => {
  const before = window.__scans;
  document.querySelector('.gtt-refresh').click();
  const btn = document.querySelector('.gtt-refresh');
  const note = document.querySelector('.gtt-foot .gtt-note');
  return { before, disabled: btn.disabled, note: note ? note.textContent : '' };
});
check(domBusy.disabled, 'page-mode button goes busy on click');
check(/rescanning the grid/.test(domBusy.note), `page-mode busy note shows (got "${domBusy.note}")`);
await dom.waitForFunction(() => !document.querySelector('.gtt-refresh').disabled);
const domDelta = await dom.evaluate((before) => window.__scans - before, domBusy.before);
check(domDelta === 1, `one click rescans the grid exactly once (got ${domDelta})`);
check(
  /^page mode · 3 events read in view$/.test(await dom.locator('.gtt-foot .gtt-note').innerText()),
  'page-mode note returns to the read counter'
);
check(
  domWidgetWork === (await dom.locator('.gtt-value').first().innerText()),
  'page-mode numbers survive a manual refresh'
);

// --- 4b. widget follows the viewed week (going back a week) ----------------
const prevMon = at(cur, -7, 0);
const prevTue = at(cur, -6, 0);
const prevGrid = `
  <div role="grid">
    <div data-datekey="${datekey(prevMon)}">
      <div data-eventid="p1" role="button">
        <div>work</div><div>9:00 – 17:00</div>
        <div class="XuJrye">9:00 to 17:00, work, Maryan Prydatko</div>
      </div>
    </div>
    <div data-datekey="${datekey(prevTue)}"></div>
  </div>`;

const prev = await browser.newPage();
prev.on('pageerror', (e) => errors.push(String(e)));
await prev.addInitScript(`
  const localStore = {};
  window.chrome = {
    storage: {
      sync: {
        get: async (d) => ({ ...d, source: 'dom', tracked: [{ name: 'work', target: 5 }] }),
        set: async () => {},
      },
      local: {
        get: async (k) => (typeof k === 'string' ? { [k]: localStore[k] } : { ...k, ...localStore }),
        set: async (o) => Object.assign(localStore, o),
      },
      onChanged: { addListener: () => {} },
    },
    runtime: { getManifest: () => ({ version: '1.0.0' }) },
  };
`);
await prev.goto('about:blank');
await prev.setContent(`<body>${prevGrid}</body>`);
await prev.addStyleTag({ path: path.join(root, 'content.css') });
await prev.addScriptTag({ path: path.join(root, 'vendor', 'ical.min.js') });
await prev.addScriptTag({ path: path.join(root, 'lib', 'hours.js') });
await prev.addScriptTag({ path: path.join(root, 'dom-reader.js') });
await prev.addScriptTag({ path: path.join(root, 'content.js') });
await prev.waitForTimeout(400);
const prevTitle = await prev.locator('.gtt-head strong').innerText();
check(/^Week of /.test(prevTitle), `widget titled by viewed week (got "${prevTitle}")`);
const prevValue = await prev.locator('.gtt-value').first().innerText();
check(
  prevValue === '8 / 5h · +3h',
  `widget shows viewed week's hours with overage (got "${prevValue}")`
);

// --- 4c. fresh install defaults to page-reading mode -----------------------
const fresh = await browser.newPage();
fresh.on('pageerror', (e) => errors.push(String(e)));
await fresh.addInitScript(`
  window.chrome = {
    storage: {
      sync: { get: async (d) => ({ ...d }), set: async () => {} },
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
    runtime: { getManifest: () => ({ version: '1.0.0' }) },
  };
`);
await fresh.goto(`file://${path.join(root, 'popup.html')}`);
await fresh.waitForTimeout(300);
check(!(await fresh.locator('#setup').isVisible()), 'fresh install skips URL setup (page mode default)');
check(await fresh.locator('#domSection').isVisible(), 'fresh install shows page-mode source section');

// --- 5. popup in page-reading mode -----------------------------------------
const popupDom = await browser.newPage();
popupDom.on('pageerror', (e) => errors.push(String(e)));
const seedWeeks = {};
seedWeeks[+cur] = [
  { s: +at(cur, 0, 10), e: +at(cur, 0, 13.5 * 1), m: 'work' },
];
await popupDom.addInitScript(`
  const localStore = { gttDomWeeks: ${JSON.stringify({
    [+cur]: [{ s: +at(cur, 0, 10), e: +at(cur, 0, 14), m: 'work' }],
    [+at(cur, -7, 0)]: [{ s: +at(cur, -7, 9), e: +at(cur, -7, 17), m: 'work' }],
  })} };
  window.chrome = {
    storage: {
      sync: {
        get: async (d) => ({ ...d, source: 'dom', tracked: [{ name: 'work', target: 20 }] }),
        set: async () => {},
      },
      local: {
        get: async (k) => (typeof k === 'string' ? { [k]: localStore[k] } : { ...k, ...localStore }),
        set: async (o) => Object.assign(localStore, o),
      },
      onChanged: { addListener: () => {} },
    },
    runtime: { getManifest: () => ({ version: '1.0.0' }) },
  };
`);
await popupDom.goto(`file://${path.join(root, 'popup.html')}`);
await popupDom.waitForTimeout(400);
check((await popupDom.locator('.card').count()) === 1, 'dom-mode popup renders tracked card');
const popupDomValue = await popupDom.locator('.card .value').first().innerText();
check(popupDomValue === '4 / 20h this week · −16h', `dom-mode popup current week from store (got "${popupDomValue}")`);
check(!(await popupDom.locator('#calendarsSection').isVisible()), 'calendars section hidden in dom mode');
check(await popupDom.locator('#domSection').isVisible(), 'source section visible in dom mode');
check(await popupDom.locator('#refreshGcal').isVisible(), 'refresh-from-Google button available in dom mode');

// --- 6. widget on Notion Calendar (renders from shared GCal data) ----------
const monNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const notionTitle = (d1, d2) => {
  if (d1.getFullYear() !== d2.getFullYear())
    return `${d1.getDate()} ${monNames[d1.getMonth()]} ${d1.getFullYear()} – ${d2.getDate()} ${monNames[d2.getMonth()]} ${d2.getFullYear()} · Notion Calendar`;
  if (d1.getMonth() !== d2.getMonth())
    return `${d1.getDate()} ${monNames[d1.getMonth()]} – ${d2.getDate()} ${monNames[d2.getMonth()]} ${d1.getFullYear()} · Notion Calendar`;
  return `${d1.getDate()} – ${d2.getDate()} ${monNames[d1.getMonth()]} ${d1.getFullYear()} · Notion Calendar`;
};
const notion = await browser.newPage();
notion.on('pageerror', (e) => errors.push(String(e)));
await notion.route('**/*', (r) => r.fulfill({ contentType: 'text/html', body: '<body></body>' }));
await notion.addInitScript(`
  const localStore = {
    gttDomWeeks: ${JSON.stringify({ [+cur]: [{ s: +at(cur, 0, 10), e: +at(cur, 0, 14), m: 'work' }] })},
    gttDomWeeksAt: 1,
  };
  window.chrome = {
    storage: {
      sync: {
        get: async (d) => ({ ...d, source: 'dom', tracked: [{ name: 'work', target: 20 }] }),
        set: async () => {},
      },
      local: {
        get: async (k) => {
          if (typeof k === 'string') return { [k]: localStore[k] };
          if (Array.isArray(k)) return Object.fromEntries(k.map((key) => [key, localStore[key]]));
          return { ...k, ...localStore };
        },
        set: async (o) => Object.assign(localStore, o),
      },
      onChanged: { addListener: (fn) => { window.__onChanged = fn; } },
    },
    runtime: {
      getManifest: () => ({ version: '1.0.0' }),
      sendMessage: (msg) => {
        window.__sent = window.__sent || [];
        window.__sent.push(msg);
        return Promise.resolve({ ok: true });
      },
    },
  };
`);
await notion.goto('https://calendar.notion.so/');
await notion.addStyleTag({ path: path.join(root, 'content.css') });
await notion.addScriptTag({ path: path.join(root, 'vendor', 'ical.min.js') });
await notion.addScriptTag({ path: path.join(root, 'lib', 'hours.js') });
await notion.addScriptTag({ path: path.join(root, 'dom-reader.js') });
await notion.addScriptTag({ path: path.join(root, 'content.js') });
await notion.waitForTimeout(400);
const notionValue = await notion.locator('.gtt-value').first().innerText();
check(notionValue === '4 / 20h · −16h', `notion widget shows GCal-fed hours (got "${notionValue}")`);
const notionNote = await notion.locator('.gtt-note').innerText();
check(/from Google Calendar/.test(notionNote), `notion widget labels its data source (got "${notionNote}")`);

// --- 6a. the Notion refresh button asks for a fresh Google scan -----------
check(
  (await notion.locator('#gtt-widget .gtt-foot .gtt-refresh').count()) === 1,
  'notion widget has the refresh button'
);
const sentBefore = await notion.evaluate(() => (window.__sent || []).length);
await notion.locator('.gtt-refresh').click();
await notion.waitForTimeout(200);
const asked = (await notion.evaluate(() => window.__sent || [])) || [];
const manual = asked.slice(sentBefore);
check(
  manual.length === 1 && manual[0].type === 'gtt-refresh-gcal',
  `one click sends exactly one refresh request (got ${JSON.stringify(manual)})`
);
check(
  /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(manual[0]?.week || ''),
  `week string matches the background worker's contract (got "${manual[0]?.week}")`
);
const roundTrip = await notion.evaluate((week) => {
  const [y, m, d] = week.split('/').map(Number);
  return CalHours.weekStart(new Date(y, m - 1, d)).getTime();
}, manual[0]?.week || '');
check(roundTrip === +cur, `the requested week parses back to the viewed Monday (got ${new Date(roundTrip).toDateString()})`);
check(
  /refreshing/.test(await notion.locator('.gtt-foot .gtt-note').innerText()),
  'notion note shows the refreshing state'
);
check(await notion.locator('.gtt-refresh').isDisabled(), 'refresh button is disabled while refreshing');
check(
  /gtt-busy/.test(await notion.locator('.gtt-refresh').getAttribute('class')),
  'refresh button gets the busy class for the spinner'
);
check(
  (await notion.locator('.gtt-refresh').getAttribute('aria-label')) === 'Refreshing…',
  'busy state is announced, not just drawn'
);

// Fresh data landing clears the spinner and restores the source line.
await notion.evaluate((ts) => {
  window.__onChanged(
    {
      gttDomWeeks: { newValue: { [ts]: [{ s: ts + 36e5, e: ts + 72e5, m: 'work' }] } },
      gttDomWeeksAt: { newValue: Date.now() },
    },
    'local'
  );
}, +cur);
await notion.waitForTimeout(250);
check(!(await notion.locator('.gtt-refresh').isDisabled()), 'refresh button re-enables once fresh data lands');
const noteAfter = await notion.locator('.gtt-foot .gtt-note').innerText();
check(
  /^from Google Calendar · /.test(noteAfter) && !/refreshing/.test(noteAfter),
  `note returns to the source line after the refresh lands (got "${noteAfter}")`
);

// Data for a DIFFERENT week must not end the pending state early.
await notion.locator('.gtt-refresh').click();
await notion.waitForTimeout(150);
await notion.evaluate((ts) => {
  window.__onChanged(
    {
      gttDomWeeks: { newValue: { [ts]: [{ s: ts + 36e5, e: ts + 72e5, m: 'work' }] } },
      gttDomWeeksAt: { newValue: Date.now() },
    },
    'local'
  );
}, +at(cur, 7, 0));
await notion.waitForTimeout(150);
check(
  await notion.locator('.gtt-refresh').isDisabled(),
  'another week landing does not clear the pending spinner'
);
await notion.evaluate((ts) => {
  window.__onChanged(
    {
      gttDomWeeks: { newValue: { [ts]: [{ s: ts + 36e5, e: ts + 108e5, m: 'work' }] } },
      gttDomWeeksAt: { newValue: Date.now() },
    },
    'local'
  );
}, +cur);
await notion.waitForTimeout(200);
check(!(await notion.locator('.gtt-refresh').isDisabled()), 'the viewed week landing does clear it');
// --- 6c. the button asks for the week being viewed, not today -------------
const otherWeek = at(cur, -14, 0);
const otherWeekSun = at(cur, -8, 0);
const other = await browser.newPage();
other.on('pageerror', (e) => errors.push(String(e)));
await other.route('**/*', (r) =>
  r.fulfill({
    contentType: 'text/html',
    body: `<head><title>${notionTitle(otherWeek, otherWeekSun)}</title></head><body></body>`,
  })
);
await other.addInitScript(`
  const localStore = {
    gttDomWeeks: ${JSON.stringify({ [+otherWeek]: [{ s: +at(cur, -14, 9), e: +at(cur, -14, 17), m: 'work' }] })},
    gttDomWeeksAt: Date.now(),
  };
  window.chrome = {
    storage: {
      sync: {
        get: async (d) => ({ ...d, source: 'dom', tracked: [{ name: 'work', target: 20 }] }),
        set: async () => {},
      },
      local: {
        get: async (k) => {
          if (typeof k === 'string') return { [k]: localStore[k] };
          if (Array.isArray(k)) return Object.fromEntries(k.map((key) => [key, localStore[key]]));
          return { ...k, ...localStore };
        },
        set: async (o) => Object.assign(localStore, o),
      },
      onChanged: { addListener: () => {} },
    },
    runtime: {
      getManifest: () => ({ version: '1.0.0' }),
      sendMessage: (msg) => {
        window.__sent = window.__sent || [];
        window.__sent.push(msg);
        return Promise.resolve({ ok: true });
      },
    },
  };
`);
await other.goto('https://calendar.notion.so/');
for (const f of ['vendor/ical.min.js', 'lib/hours.js', 'dom-reader.js', 'content.js']) {
  await other.addScriptTag({ path: path.join(root, f) });
}
await other.addStyleTag({ path: path.join(root, 'content.css') });
await other.waitForTimeout(400);
check(
  /^Week of /.test(await other.locator('.gtt-head strong').innerText()),
  'notion widget is showing a week that is not the current one (setup for the check below)'
);
await other.locator('.gtt-refresh').click();
await other.waitForTimeout(200);
const otherSent = (await other.evaluate(() => window.__sent || [])) || [];
const wantOther = `${otherWeek.getFullYear()}/${otherWeek.getMonth() + 1}/${otherWeek.getDate()}`;
check(
  otherSent.at(-1)?.week === wantOther,
  `click asks for the viewed week, not today (want ${wantOther}, got ${JSON.stringify(otherSent)})`
);

// --- 6d. a dead extension context must not latch the button ---------------
const broken = await browser.newPage();
broken.on('pageerror', (e) => errors.push(String(e)));
await broken.route('**/*', (r) => r.fulfill({ contentType: 'text/html', body: '<body></body>' }));
await broken.addInitScript(`
  window.chrome = {
    storage: {
      sync: {
        get: async (d) => ({ ...d, source: 'dom', tracked: [{ name: 'work', target: 20 }] }),
        set: async () => {},
      },
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
    runtime: {
      getManifest: () => ({ version: '1.0.0' }),
      sendMessage: () => {
        throw new Error('Extension context invalidated.');
      },
    },
  };
`);
await broken.goto('https://calendar.notion.so/');
for (const f of ['vendor/ical.min.js', 'lib/hours.js', 'dom-reader.js', 'content.js']) {
  await broken.addScriptTag({ path: path.join(root, f) });
}
await broken.addStyleTag({ path: path.join(root, 'content.css') });
await broken.waitForTimeout(300);
await broken.locator('.gtt-refresh').click();
await broken.waitForTimeout(300);
check(
  !(await broken.locator('.gtt-refresh').isDisabled()),
  'a sendMessage that throws does not leave the button disabled'
);
check(
  /couldn't reach Google Calendar/.test(await broken.locator('.gtt-foot .gtt-note').innerText()),
  `a failed refresh is reported instead of spinning (got "${await broken.locator('.gtt-foot .gtt-note').innerText()}")`
);

// --- 6e. the failsafe clears the spinner when nothing ever lands ----------
const failsafePage = await browser.newPage();
failsafePage.on('pageerror', (e) => errors.push(String(e)));
await failsafePage.clock.install();
await failsafePage.route('**/*', (r) => r.fulfill({ contentType: 'text/html', body: '<body></body>' }));
await failsafePage.addInitScript(`
  const localStore = {
    gttDomWeeks: ${JSON.stringify({ [+cur]: [{ s: +at(cur, 0, 10), e: +at(cur, 0, 14), m: 'work' }] })},
    gttDomWeeksAt: Date.now(),
  };
  window.chrome = {
    storage: {
      sync: {
        get: async (d) => ({ ...d, source: 'dom', tracked: [{ name: 'work', target: 20 }] }),
        set: async () => {},
      },
      local: {
        get: async (k) => {
          if (typeof k === 'string') return { [k]: localStore[k] };
          if (Array.isArray(k)) return Object.fromEntries(k.map((key) => [key, localStore[key]]));
          return { ...k, ...localStore };
        },
        set: async (o) => Object.assign(localStore, o),
      },
      onChanged: { addListener: () => {} },
    },
    runtime: {
      getManifest: () => ({ version: '1.0.0' }),
      sendMessage: () => Promise.resolve({ ok: true }),
    },
  };
`);
await failsafePage.goto('https://calendar.notion.so/');
for (const f of ['vendor/ical.min.js', 'lib/hours.js', 'dom-reader.js', 'content.js']) {
  await failsafePage.addScriptTag({ path: path.join(root, f) });
}
await failsafePage.addStyleTag({ path: path.join(root, 'content.css') });
await failsafePage.waitForTimeout(200);
await failsafePage.locator('.gtt-refresh').click();
await failsafePage.waitForTimeout(150);
check(await failsafePage.locator('.gtt-refresh').isDisabled(), 'failsafe case starts busy');
await failsafePage.clock.runFor(13000);
check(
  !(await failsafePage.locator('.gtt-refresh').isDisabled()),
  'the 12s failsafe clears the spinner when no data ever lands'
);

// Title parsing (pure function, fixed inputs)
const nv = await notion.evaluate(() => ({
  sameMonth: +CalDom.notionViewDate('8 – 14 Jun 2026 · Notion Calendar'),
  crossMonth: +CalDom.notionViewDate('29 Jun – 5 Jul 2026 · Notion Calendar'),
  crossYear: +CalDom.notionViewDate('29 Dec 2025 – 4 Jan 2026 · Notion Calendar'),
  monthView: CalDom.notionViewDate('June 2026 · Notion Calendar'),
}));
check(nv.sameMonth === +new Date(2026, 5, 8), 'notion title "8 – 14 Jun 2026" parsed');
check(nv.crossMonth === +new Date(2026, 5, 29), 'notion title "29 Jun – 5 Jul 2026" parsed');
check(nv.crossYear === +new Date(2025, 11, 29), 'notion title "29 Dec 2025 – 4 Jan 2026" parsed');
check(nv.monthView === null, 'notion month-view title returns null');

// --- 6b. Notion follows the viewed week from the tab title -----------------
const prevWeekMon = at(cur, -7, 0);
const prevWeekSun = at(cur, -1, 0);

const notionPrev = await browser.newPage();
notionPrev.on('pageerror', (e) => errors.push(String(e)));
await notionPrev.route('**/*', (r) =>
  r.fulfill({
    contentType: 'text/html',
    body: `<head><title>${notionTitle(prevWeekMon, prevWeekSun)}</title></head><body></body>`,
  })
);
await notionPrev.addInitScript(`
  const localStore = {
    gttDomWeeks: ${JSON.stringify({ [+prevWeekMon]: [{ s: +at(cur, -7, 9), e: +at(cur, -7, 17), m: 'work' }] })},
    gttDomWeeksAt: 1,
  };
  window.chrome = {
    storage: {
      sync: {
        get: async (d) => ({ ...d, source: 'dom', tracked: [{ name: 'work', target: 20 }] }),
        set: async () => {},
      },
      local: {
        get: async (k) => {
          if (typeof k === 'string') return { [k]: localStore[k] };
          if (Array.isArray(k)) return Object.fromEntries(k.map((key) => [key, localStore[key]]));
          return { ...k, ...localStore };
        },
        set: async (o) => Object.assign(localStore, o),
      },
      onChanged: { addListener: () => {} },
    },
    runtime: { getManifest: () => ({ version: '1.0.0' }) },
  };
`);
await notionPrev.goto('https://calendar.notion.so/');
await notionPrev.addStyleTag({ path: path.join(root, 'content.css') });
await notionPrev.addScriptTag({ path: path.join(root, 'vendor', 'ical.min.js') });
await notionPrev.addScriptTag({ path: path.join(root, 'lib', 'hours.js') });
await notionPrev.addScriptTag({ path: path.join(root, 'dom-reader.js') });
await notionPrev.addScriptTag({ path: path.join(root, 'content.js') });
await notionPrev.waitForTimeout(400);
const notionPrevTitle = await notionPrev.locator('.gtt-head strong').innerText();
check(/^Week of /.test(notionPrevTitle), `notion follows viewed week from title (got "${notionPrevTitle}")`);
const notionPrevValue = await notionPrev.locator('.gtt-value').first().innerText();
check(notionPrevValue === '8 / 20h · −12h', `notion shows viewed week's hours (got "${notionPrevValue}")`);

check(errors.length === 0, `no page errors${errors.length ? ` (${errors[0]})` : ''}`);

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
