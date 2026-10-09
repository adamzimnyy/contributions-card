/**
 * Contributions Card for Home Assistant
 *
 * A GitHub-style contribution grid: one square per day, filled when the
 * configured sensor counted something that day. Data comes from the
 * long-term statistics of a counter sensor (state_class: total or
 * total_increasing), so it is not limited by recorder history retention.
 *
 * https://github.com/adamzimnyy/contributions-card
 */

const VERSION = "0.1.1";
const MIN_MONTHS = 1;
const MAX_MONTHS = 3;
const DEFAULT_MONTHS = 2;
const LAYOUTS = ["horizontal", "vertical"];
const REFETCH_MS = 60 * 60 * 1000; // safety refresh, normally driven by state changes
const TICK_MS = 5 * 60 * 1000; // re-render check for day rollover

// Translations from translations/*.properties, bundled in by scripts/build.mjs.
// Do not edit strings here: edit the .properties files and run `npm run build`.
const TRANSLATIONS = /* @translations */ {};
const FALLBACK_LANGUAGE = "en";

const WEEKDAY_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Config values that go into a CSS declaration: keep them from closing the declaration or the style block.
const cssValue = (value) => String(value).replace(/[;{}<>]/g, "");

const pad2 = (n) => String(n).padStart(2, "0");
const keyOf = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`; // m is 0-based

function languageOf(hass) {
  return (hass && (hass.locale?.language || hass.language)) || "en";
}

/** The bundled language closest to the user's: "pt-BR" -> "pt-BR", then "pt", then English. */
function translationLanguage(hass) {
  const lang = languageOf(hass);
  const candidates = [lang, lang.toLowerCase(), lang.split("-")[0].toLowerCase()];
  return candidates.find((c) => TRANSLATIONS[c]) || FALLBACK_LANGUAGE;
}

/**
 * Returns t(key, params). Plural keys are looked up as key.<form> using the
 * language's plural rules when params.count is given; {name} placeholders are
 * filled from params. Missing keys fall back to English, then to the key itself.
 */
function translator(hass) {
  const lang = translationLanguage(hass);
  const table = TRANSLATIONS[lang] || {};
  const fallback = TRANSLATIONS[FALLBACK_LANGUAGE] || {};
  let plural;
  try {
    plural = new Intl.PluralRules(lang);
  } catch (e) {
    plural = new Intl.PluralRules(FALLBACK_LANGUAGE);
  }
  return (key, params = {}) => {
    const keys = [];
    if (typeof params.count === "number") keys.push(`${key}.${plural.select(params.count)}`, `${key}.other`);
    keys.push(key);
    let text;
    for (const source of [table, fallback]) {
      text = keys.map((k) => source[k]).find((v) => v !== undefined);
      if (text !== undefined) break;
    }
    if (text === undefined) return key;
    return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

/** First day of the week, 0 = Sunday ... 6 = Saturday, following the user's HA profile. */
function firstWeekday(hass) {
  const setting = hass?.locale?.first_weekday;
  if (setting && setting in WEEKDAY_INDEX) return WEEKDAY_INDEX[setting];
  try {
    const locale = new Intl.Locale(languageOf(hass));
    const info = typeof locale.getWeekInfo === "function" ? locale.getWeekInfo() : locale.weekInfo;
    if (info && info.firstDay) return info.firstDay % 7; // Intl uses 1 = Monday ... 7 = Sunday
  } catch (e) {
    /* fall through */
  }
  return 1;
}

/**
 * Daily statistics are bucketed in the Home Assistant server's time zone, so
 * days are always resolved there, whatever the browser's time zone is.
 */
function timeZoneOf(hass) {
  return hass?.config?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

class ContributionsCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("contributions-card-editor");
  }

  static getStubConfig(hass) {
    const counter = Object.values(hass?.states || {}).find(
      (s) =>
        s.entity_id.startsWith("sensor.") && ["total", "total_increasing"].includes(s.attributes?.state_class),
    );
    return { entity: counter ? counter.entity_id : "", months: DEFAULT_MONTHS };
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("Set 'entity' to a counter sensor (state_class: total or total_increasing).");
    }
    const months = config.months === undefined ? DEFAULT_MONTHS : Number(config.months);
    if (!Number.isInteger(months) || months < MIN_MONTHS || months > MAX_MONTHS) {
      throw new Error(`'months' must be a whole number from ${MIN_MONTHS} to ${MAX_MONTHS}.`);
    }
    const layout = config.layout || "horizontal";
    if (!LAYOUTS.includes(layout)) {
      throw new Error(`'layout' must be one of: ${LAYOUTS.join(", ")}.`);
    }
    const changedSource =
      !this._config ||
      this._config.entity !== config.entity ||
      this._config.months !== months;

    this._config = { ...config, months, layout };
    if (changedSource) {
      this._counts = null;
      this._error = null;
      this._lastFetch = 0;
    }
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (changedSource && this._hass) this._fetch();
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._config) return;

    const watch = [this._config.entity, this._config.last_activity_entity].filter(Boolean);
    const signature = watch.map((id) => (hass.states[id] ? hass.states[id].state : "-")).join("|");
    const changed = signature !== this._signature;
    this._signature = signature;

    if (first || changed || Date.now() - this._lastFetch > REFETCH_MS) this._fetch();
  }

  connectedCallback() {
    this._tick = setInterval(() => {
      // Repaint after midnight so "today" moves on even without new data.
      if (this._hass && this._todayKey() !== this._renderedToday) this._render();
    }, TICK_MS);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
  }

  getCardSize() {
    return this._config && this._config.layout === "vertical" ? 3 + 3 * this._config.months : 5;
  }

  getGridOptions() {
    return { columns: 12, rows: "auto", min_columns: 6 };
  }

  _todayParts() {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZoneOf(this._hass),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const [y, m, d] = fmt.format(new Date()).split("-").map(Number);
    return { y, m: m - 1, d };
  }

  _todayKey() {
    const t = this._todayParts();
    return keyOf(t.y, t.m, t.d);
  }

  _dayKeyOfTimestamp(ts) {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZoneOf(this._hass),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(new Date(ts));
  }

  async _fetch() {
    if (!this._hass || !this._config) return;
    const { entity, months } = this._config;
    this._lastFetch = Date.now();

    if (!this._hass.states[entity]) {
      this._error = translator(this._hass)("error.entity_missing", { entity });
      this._render();
      return;
    }

    const t = this._todayParts();
    // Two spare days on each side cover any time-zone offset; rows are keyed by day anyway.
    const start = Date.UTC(t.y, t.m - (months - 1), 1) - 2 * 864e5;
    const end = Date.now() + 2 * 864e5;
    const requestId = (this._requestId = (this._requestId || 0) + 1);

    try {
      const result = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: new Date(start).toISOString(),
        end_time: new Date(end).toISOString(),
        statistic_ids: [entity],
        period: "day",
        types: ["change"],
      });
      if (requestId !== this._requestId) return; // a newer request is in flight

      const rows = (result && result[entity]) || [];
      const stateClass = this._hass.states[entity]?.attributes?.state_class;
      if (!rows.length && !["total", "total_increasing"].includes(stateClass)) {
        this._counts = null;
        this._error = translator(this._hass)("error.no_statistics", { entity });
      } else {
        const counts = {};
        for (const row of rows) {
          const change = Number(row.change);
          if (!(change > 0)) continue;
          const key = this._dayKeyOfTimestamp(typeof row.start === "number" ? row.start : Date.parse(row.start));
          counts[key] = (counts[key] || 0) + Math.round(change);
        }
        this._counts = counts;
        this._error = null;
      }
    } catch (err) {
      if (requestId !== this._requestId) return;
      this._error = translator(this._hass)("error.fetch", { message: err?.message || err?.code || String(err) });
    }
    this._render();
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const cfg = this._config;
    const hass = this._hass;
    const t = translator(hass);
    const lang = languageOf(hass);
    const stateObj = hass?.states?.[cfg.entity];
    const title = cfg.title !== undefined ? cfg.title : stateObj?.attributes?.friendly_name || cfg.entity;

    let body;
    let summary = "";
    if (this._error) {
      body = `<div class="msg">${escapeHtml(this._error)}</div>`;
    } else if (!hass || this._counts === null) {
      body = `<div class="msg">${escapeHtml(t("loading"))}</div>`;
    } else {
      const built = this._buildMonths(t, lang);
      body = built.html;
      summary = t("this_month", { count: built.currentMonthDays });
    }

    const today = hass ? this._todayParts() : null;
    this._renderedToday = today ? keyOf(today.y, today.m, today.d) : null;

    const cellSize = cfg.cell_size === undefined ? null : typeof cfg.cell_size === "number" ? `${cfg.cell_size}px` : cssValue(cfg.cell_size);
    const color = cfg.color ? cssValue(cfg.color) : null;
    const hostVars = [
      color ? `--contributions-active-color: ${color};` : "",
      cellSize ? `--contributions-cell-max: ${cellSize};` : "",
    ].join(" ");

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          ${hostVars}
          --cc-active: var(--contributions-active-color, var(--success-color, #43a047));
          --cc-gap: 4px;
          --cc-cell-min: 16px; /* smallest day square, even when cell_size computes smaller */
        }
        ha-card { padding: 16px; }
        .head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
        .title { font-size: 1.15em; font-weight: 600; color: var(--primary-text-color); min-width: 0;
                 white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sub { font-size: 0.85em; color: var(--secondary-text-color); white-space: nowrap; }
        .months { display: grid; grid-template-columns: repeat(auto-fit, minmax(126px, 1fr)); gap: 16px 18px; }
        .month { width: 100%; max-width: 240px; }
        .months.vertical { grid-template-columns: minmax(0, 1fr); gap: 18px; --cc-gap: 5px; }
        .months.vertical .month { max-width: none; margin: 0 auto; }
        /* max() keeps a cell_size formula that drops to 0 or below (a short window) from collapsing the grid. */
        .months.sized .month {
          max-width: calc(7 * max(var(--cc-cell-min), var(--contributions-cell-max)) + 6 * var(--cc-gap));
        }
        .mhead { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; margin-bottom: 6px; }
        .mname { font-size: 0.9em; font-weight: 600; color: var(--primary-text-color);
                 white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mcount { font-size: 0.8em; color: var(--secondary-text-color); white-space: nowrap; }
        .vertical .mname { font-size: 1em; }
        .vertical .mcount { font-size: 0.85em; }
        .grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: var(--cc-gap); }
        .wd { margin-bottom: 4px; }
        .wd span { text-align: center; font-size: 0.65em; color: var(--secondary-text-color);
                   white-space: nowrap; overflow: hidden; }
        .vertical .wd span { font-size: 0.75em; }
        .d { aspect-ratio: 1; border-radius: 28%; box-sizing: border-box; }
        .d.off { border: 1.5px solid color-mix(in srgb, var(--secondary-text-color) 30%, transparent); }
        .d.on { background: var(--cc-active); }
        .d.future { border: none; background: color-mix(in srgb, var(--secondary-text-color) 7%, transparent); }
        .d.pad { visibility: hidden; }
        .d.today { outline: 2px solid var(--primary-text-color); outline-offset: 1px; }
        .legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 12px; font-size: 0.8em; color: var(--secondary-text-color); }
        .legend span { display: inline-flex; align-items: center; gap: 6px; }
        .legend .d { width: 12px; }
        .msg { color: var(--secondary-text-color); font-size: 0.9em; }
      </style>
      <ha-card>
        <div class="head">
          <span class="title">${escapeHtml(title)}</span>
          <span class="sub">${escapeHtml(summary)}</span>
        </div>
        ${body}
        <div class="legend">
          <span><i class="d on"></i>${escapeHtml(t("legend.active"))}</span>
          <span><i class="d off"></i>${escapeHtml(t("legend.none"))}</span>
          <span><i class="d off today"></i>${escapeHtml(t("legend.today"))}</span>
        </div>
      </ha-card>`;
  }

  _buildMonths(t, lang) {
    const cfg = this._config;
    const today = this._todayParts();
    const todayKey = keyOf(today.y, today.m, today.d);
    const counts = { ...this._counts };

    // Today's daily statistic is only complete after midnight; a "last activity"
    // timestamp sensor fills the gap so today lights up straight away.
    const lastId = cfg.last_activity_entity;
    const lastState = lastId && this._hass.states[lastId] ? this._hass.states[lastId].state : null;
    if (lastState && !isNaN(Date.parse(lastState))) {
      const key = this._dayKeyOfTimestamp(Date.parse(lastState));
      if (!counts[key]) counts[key] = 1;
    }

    const weekStart = firstWeekday(this._hass);
    const utc = { timeZone: "UTC" };
    // Side by side the columns are narrow: month without the current year, one-letter weekdays.
    const compact = cfg.layout !== "vertical";
    const monthFmt = new Intl.DateTimeFormat(lang, { ...utc, month: "long" });
    const monthYearFmt = new Intl.DateTimeFormat(lang, { ...utc, month: "long", year: "numeric" });
    const dayFmt = new Intl.DateTimeFormat(lang, { ...utc, weekday: "short", day: "numeric", month: "long", year: "numeric" });
    const wdFmt = new Intl.DateTimeFormat(lang, { ...utc, weekday: compact ? "narrow" : "short" });
    // 2023-01-01 was a Sunday: index 0 = Sunday.
    const weekdayNames = Array.from({ length: 7 }, (_, i) =>
      wdFmt.format(new Date(Date.UTC(2023, 0, 1 + ((weekStart + i) % 7)))).replace(/\.$/, ""),
    );

    let html = "";
    let currentMonthDays = 0;
    for (let back = cfg.months - 1; back >= 0; back--) {
      const first = new Date(Date.UTC(today.y, today.m - back, 1));
      const y = first.getUTCFullYear();
      const m = first.getUTCMonth();
      const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const lead = (first.getUTCDay() - weekStart + 7) % 7;

      let cells = '<span class="d pad"></span>'.repeat(lead);
      let active = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        const key = keyOf(y, m, d);
        const n = counts[key] || 0;
        const future = key > todayKey;
        const on = n > 0 && !future;
        if (on) active++;
        const cls = ["d", future ? "future" : on ? "on" : "off", key === todayKey ? "today" : ""].join(" ").trim();
        const tip = future ? "" : `${dayFmt.format(new Date(Date.UTC(y, m, d)))}: ${on ? t("times", { count: n }) : t("no_activity")}`;
        cells += `<span class="${cls}" title="${escapeHtml(tip)}"></span>`;
      }
      if (back === 0) currentMonthDays = active;

      const name = (compact && y === today.y ? monthFmt : monthYearFmt).format(first);
      html += `
        <div class="month">
          <div class="mhead">
            <span class="mname">${escapeHtml(name.charAt(0).toUpperCase() + name.slice(1))}</span>
            <span class="mcount">${escapeHtml(t("days", { count: active }))}</span>
          </div>
          <div class="grid wd">${weekdayNames.map((w) => `<span>${escapeHtml(w)}</span>`).join("")}</div>
          <div class="grid">${cells}</div>
        </div>`;
    }

    const classes = ["months", cfg.layout === "vertical" ? "vertical" : "", cfg.cell_size !== undefined ? "sized" : ""];
    return { html: `<div class="${classes.join(" ").trim()}">${html}</div>`, currentMonthDays };
  }
}

class ContributionsCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _schema(t) {
    return [
      { name: "entity", required: true, selector: { entity: { filter: { domain: "sensor" } } } },
      { name: "title", selector: { text: {} } },
      {
        type: "grid",
        name: "",
        schema: [
          { name: "months", selector: { number: { min: MIN_MONTHS, max: MAX_MONTHS, step: 1, mode: "box" } } },
          {
            name: "layout",
            selector: {
              select: {
                mode: "dropdown",
                options: [
                  { value: "horizontal", label: t("editor.layout_horizontal") },
                  { value: "vertical", label: t("editor.layout_vertical") },
                ],
              },
            },
          },
        ],
      },
      {
        name: "last_activity_entity",
        selector: { entity: { filter: { domain: "sensor", device_class: "timestamp" } } },
      },
      { name: "color", selector: { text: {} } },
    ];
  }

  _render() {
    if (!this._hass || !this._config) return;
    const t = translator(this._hass);
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (field) => t(`editor.${field.name}`);
      this._form.addEventListener("value-changed", (ev) => {
        const config = { ...ev.detail.value };
        for (const key of Object.keys(config)) {
          if (config[key] === "" || config[key] === undefined || config[key] === null) delete config[key];
        }
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = this._schema(t);
    this._form.data = { months: DEFAULT_MONTHS, layout: "horizontal", ...this._config };
  }
}

if (!customElements.get("contributions-card")) {
  customElements.define("contributions-card", ContributionsCard);
}
if (!customElements.get("contributions-card-editor")) {
  customElements.define("contributions-card-editor", ContributionsCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "contributions-card")) {
  window.customCards.push({
    type: "contributions-card",
    name: "Contributions Card",
    description: "GitHub-style grid of days with activity, from a counter sensor's statistics.",
    preview: true,
    documentationURL: "https://github.com/adamzimnyy/contributions-card",
  });
}

console.info(`%c CONTRIBUTIONS-CARD %c ${VERSION} `, "color: white; background: #43a047; font-weight: 700;", "color: #43a047;");
