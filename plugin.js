// Clavis team: a Buzz 1.0 plugin (API v1, plain JS, no build step).
//
// Three features. Each one runs on its own: if one fails (for example after a
// Buzz update), the others keep working, and the plugin page shows which failed.
//
// 1. SIDEBAR SECTIONS, set in the CANVAS of #00_begin_hier (owners/admins edit it):
//      ## Sidebar sections
//      - ⚪ General: 00_
//      - 📊 Marketing: 03_
//    Synced on start, when channels change, every 10 minutes and with "Sync now".
//    Everyone gets the same team workspaces (same IDs, names, icons, order); every
//    channel with a team prefix always goes into its team workspace. An own
//    workspace with the same name as a team one is removed (no doubles). Own
//    workspaces with other names stay.
//    If the canvas has no list or cannot be read, DEFAULT_SECTIONS below is used.
//
// 2. PROFILE FIELDS: everyone fills in their own profile on the plugin page
//    (job title, departments, birthday, ...). Stored as the person's own signed,
//    replaceable event (kind 30315, d = "clavis-profile"), readable by
//    community members (no Buzz app shows it as a status: they only read d=general).
//    The normal Buzz profile (kind 0) is never changed.
//    The list of departments can be set in the canvas:
//      ## Departments
//      - @studio
//      - @marketing
//    Without that list, DEFAULT_DEPARTMENTS below is used.
//
// 3. TAGS: a department is a tag. Type @stu in the composer and pick "@studio":
//    everyone who chose that department is inserted as a normal mention (max 32).
//    Type @@ to see all tags.
//
// It writes only the viewer's own data, signed with their own key. It uses
// session.sidebarPreferences, session.canvas, session.channels, session.profiles,
// session.read, session.outbox and conversation.registerCompletion, the
// internal/preview API that Buzz's own plugins use. Check after Buzz updates.

// ── Settings ─────────────────────────────────────────────────────────────
const LAYOUT_CHANNEL_ID = "e57f50ec-29cd-44cd-9918-894b006f2e25"; // #00_begin_hier
const COMMUNITY_HOST = "buzz.clavisbooks.com";
const SYNC_EVERY_MS = 10 * 60 * 1000;
const TEAM_ID_PREFIX = "c1a5b0c5-"; // marks sections made by this plugin
const MAX_MENTIONS = 32; // Buzz limit per completion choice
// Kind 30315 (NIP-38, parameterized replaceable) with our own d tag. Buzz only
// lets plugins sign 30078 for sidebar data and channel recipes, so we use 30315:
// every Buzz app reads statuses only from d = "general", so this record never
// shows up as someone's status.
const PROFILE_KIND = 30315;
const PROFILE_D = "clavis-profile";
const PROFILE_T = "clavis-profile-v1";
const DEFAULT_DEPARTMENTS = [
  "uitgevers", "foreignrights", "studio", "redactie", "marketing", "sales",
  "belgie", "nederland", "clavisusa", "management", "logistiek",
];
// Used when the canvas of #00_begin_hier has no "Sidebar sections" list or cannot
// be read (Buzz drops its canvas copy after channel access changes, and the relay
// may not have it). Same format as a canvas line: "emoji Name: prefix, prefix".
const DEFAULT_SECTIONS = [
  "⚪ General: 00_",
  "📚 Publishing: 01_",
  "💼 Sales & Distribution: 02_",
  "📊 Marketing: 03_",
  "🌍 Fairs & Rights: 04_",
  "✏️ Editorial: 05_",
  "🎨 Studio: 06_",
  "🌐 Websites: 07_",
  "📦 Logistics: 08_",
  "🧾 Accounting: 09_",
  "🐉 China: 10_",
];
const WEEKDAYS = [
  ["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"],
];
const DAY_CHOICES = [["", "–"], ["office", "🏢 Office"], ["home", "🏠 Home"], ["off", "Off"]];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Free-text profile fields, in display order.
const TEXT_FIELDS = [
  ["title", "Job title"],
  ["pyPrimary", "PrinciplesYou primary type"],
  ["pySecondary", "PrinciplesYou secondary types"],
  ["reading", "📖 Currently reading"],
  ["favoriteTitle", "📚 Favourite Clavis title"],
  ["languages", "🗣️ Languages I speak"],
  ["coffeeTea", "☕ Coffee or tea?"],
  ["askMe", "💡 Ask me anything about…"],
  ["funFact", "🎉 Fun fact about me"],
];
const MAX_TEXT = 200;

// ── Polls ────────────────────────────────────────────────────────────────
// A poll is a normal channel message in a fixed, readable format. Votes are each
// voter's own replaceable kind-30315 event (d = clavis-vote:<poll message id>), so
// there is exactly one vote per person per poll. OPEN polls: the choice is plain
// and the plugin counts. ANONYMOUS polls: the choice is encrypted (P-256 ECDH +
// HKDF + AES-GCM) for the "Clavis Polls" bot on cladocker01, which publishes only
// the totals (d = clavis-tally:<poll>). The poll author can close a poll early
// (d = clavis-poll-close:<poll>). Votes after closing do not count.
const POLL_BOT_PUBKEY = "3f8e27bcbcf46afb8c69c7dffeb635788553409bf00025a096686f1ef5a8f5d3";
const POLL_BOT_P256 = "BLSJA4Fsv5ojKyx3d6vi/+xE7EQjazglxexxt1k/zqlT6Z8slA+hvi4/BD9tTPDWzU1jk61NYvmskWgKQ016lNU=";
const POLL_MAX_OPTIONS = 10;
const POLL_REFRESH_MS = 20000;
const POLL_RE = /^📊 \*\*Poll:\*\* (.+)$/;
const POLL_OPT_RE = /^(\d+)\. (.+)$/;
const POLL_FLAGS_RE = /^_(Anonymous|Open) poll · (Single|Multiple) choice · (?:Ongoing|Closes (\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d) \(UTC([+-])(\d\d):(\d\d)\))_$/;

function parsePoll(content) {
  if (typeof content !== "string" || !content.startsWith("📊 **Poll:**")) return null;
  const lines = content.split("\n").map((l) => l.trim());
  const q = POLL_RE.exec(lines[0]);
  if (!q) return null;
  const options = [];
  let i = 1;
  while (i < lines.length && POLL_OPT_RE.test(lines[i])) options.push(POLL_OPT_RE.exec(lines[i++])[2]);
  if (options.length < 2 || options.length > POLL_MAX_OPTIONS || i >= lines.length) return null;
  const m = POLL_FLAGS_RE.exec(lines[i]);
  if (!m) return null;
  let closes = null;
  if (m[3]) {
    const offset = (Number(m[9]) * 60 + Number(m[10])) * (m[8] === "+" ? 1 : -1);
    closes = Date.UTC(+m[3], +m[4] - 1, +m[5], +m[6], +m[7]) / 1000 - offset * 60;
  }
  return { question: q[1], options, anonymous: m[1] === "Anonymous", multiple: m[2] === "Multiple", closes };
}

const oneLine = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
function buildPollText({ question, options, anonymous, multiple, closesAt }) {
  let closing = "Ongoing";
  if (closesAt) {
    const d = new Date(closesAt);
    const off = -d.getTimezoneOffset();
    const pad = (n) => String(Math.abs(n)).padStart(2, "0");
    closing = `Closes ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (UTC${off >= 0 ? "+" : "-"}${pad(Math.trunc(off / 60))}:${pad(off % 60)})`;
  }
  return [
    `📊 **Poll:** ${oneLine(question, 200)}`,
    ...options.map((o, i) => `${i + 1}. ${oneLine(o, 120)}`),
    `_${anonymous ? "Anonymous" : "Open"} poll · ${multiple ? "Multiple" : "Single"} choice · ${closing}_`,
    "_Vote in Buzz with the Clavis team plugin._",
  ].join("\n");
}

const te = new TextEncoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function encryptVote(pollId, choices) {
  const s = crypto.subtle;
  const botKey = await s.importKey("raw", fromB64(POLL_BOT_P256), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await s.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const bits = await s.deriveBits({ name: "ECDH", public: botKey }, eph.privateKey, 256);
  const hk = await s.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const key = await s.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: te.encode("clavis-poll-salt-v1"), info: te.encode(`clavis-poll-v1|${pollId}`) },
    hk, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await s.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(pollId) }, key, te.encode(JSON.stringify({ poll: pollId, choices })));
  return { epk: toB64(await s.exportKey("raw", eph.publicKey)), iv: toB64(iv), ct: toB64(ct) };
}

/** Read events with the first read path that works (readRemote, then read). */
async function readEvents(session, filter) {
  const opts = () => ({ signal: AbortSignal.timeout(20000) });
  let lastError;
  for (const fn of [session.readRemote, session.read]) {
    if (typeof fn !== "function") continue;
    try {
      return eventsOf(await fn.call(session, [filter], opts()));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("this Buzz version cannot read events");
}

/** Publish one of the viewer's own replaceable kind-30315 events and wait for the relay. */
const lastSentAt = new Map();
async function publishOwn(session, d, content) {
  const outbox = session.outbox;
  if (!outbox?.supports?.(PROFILE_KIND)) throw new Error("Saving is not available in this Buzz version");
  // Replaceable events use whole seconds: never send two for the same d in one second.
  const wait = (lastSentAt.get(d) ?? 0) + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSentAt.set(d, Date.now());
  const id = outbox.send({ kind: PROFILE_KIND, content, tags: [["d", d]] });
  await waitFor(
    outbox.subscribe,
    () => {
      const item = outbox.snapshot().find((x) => x.event?.id === id);
      if (!item) return true;
      if (item.delivery === "failed") throw new Error(item.error || "Sending failed");
      return item.delivery === "accepted" || item.delivery === "seen";
    },
    30000,
    "the relay",
  );
}
// ─────────────────────────────────────────────────────────────────────────

const LOG_PREFIX = "[clavis.team]";
const log = [];
const listeners = new Set();
const notify = () => listeners.forEach((l) => l());
function note(message) {
  log.push(`${new Date().toLocaleTimeString()}  ${message}`);
  if (log.length > 200) log.shift();
  console.info(LOG_PREFIX, message);
  notify();
}

const FEATURES = { sections: "Sidebar sections", profiles: "Profiles", tags: "Tags", polls: "Polls", unread: "Unread counters" };
const status = { sections: "starting", profiles: "starting", tags: "starting", polls: "starting", unread: "starting" };
function setStatus(feature, value) {
  if (status[feature] === value) return;
  status[feature] = value;
  if (value !== "ok" && value !== "starting") note(`${FEATURES[feature]}: ${value}`);
  notify();
}
const errorText = (error) => `error: ${error?.message ?? error}`;

// ── Canvas parsing ───────────────────────────────────────────────────────

/** The bullet lines under the first heading matching `headingRe`. */
function listUnder(markdown, headingRe) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => headingRe.test(l.trim()));
  if (start < 0) return [];
  const out = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) break;
    if (/^[-*]\s+/.test(line)) out.push(line.replace(/^[-*]\s+/, ""));
  }
  return out;
}

function parseLayout(markdown) {
  return parseLayoutItems(listUnder(markdown, /^#{1,6}\s*(sidebar sections|team sections|secties|zijbalk)\b/i));
}

function parseLayoutItems(items) {
  const layout = [];
  for (const item of items) {
    const m = /^(.+?)\s*:\s*(.+)$/.exec(item);
    if (!m) continue;
    let label = m[1].replace(/\*\*/g, "").trim();
    let icon;
    const first = label.split(/\s+/)[0];
    if (first && !/^[\p{L}\p{N}]/u.test(first)) {
      icon = first;
      label = label.slice(first.length).trim();
    }
    const prefixes = m[2].split(",").map((p) => p.replace(/[`*]/g, "").trim().toLowerCase()).filter(Boolean);
    if (label && prefixes.length) layout.push({ name: label, icon, prefixes });
  }
  return layout;
}

const TAG_RE = /^[\p{L}\p{N}_.-]{1,40}$/u;
function parseDepartments(markdown) {
  const out = [];
  for (const item of listUnder(markdown, /^#{1,6}\s*(departments|afdelingen)\b/i)) {
    const tag = item.replace(/[`*]/g, "").trim().replace(/^@/, "").split(/[\s:]/)[0].toLowerCase();
    if (TAG_RE.test(tag) && !out.includes(tag)) out.push(tag);
  }
  return out;
}

// ── npub decoding (bech32, NIP-19) for profile panel targets ─────────────
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function npubToHex(npub) {
  const s = String(npub).toLowerCase();
  if (!s.startsWith("npub1")) return undefined;
  const data = [];
  for (const c of s.slice(5)) {
    const v = BECH32.indexOf(c);
    if (v < 0) return undefined;
    data.push(v);
  }
  let acc = 0, bits = 0;
  const bytes = [];
  for (const w of data.slice(0, -6)) { // drop the checksum
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bytes.length < 32) return undefined;
  return bytes.slice(0, 32).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Shared state ─────────────────────────────────────────────────────────
let departments = DEFAULT_DEPARTMENTS.slice();
/** pubkey → { name, profile, createdAt } */
let people = new Map();
/** [{ tag, size, recipients: [{pubkey,name}], tooMany }] */
let resolvedTags = [];
let viewerKey;

// ── Profiles ─────────────────────────────────────────────────────────────

function cleanText(v) {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, MAX_TEXT) : "";
}
/** Validate a profile from an event (never trust content). */
function cleanProfile(raw) {
  const p = {};
  for (const [key] of TEXT_FIELDS) {
    const v = cleanText(raw?.[key]);
    if (v) p[key] = v;
  }
  if (Array.isArray(raw?.departments))
    p.departments = [...new Set(raw.departments.map((d) => String(d).toLowerCase()).filter((d) => TAG_RE.test(d)))].slice(0, 20);
  if (typeof raw?.birthday === "string" && /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(raw.birthday)) p.birthday = raw.birthday;
  if (typeof raw?.since === "string" && /^(19|20)\d\d-(0[1-9]|1[0-2])$/.test(raw.since)) p.since = raw.since;
  if (raw?.days && typeof raw.days === "object") {
    const days = {};
    for (const [d] of WEEKDAYS) if (["office", "home", "off"].includes(raw.days[d])) days[d] = raw.days[d];
    if (Object.keys(days).length) p.days = days;
  }
  return p;
}

/** Unwrap whatever shape a read returns: an array, { events }, or wrapped events. */
function eventsOf(result) {
  const list = Array.isArray(result) ? result : Array.isArray(result?.events) ? result.events : [];
  return list.map((e) => (e && typeof e === "object" && e.event && !e.kind ? e.event : e));
}

/** Read the profile events, trying several read paths and logging each result. */
async function readProfileEvents(session) {
  const withD = [{ kinds: [PROFILE_KIND], "#d": [PROFILE_D], limit: 500 }];
  const kindOnly = [{ kinds: [PROFILE_KIND], limit: 500 }];
  const attempts = [];
  if (typeof session.readRemote === "function") {
    attempts.push(["readRemote #d", () => session.readRemote(withD, { signal: AbortSignal.timeout(20000) })]);
    attempts.push(["readRemote kind", () => session.readRemote(kindOnly, { signal: AbortSignal.timeout(20000) })]);
  }
  if (typeof session.read === "function") {
    attempts.push(["read #d", () => session.read(withD, { signal: AbortSignal.timeout(20000) })]);
    attempts.push(["read kind", () => session.read(kindOnly, { signal: AbortSignal.timeout(20000) })]);
  }
  if (!attempts.length) throw new Error("this Buzz version has no session.read");
  const report = [];
  let lastError;
  for (const [label, read] of attempts) {
    try {
      const events = eventsOf(await read());
      const ours = events.filter((e) => e?.kind === PROFILE_KIND && e.tags?.some((t) => t[0] === "d" && t[1] === PROFILE_D));
      report.push(`${label}: ${events.length} events, ${ours.length} profiles`);
      if (ours.length) {
        lastReadReport = report.join("; ");
        return ours;
      }
    } catch (error) {
      lastError = error;
      report.push(`${label}: ${error?.message ?? error}`);
    }
  }
  lastReadReport = report.join("; ");
  if (lastError && report.every((r) => !/events/.test(r))) throw lastError;
  return [];
}
let lastReadReport = "";

async function loadProfiles(session) {
  const events = await readProfileEvents(session);
  if (lastReadReport && lastReadReport !== loadProfiles.lastLogged) {
    note(`Profile read: ${lastReadReport}`);
    loadProfiles.lastLogged = lastReadReport;
  }
  const newest = new Map();
  for (const e of events ?? []) {
    if (e?.kind !== PROFILE_KIND || !e.tags?.some((t) => t[0] === "d" && t[1] === PROFILE_D)) continue;
    const prev = newest.get(e.pubkey);
    if (!prev || e.created_at > prev.created_at) newest.set(e.pubkey, e);
  }
  const ids = [...newest.keys()];
  if (ids.length) {
    try {
      await session.profiles.ensure(ids);
    } catch {}
  }
  const names = session.profiles.snapshot();
  const next = new Map();
  for (const [pubkey, e] of newest) {
    let raw;
    try {
      raw = JSON.parse(e.content);
    } catch {
      continue;
    }
    next.set(pubkey, {
      name: names.get(pubkey)?.name ?? pubkey.slice(0, 8),
      profile: cleanProfile(raw),
      createdAt: e.created_at,
    });
  }
  // Keep a just-saved own profile if the read does not have it yet.
  const mine = people.get(session.viewer) ?? localOwn(session);
  const readMine = next.get(session.viewer);
  if (readMine) ownLoaded = "relay";
  if (mine?.local && (!readMine || readMine.createdAt < mine.createdAt)) {
    next.set(session.viewer, mine);
    if (!readMine) ownLoaded = "device";
  }
  people = next;
  viewerKey = session.viewer;
}

// The own profile is also kept on this device, so a plugin update or restart
// never shows an empty form while the relay read is unavailable.
/** "relay" | "device" | undefined: where the own profile was loaded from. */
let ownLoaded;
const ownKey = (session) => `clavis.team.profile:${session.viewer}`;
function localOwn(session) {
  try {
    const saved = JSON.parse(localStorage.getItem(ownKey(session)) ?? "null");
    if (!saved || typeof saved !== "object") return undefined;
    return { name: saved.name ?? "Me", profile: cleanProfile(saved.profile), createdAt: Number(saved.createdAt) || 0, local: true };
  } catch {
    return undefined;
  }
}
function storeOwn(session, entry) {
  try {
    localStorage.setItem(ownKey(session), JSON.stringify(entry));
  } catch {}
}

async function saveProfile(session, profile) {
  const outbox = session.outbox;
  if (!outbox?.supports?.(PROFILE_KIND)) throw new Error("Saving is not available in this Buzz version");
  const mine = people.get(session.viewer);
  if (mine && mine.createdAt >= Math.floor(Date.now() / 1000))
    throw new Error("Please wait a second before saving again");
  const id = outbox.send({
    kind: PROFILE_KIND,
    content: JSON.stringify({ v: 1, ...cleanProfile(profile) }),
    tags: [["d", PROFILE_D], ["t", PROFILE_T]],
  });
  await waitFor(
    outbox.subscribe,
    () => {
      const item = outbox.snapshot().find((x) => x.event?.id === id);
      if (!item) return true; // confirmed items leave the outbox
      if (item.delivery === "failed") throw new Error(item.error || "Saving failed");
      return item.delivery === "accepted" || item.delivery === "seen";
    },
    30000,
    "the relay to accept your profile",
  );
  // Show it right away (form, own profile panel, tags), without waiting for a read.
  const name = session.profiles?.snapshot?.().get(session.viewer)?.name ?? mine?.name ?? "Me";
  const entry = { name, profile: cleanProfile(profile), createdAt: Math.floor(Date.now() / 1000), local: true };
  people = new Map(people);
  people.set(session.viewer, entry);
  storeOwn(session, entry);
  if (ownLoaded !== "relay") ownLoaded = "device";
  viewerKey = session.viewer;
  try {
    buildTags();
  } catch {}
  notify();
}

// ── Tags ─────────────────────────────────────────────────────────────────

function buildTags() {
  const out = [];
  for (const tag of departments) {
    const all = [...people.entries()]
      .filter(([, p]) => p.profile.departments?.includes(tag))
      .map(([pubkey, p]) => ({ pubkey, name: p.name }));
    out.push({
      tag,
      size: all.length,
      recipients: all.filter((r) => r.pubkey !== viewerKey).slice(0, MAX_MENTIONS),
      tooMany: all.length > MAX_MENTIONS,
    });
  }
  resolvedTags = out;
}

/** Composer syntax: "@stu" (only if a tag starts with it) or "@@stu" (always). */
function tagQuery(text, caret) {
  if (!resolvedTags.length || !Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const before = text.slice(Math.max(0, caret - 80), caret);
  const m = /(?:^|[\s([{])(@@?)([\p{L}\p{N}_.-]*)$/u.exec(before);
  if (!m) return null;
  const forced = m[1] === "@@";
  const q = m[2].toLowerCase();
  if (!forced && q.length < 2) return null; // leave short queries to person mentions
  if (!resolvedTags.some((t) => t.tag.startsWith(q))) return null;
  return { start: caret - m[2].length - m[1].length, end: caret, query: q, forced };
}

// ── Sidebar sections ─────────────────────────────────────────────────────

async function teamId(name) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`clavis-team-section:${name.trim().toLowerCase()}`)),
  );
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${TEAM_ID_PREFIX}${hex.slice(0, 4)}-4${hex.slice(5, 8)}-8${hex.slice(9, 12)}-${hex.slice(12, 24)}`;
}
const isTeam = (id) => typeof id === "string" && id.startsWith(TEAM_ID_PREFIX);

/** Resolve when `check()` returns truthy, re-checking on every store change. */
function waitFor(subscribe, check, ms, what) {
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubscribe = () => {};
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      fn(value);
    };
    const test = () => {
      try {
        const value = check();
        if (value) finish(resolve, value);
      } catch (error) {
        finish(reject, error);
      }
    };
    const timer = setTimeout(() => finish(reject, new Error(`Timed out waiting for ${what}`)), ms);
    unsubscribe = subscribe(test);
    test();
  });
}

async function readyStores(session) {
  const prefs = session.sidebarPreferences;
  const channels = session.channels;
  if (!prefs || prefs.available === false) throw new Error("This Buzz version does not support saved sections");
  prefs.ensure();
  channels.ensureList();
  await waitFor(
    prefs.subscribe,
    () => {
      const s = prefs.snapshot();
      if (s.status === "error" || s.status === "unsupported") throw new Error(`Sidebar preferences: ${s.status}`);
      return s.status === "ready" && !s.cached && prefs.writable;
    },
    30000,
    "your sidebar preferences",
  );
  await waitFor(
    channels.subscribeList,
    () => {
      const l = channels.list();
      if (l.status === "error") throw new Error(l.error || "Channel list error");
      return l.status === "ready" && l.coverage !== "partial";
    },
    30000,
    "the channel list",
  );
  return { prefs, channels: channels.list().channels };
}

let lastLayoutText = "";

const sameName = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

// Everyone gets the same team workspaces: same IDs, names, icons, order and the
// same channel filing. The team layout always wins for channels that match a
// prefix, and a workspace of the person's own with the same name as a team
// workspace is removed (that was the cause of the doubles: an older own
// "Marketing" next to the team "Marketing"). Own workspaces with other names
// stay, for channels that match no prefix and for DMs.
async function syncSections(session, layout) {
  if (!layout.length) {
    note("No 'Sidebar sections' list in the canvas: sidebar not changed.");
    return;
  }
  const { prefs, channels } = await readyStores(session);
  const layoutText = layout.map((s) => `${s.icon ?? ""} ${s.name}`).join(" · ");
  if (layoutText !== lastLayoutText) {
    note(`Team layout: ${layoutText}`);
    lastLayoutText = layoutText;
  }
  const wanted = [];
  for (const s of layout) wanted.push({ ...s, id: await teamId(s.name) });
  const ruleFor = (name) => {
    const lower = name.toLowerCase();
    return wanted.find((s) => s.prefixes.some((p) => lower.startsWith(p)));
  };
  const sections = () => prefs.snapshot().data?.sections ?? [];
  const have = new Map(sections().map((s) => [s.id, s]));
  let created = 0, updated = 0, moved = 0, removed = 0, reordered = false;

  // 1. Team workspaces: create the ones that have channels, fix name and icon.
  const used = new Set(channels.map((c) => ruleFor(c.name)?.id).filter(Boolean));
  for (const s of wanted) {
    const current = have.get(s.id);
    if (!current) {
      if (!used.has(s.id)) continue;
      await prefs.createSection({ id: s.id, name: s.name, ...(s.icon ? { icon: s.icon } : {}) });
      created++;
    } else if ((current.icon ?? "") !== (s.icon ?? "") || current.name !== s.name) {
      if (prefs.sectionRenameWritable) {
        await prefs.renameSection(s.id, { name: s.name, icon: s.icon ?? null });
        updated++;
      }
    }
  }
  const live = new Set(sections().map((s) => s.id));

  // 2. Every channel with a team prefix goes into its team workspace.
  const assignments = prefs.snapshot().data?.assignments ?? {};
  for (const channel of channels) {
    const rule = ruleFor(channel.name);
    if (!rule || !live.has(rule.id)) continue;
    if (assignments[channel.id] === rule.id) continue;
    await prefs.assign(channel.id, rule.id);
    moved++;
  }

  // 3. Remove doubles (own workspace named like a team one) and old team workspaces.
  const wantedIds = new Set(wanted.map((s) => s.id));
  for (const s of sections()) {
    const team = isTeam(s.id);
    const double = !team && wanted.some((w) => live.has(w.id) && sameName(w.name, s.name));
    const obsolete = team && !wantedIds.has(s.id);
    if (!double && !obsolete) continue;
    if (!prefs.sectionRemovalWritable) {
      note(`Could not remove ${double ? "double" : "old team"} workspace "${s.name}" right now; will retry.`);
      continue;
    }
    await prefs.removeSection(s.id);
    removed++;
  }

  // 4. Team workspaces in the layout order, where the person has them in the sidebar.
  try {
    const order = prefs.snapshot().data?.sectionOrder;
    if (Array.isArray(order) && prefs.sectionOrderWritable && typeof prefs.reorderSections === "function") {
      const teamKeys = wanted.filter((w) => live.has(w.id)).map((w) => `group:${w.id}`);
      const inOrder = new Set(teamKeys);
      const queue = teamKeys.filter((k) => order.includes(k));
      const next = order.map((k) => (inOrder.has(k) ? queue.shift() : k));
      if (next.some((k, i) => k !== order[i])) {
        await prefs.reorderSections(teamKeys[0], next);
        reordered = true;
      }
    }
  } catch (error) {
    note(`Workspace order not changed (${error?.message ?? error}).`);
  }

  if (created || updated || moved || removed || reordered)
    note(`Workspaces synced: ${created} created, ${updated} updated, ${removed} removed, ${moved} channel(s) sorted${reordered ? ", order fixed" : ""}.`);
  else note("Workspaces already up to date.");
}

// ── Sync everything, each feature isolated ───────────────────────────────

async function syncAll(session, tagsEnabled) {
  let content = "";
  let canvasOk = false;
  try {
    if (!session.canvas?.available) throw new Error("this Buzz version cannot read channel canvases");
    content = (await session.canvas.read(LAYOUT_CHANNEL_ID))?.content ?? "";
    canvasOk = true;
  } catch (error) {
    note(`Sidebar sections: canvas of #00_begin_hier unreadable (${error?.message ?? error})`);
  }
  // Departments list from the canvas, else the defaults.
  if (canvasOk) {
    const fromCanvas = parseDepartments(content);
    departments = fromCanvas.length ? fromCanvas : DEFAULT_DEPARTMENTS.slice();
  }
  // Profiles (read only) → tags.
  try {
    await loadProfiles(session);
    setStatus("profiles", "ok");
  } catch (error) {
    setStatus("profiles", errorText(error));
    // Still show the own profile saved on this device.
    const own = !people.has(session.viewer) && localOwn(session);
    if (own) {
      people = new Map(people).set(session.viewer, own);
      viewerKey = session.viewer;
      ownLoaded = "device";
    }
  }
  if (tagsEnabled) {
    try {
      buildTags();
      setStatus("tags", status.profiles === "ok" ? "ok" : "using last known profiles");
    } catch (error) {
      setStatus("tags", errorText(error));
    }
  }
  try {
    let layout = canvasOk ? parseLayout(content) : [];
    let source = "canvas";
    if (!layout.length) {
      layout = parseLayoutItems(DEFAULT_SECTIONS);
      source = "built-in list";
      note(`No 'Sidebar sections' list in the canvas${canvasOk ? "" : " (unreadable)"}: using the built-in list.`);
    }
    await syncSections(session, layout);
    setStatus("sections", source === "canvas" ? "ok" : "ok (built-in list)");
  } catch (error) {
    setStatus("sections", errorText(error));
  }
  notify();
}

// ── Plugin ───────────────────────────────────────────────────────────────

// "conversation" is deliberately NOT injected: if it were missing, the whole
// plugin would not start. Tags pick it up optionally below.
export const inject = ["react", "pages", "relay"];

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  const relay = ctx.relay;
  let busy = false;
  let lastScope;
  let tagsEnabled = false;

  const currentConnection = () => {
    const c = relay.snapshot();
    return c.status === "ready" && String(c.origin ?? c.scope ?? "").includes(COMMUNITY_HOST) ? c : undefined;
  };

  let again = false;
  async function run(reason) {
    const c = currentConnection();
    if (!c) return;
    if (busy) {
      again = true; // e.g. new channels arrived during a sync: sync once more after
      return;
    }
    busy = true;
    again = false;
    notify();
    try {
      if (reason) note(reason);
      await syncAll(c.session, tagsEnabled);
    } catch (error) {
      note(`Error: ${error?.message ?? error}`);
    } finally {
      busy = false;
      notify();
      if (again) void run();
    }
  }

  // New channels (a new colleague is put in all open channels by the server
  // within a minute, or someone creates a channel): file them right away
  // instead of waiting for the 10-minute sync.
  ctx.effect(() => {
    let session, off, timer, known = "";
    const watch = () => {
      const c = currentConnection();
      const next = c?.session;
      if (next === session) return;
      off?.();
      off = undefined;
      session = next;
      known = "";
      const list = session?.channels;
      if (typeof list?.subscribeList !== "function") return;
      off = list.subscribeList(() => {
        const l = list.list();
        if (l.status !== "ready") return;
        const ids = l.channels.map((ch) => `${ch.id}:${ch.name}`).sort().join(",");
        if (ids === known) return;
        const first = !known;
        known = ids;
        if (first) return; // the connect sync already covers the first list
        clearTimeout(timer);
        timer = setTimeout(() => void run("Channels changed: syncing..."), 3000);
      });
    };
    const unsubscribe = relay.subscribe(watch);
    watch();
    return () => {
      unsubscribe();
      off?.();
      clearTimeout(timer);
    };
  });

  ctx.effect(() => {
    const check = () => {
      const c = currentConnection();
      const key = c ? `${c.scope}:${c.generation}` : undefined;
      if (!key || key === lastScope) return;
      lastScope = key;
      void run(`Connected to ${COMMUNITY_HOST}: syncing...`);
    };
    const unsubscribe = relay.subscribe(check);
    check();
    return unsubscribe;
  });

  ctx.effect(() => {
    const timer = setInterval(() => void run(), SYNC_EVERY_MS);
    return () => clearInterval(timer);
  });

  // Composer: @department → several mentions. Isolated: a failure here never
  // stops the other features.
  try {
    const conversation = ctx.reflect?.get?.("conversation");
    if (typeof conversation?.registerCompletion !== "function")
      throw new Error("this Buzz version has no composer completions");
    conversation.registerCompletion({
      id: "tags",
      title: "Team tags",
      order: -20,
      match: ({ text, start }) => {
        try {
          return tagQuery(text, start);
        } catch (error) {
          setStatus("tags", errorText(error));
          return null;
        }
      },
      component: function TagCompletion({ query, publish }) {
        React.useEffect(() => {
          let withdraw;
          try {
            const q = query.query ?? "";
            const items = resolvedTags
              .filter((t) => t.tag.startsWith(q))
              .map((t) => {
                const disabled = t.recipients.length === 0;
                return {
                  id: `tag-${t.tag}`,
                  label: `📣 @${t.tag}`,
                  detail: disabled
                    ? "nobody has chosen this department yet"
                    : `${t.recipients.length} ${t.recipients.length === 1 ? "person" : "people"}: ${t.recipients.map((r) => r.name).join(", ")}`.slice(0, 140),
                  disabled,
                  canSelect: !disabled,
                  edit: disabled ? { text: `@${t.tag}` } : { mentions: t.recipients },
                };
              });
            withdraw = publish({ items });
          } catch (error) {
            setStatus("tags", errorText(error));
          }
          return () => {
            try {
              if (typeof withdraw === "function") withdraw();
            } catch {}
          };
        }, [query.query, publish]);
        return null;
      },
    });
    tagsEnabled = true;
  } catch (error) {
    setStatus("tags", `off: ${error?.message ?? error}`);
  }

  // ── Page UI ────────────────────────────────────────────────────────────
  // Buzz's own design-system classes (buzz-field, buzz-input, buzz-button) so the
  // form looks like the rest of Settings.
  const field = (label, control, description) =>
    h(
      "div",
      { className: "buzz-field" },
      h("span", { className: "buzz-field-label" }, label),
      control,
      description ? h("span", { className: "buzz-field-description" }, description) : null,
    );
  const input = (value, onChange, props = {}) =>
    h("input", { className: "buzz-input", value: value ?? "", maxLength: MAX_TEXT, onChange: (e) => onChange(e.target.value), ...props });
  const select = (value, onChange, options, label) =>
    h(
      "select",
      { className: "buzz-input", "aria-label": label, value: value ?? "", onChange: (e) => onChange(e.target.value), style: { width: "auto", minWidth: "5.5rem" } },
      options.map(([v, l]) => h("option", { key: v, value: v }, l)),
    );
  const group = (title, ...children) =>
    h(
      "section",
      { style: { display: "grid", gap: "var(--space-4)", marginBottom: "var(--space-8, 2rem)" } },
      h("h3", { style: { margin: 0 } }, title),
      ...children,
    );
  // Buzz styles plain <button> text with its own colour, which wins over the
  // variant's colour. Set the variant's text colour inline, always from Buzz's
  // theme variables, so light and dark themes both work (backgrounds and hover
  // still come from Buzz's CSS).
  const variantText = (variant) =>
    variant === "prominent" ? { color: "var(--text-on-prominent)" } : { color: "var(--text-standard)" };
  const row = (...children) =>
    h("div", { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center" } }, ...children);

  function MyProfile({ connection }) {
    const mine = people.get(connection.session.viewer)?.profile ?? {};
    const [draft, setDraft] = React.useState(() => JSON.parse(JSON.stringify(mine)));
    const [state, setState] = React.useState("");
    const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
    // Day/month and month/year are kept separately while editing, so choosing the
    // first one does not wipe it; they are combined when saving.
    const [b, setB] = React.useState(() => {
      const [m = "", d = ""] = (mine.birthday ?? "").split("-");
      return { m, d };
    });
    const [s, setS] = React.useState(() => {
      const [y = "", m = ""] = (mine.since ?? "").split("-");
      return { y, m };
    });
    const thisYear = new Date().getFullYear();
    const toggleDept = (tag) =>
      set("departments", (draft.departments ?? []).includes(tag) ? draft.departments.filter((t) => t !== tag) : [...(draft.departments ?? []), tag]);
    const save = async () => {
      if ((b.m && !b.d) || (!b.m && b.d)) return setState("⚠️ Choose both a day and a month for your birthday, or neither.");
      if ((s.m && !s.y) || (!s.m && s.y)) return setState("⚠️ Choose both a month and a year for 'At Clavis since', or neither.");
      const days = { "02": 29, "04": 30, "06": 30, "09": 30, "11": 30 };
      if (b.m && Number(b.d) > (days[b.m] ?? 31)) return setState("⚠️ That day does not exist in that month.");
      setState("Saving...");
      try {
        await saveProfile(connection.session, {
          ...draft,
          birthday: b.m && b.d ? `${b.m}-${b.d}` : undefined,
          since: s.y && s.m ? `${s.y}-${s.m}` : undefined,
        });
        setState("✅ Saved. Colleagues see it after their next sync (within 10 minutes).");
        void run();
      } catch (error) {
        setState(`⚠️ ${error?.message ?? error}`);
      }
    };
    const chosen = draft.departments ?? [];
    const textField = (key) => {
      const [, label] = TEXT_FIELDS.find(([k]) => k === key);
      return h("div", { key }, field(label, input(draft[key], (v) => set(key, v))));
    };
    return h(
      "div",
      { style: { maxWidth: "40rem" } },
      h(
        "p",
        { className: "buzz-field-description", style: { marginTop: 0, marginBottom: "var(--space-6, 1.5rem)" } },
        "Everything here is optional and visible to everyone in the Clavis community.",
      ),
      ownLoaded
        ? null
        : h(
            "div",
            { className: "ui-card", style: { padding: "var(--space-3, 0.75rem)", marginBottom: "var(--space-6, 1.5rem)" } },
            "⚠️ No saved Clavis profile was found for you. If you saved one before, saving now replaces it with what is in this form.",
          ),
      group(
        "Work",
        field(
          "Departments",
          row(
            ...departments.map((tag) =>
              h(
                "button",
                {
                  key: tag,
                  type: "button",
                  className: "buzz-button",
                  "data-size": "sm",
                  "data-variant": chosen.includes(tag) ? "prominent" : "glass",
                  style: variantText(chosen.includes(tag) ? "prominent" : "glass"),
                  "aria-pressed": chosen.includes(tag),
                  onClick: () => toggleDept(tag),
                },
                `${chosen.includes(tag) ? "✓ " : ""}@${tag}`,
              ),
            ),
          ),
          "Your departments are your tags: colleagues can mention everyone in a department with @studio, @sales, …",
        ),
        textField("title"),
        field(
          "At Clavis since",
          row(
            select(s.m, (m) => setS((x) => ({ ...x, m })), [["", "Month"], ...MONTHS.map((n, i) => [String(i + 1).padStart(2, "0"), n])], "Month"),
            select(s.y, (y) => setS((x) => ({ ...x, y })), [["", "Year"], ...Array.from({ length: thisYear - 1979 }, (_, i) => String(thisYear - i)).map((y) => [y, y])], "Year"),
          ),
        ),
        field(
          "Office or home",
          h(
            "div",
            { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(6.5rem, 1fr))", gap: "var(--space-2)" } },
            WEEKDAYS.map(([d, label]) =>
              h(
                "div",
                { key: d, style: { display: "grid", gap: "var(--space-1)" } },
                h("span", { className: "buzz-field-description" }, label),
                select(draft.days?.[d], (v) => set("days", { ...(draft.days ?? {}), [d]: v || undefined }), DAY_CHOICES, label),
              ),
            ),
          ),
        ),
      ),
      group(
        "About you",
        field(
          "Birthday",
          row(
            select(b.d, (d) => setB((x) => ({ ...x, d })), [["", "Day"], ...Array.from({ length: 31 }, (_, i) => [String(i + 1).padStart(2, "0"), String(i + 1)])], "Day"),
            select(b.m, (m) => setB((x) => ({ ...x, m })), [["", "Month"], ...MONTHS.map((n, i) => [String(i + 1).padStart(2, "0"), n])], "Month"),
          ),
          "Day and month only. The Check-in Bot congratulates you on the day.",
        ),
        textField("pyPrimary"),
        textField("pySecondary"),
      ),
      group("Fun questions", ...["reading", "favoriteTitle", "languages", "coffeeTea", "askMe", "funFact"].map(textField)),
      row(
        h("button", { type: "button", className: "buzz-button", "data-variant": "prominent", style: variantText("prominent"), onClick: save }, "Save profile"),
        state ? h("span", { className: "buzz-field-description" }, state) : null,
      ),
    );
  }

  function describe(p) {
    const parts = [];
    if (p.title) parts.push(p.title);
    if (p.departments?.length) parts.push(p.departments.map((d) => `@${d}`).join(" "));
    if (p.birthday) {
      const [m, d] = p.birthday.split("-");
      parts.push(`🎂 ${Number(d)} ${MONTHS[Number(m) - 1]}`);
    }
    if (p.since) parts.push(`At Clavis since ${p.since}`);
    if (p.days) parts.push(WEEKDAYS.map(([d, l]) => `${l} ${p.days[d] === "office" ? "🏢" : p.days[d] === "home" ? "🏠" : "–"}`).join(" "));
    return parts;
  }

  function Colleagues() {
    const [q, setQ] = React.useState("");
    const query = q.trim().toLowerCase();
    const rows = [...people.values()]
      .filter((x) => !query || JSON.stringify([x.name, x.profile]).toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name));
    return h(
      "div",
      null,
      h("p", null, input(q, setQ, { placeholder: "Search: a name, @studio, office, a book..." })),
      rows.length
        ? rows.map((x) =>
            h("div", { key: x.name + x.createdAt, className: "ui-card", style: { padding: "var(--space-2)", marginBottom: "var(--space-2)" } },
              h("strong", null, x.name),
              describe(x.profile).map((line, i) => h("div", { key: i, style: { fontSize: "13px" } }, line)),
              TEXT_FIELDS.slice(1)
                .filter(([key]) => x.profile[key])
                .map(([key, label]) => h("div", { key, style: { fontSize: "13px" } }, `${label}: ${x.profile[key]}`)),
            ),
          )
        : h("p", null, people.size ? "Nobody matches." : "Nobody has filled in a profile yet."),
    );
  }

  // ── Polls: create form (composer button) and poll card (message) ─────
  // Isolated: if this fails, poll messages show as plain text and the rest works.
  const MAX_POLL_TEXT = 120;
  function PollForm({ onCreate, onCancel }) {
    const [question, setQuestion] = React.useState("");
    const [options, setOptions] = React.useState(["", ""]);
    const [anonymous, setAnonymous] = React.useState(false);
    const [multiple, setMultiple] = React.useState(false);
    const [closing, setClosing] = React.useState("ongoing");
    const [closesAt, setClosesAt] = React.useState("");
    const [error, setError] = React.useState("");
    const setOption = (i, v) => setOptions((o) => o.map((x, j) => (j === i ? v : x)));
    const create = () => {
      const opts = options.map((o) => oneLine(o, MAX_POLL_TEXT)).filter(Boolean);
      if (!oneLine(question, 200)) return setError("Write a question.");
      if (opts.length < 2) return setError("Add at least two options.");
      let at;
      if (closing === "date") {
        at = closesAt ? new Date(closesAt).getTime() : NaN;
        if (!Number.isFinite(at) || at <= Date.now()) return setError("Choose a closing date and time in the future.");
      }
      onCreate(buildPollText({ question, options: opts, anonymous, multiple, closesAt: at }));
    };
    const choice = (active, label, onClick) =>
      h("button", { type: "button", className: "buzz-button", "data-size": "sm", "data-variant": active ? "prominent" : "glass", style: variantText(active ? "prominent" : "glass"), "aria-pressed": active, onClick }, label);
    return h(
      "div",
      { style: { display: "grid", gap: "var(--space-4, 1rem)" } },
      h("h3", { style: { margin: 0 } }, "📊 New poll"),
      field("Question", input(question, setQuestion, { maxLength: 200, autoFocus: true })),
      field(
        "Options",
        h(
          "div",
          { style: { display: "grid", gap: "var(--space-2)" } },
          options.map((o, i) =>
            h("div", { key: i, style: { display: "flex", gap: "var(--space-2)" } },
              input(o, (v) => setOption(i, v), { maxLength: MAX_POLL_TEXT, placeholder: `Option ${i + 1}` }),
              options.length > 2
                ? h("button", { type: "button", className: "buzz-button", "data-size": "sm", "data-variant": "glass", style: variantText("glass"), "aria-label": `Remove option ${i + 1}`, onClick: () => setOptions((x) => x.filter((_, j) => j !== i)) }, "✕")
                : null),
          ),
          options.length < POLL_MAX_OPTIONS
            ? h("div", null, h("button", { type: "button", className: "buzz-button", "data-size": "sm", "data-variant": "glass", style: variantText("glass"), onClick: () => setOptions((x) => [...x, ""]) }, "+ Add option"))
            : null,
        ),
      ),
      field("Type", row(choice(!anonymous, "👁 Open (names visible)", () => setAnonymous(false)), choice(anonymous, "🔒 Anonymous (totals only)", () => setAnonymous(true)))),
      field("Answers", row(choice(!multiple, "One choice", () => setMultiple(false)), choice(multiple, "Multiple choices", () => setMultiple(true)))),
      field(
        "Closing",
        row(
          choice(closing === "ongoing", "Ongoing", () => setClosing("ongoing")),
          choice(closing === "date", "Closes on…", () => setClosing("date")),
          closing === "date" ? input(closesAt, setClosesAt, { type: "datetime-local", style: { width: "auto" } }) : null,
        ),
        "You can always close your poll yourself, too.",
      ),
      error ? h("span", { className: "buzz-field-error" }, error) : null,
      row(
        h("button", { type: "button", className: "buzz-button", "data-variant": "prominent", style: variantText("prominent"), onClick: create }, "Add poll to message"),
        h("button", { type: "button", className: "buzz-button", "data-variant": "glass", style: variantText("glass"), onClick: onCancel }, "Cancel"),
      ),
    );
  }

  // Outline bar-chart icon (Lucide-style: 24×24, 2px stroke, round caps) in
  // currentColor, so it matches Buzz's other composer icons in every theme.
  // Profile photo of a voter (open polls only). Same rules as Buzz itself
  // (shared/avatar-source.ts): only https URLs without credentials, or small raster
  // data: images; anything else falls back to initials.
  function avatarSrc(value) {
    if (typeof value !== "string") return undefined;
    const s = value.trim();
    if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/]+=*$/.test(s)) return s.length <= 512 * 1024 ? s : undefined;
    if (s.length > 2048) return undefined;
    try {
      const url = new URL(s);
      if (url.protocol === "https:" && !url.username && !url.password) return url.href;
    } catch {}
    return undefined;
  }
  const initials = (name) =>
    (String(name).trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join("") || "?").toUpperCase();
  const AVATAR_PX = 22;
  const AVATARS_SHOWN = 5;
  function VoterAvatar({ voter, index }) {
    const [broken, setBroken] = React.useState(false);
    const src = broken ? undefined : avatarSrc(voter.picture);
    const style = {
      width: `${AVATAR_PX}px`, height: `${AVATAR_PX}px`, borderRadius: "50%", flex: "none", objectFit: "cover",
      marginLeft: index ? `-${AVATAR_PX / 3}px` : 0, boxShadow: "0 0 0 2px var(--surface-raised, var(--surface, #fff))",
      display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "10px", fontWeight: 600,
      background: "var(--surface-inset, rgba(127,127,127,0.25))", color: "inherit", overflow: "hidden",
    };
    return src
      ? h("img", { src, alt: voter.name, title: voter.name, style, loading: "lazy", referrerPolicy: "no-referrer", onError: () => setBroken(true) })
      : h("span", { title: voter.name, "aria-label": voter.name, style }, initials(voter.name));
  }
  function VoterAvatars({ voters }) {
    if (!voters.length) return null;
    const extra = voters.length - AVATARS_SHOWN;
    return h(
      "span",
      { style: { position: "relative", display: "inline-flex", alignItems: "center" }, title: voters.map((v) => v.name).join(", ") },
      voters.slice(0, AVATARS_SHOWN).map((v, i) => h(VoterAvatar, { key: v.pk, voter: v, index: i })),
      extra > 0 ? h("span", { style: { marginLeft: "4px", fontSize: "12px", opacity: 0.8 } }, `+${extra}`) : null,
    );
  }

  const pollIcon = () =>
    h(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        width: 18,
        height: 18,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
        focusable: "false",
      },
      h("path", { d: "M3 3v16a2 2 0 0 0 2 2h16" }),
      h("rect", { x: 7, y: 12, width: 3, height: 5, rx: 1 }),
      h("rect", { x: 12.5, y: 8, width: 3, height: 9, rx: 1 }),
      h("rect", { x: 18, y: 4, width: 3, height: 13, rx: 1 }),
    );

  function PollTool(props) {
    const [open, setOpen] = React.useState(false);
    return h(
      React.Fragment,
      null,
      h("button", {
        type: "button",
        className: "buzz-button",
        "data-variant": "glass-ghost",
        "data-button-shape": "control",
        title: "Create a poll",
        "aria-label": "Create a poll",
        disabled: props.disabled,
        onClick: () => setOpen(true),
        style: { ...variantText("glass"), paddingInline: "var(--space-2)" },
      }, pollIcon()),
      open
        ? h(
            "div",
            {
              role: "dialog",
              "aria-label": "New poll",
              style: { position: "fixed", inset: 0, background: "color-mix(in srgb, var(--surface-panel, #000) 30%, rgba(0,0,0,0.55))", display: "grid", placeItems: "center", zIndex: 1000, padding: "1rem" },
              onClick: (e) => e.target === e.currentTarget && setOpen(false),
              onKeyDown: (e) => e.key === "Escape" && setOpen(false),
            },
            h(
              "div",
              { className: "ui-card", style: { width: "min(32rem, 100%)", maxHeight: "90vh", overflow: "auto", padding: "var(--space-panel-inset, 1.25rem)", background: "var(--surface-panel)" } },
              h(PollForm, {
                onCancel: () => setOpen(false),
                onCreate: (text) => {
                  setOpen(false);
                  props.insertText(text);
                  props.focus?.();
                },
              }),
            ),
          )
        : null,
    );
  }

  function PollCard({ message }) {
    const poll = React.useMemo(() => parsePoll(message.content), [message.content]);
    const id = message.id;
    const c = currentConnection();
    const session = c?.session;
    const viewer = session?.viewer;
    const [data, setData] = React.useState({ votes: new Map(), tally: null, closedAt: null, loaded: false });
    const [mine, setMine] = React.useState(() => {
      try {
        return JSON.parse(localStorage.getItem(`clavis.poll.vote:${id}`) ?? "null");
      } catch {
        return null;
      }
    });
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [, tick] = React.useReducer((n) => n + 1, 0);
    // Anonymous: own vote sent but not yet in the bot's totals ({ since, prev, next }).
    const [pending, setPending] = React.useState(null);

    const load = React.useCallback(async () => {
      if (!session || !poll) return;
      try {
        const [voteEvents, closeEvents, tallyEvents] = await Promise.all([
          readEvents(session, { kinds: [PROFILE_KIND], "#d": [`clavis-vote:${id}`], limit: 500 }),
          readEvents(session, { kinds: [PROFILE_KIND], authors: [message.authorId], "#d": [`clavis-poll-close:${id}`], limit: 5 }),
          poll.anonymous
            ? readEvents(session, { kinds: [PROFILE_KIND], authors: [POLL_BOT_PUBKEY], "#d": [`clavis-tally:${id}`], limit: 5 })
            : Promise.resolve([]),
        ]);
        const votes = new Map();
        for (const e of voteEvents) {
          if (e?.kind !== PROFILE_KIND || !e.tags?.some((t) => t[0] === "d" && t[1] === `clavis-vote:${id}`)) continue;
          const prev = votes.get(e.pubkey);
          if (prev && prev.at >= e.created_at) continue;
          let body = {};
          try {
            body = JSON.parse(e.content);
          } catch {}
          const choices = Array.isArray(body.choices)
            ? [...new Set(body.choices.filter((n) => Number.isInteger(n) && n >= 0 && n < poll.options.length))].sort()
            : null;
          votes.set(e.pubkey, { at: e.created_at, choices: poll.multiple ? choices : choices?.slice(0, 1), encrypted: !!body.enc });
        }
        const closedAt = closeEvents
          .filter((e) => e?.pubkey === message.authorId)
          .reduce((min, e) => (min == null || e.created_at < min ? e.created_at : min), null);
        let tally = null;
        for (const e of tallyEvents) {
          if (e?.pubkey !== POLL_BOT_PUBKEY) continue;
          try {
            const t = JSON.parse(e.content);
            if (t.poll === id && Array.isArray(t.counts) && (!tally || e.created_at > tally.at)) tally = { ...t, at: e.created_at };
          } catch {}
        }
        const ids = [...votes.keys()];
        if (!poll.anonymous && ids.length) {
          try {
            await session.profiles.ensure(ids);
          } catch {}
        }
        setData({ votes, tally, closedAt, loaded: true });
        setError("");
        setStatus("polls", "ok");
      } catch (e) {
        setError(`Could not load votes: ${e?.message ?? e}`);
      }
    }, [session, poll, id, message.authorId]);

    // Faster refresh while an anonymous vote is being counted.
    const pendingOpen = !!pending && !(data.tally && data.tally.at >= pending.since) && Date.now() / 1000 - pending.since < 60;
    const refreshMs = pendingOpen ? 3000 : poll?.anonymous ? 10000 : POLL_REFRESH_MS;
    React.useEffect(() => {
      void load();
      const timer = setInterval(() => void load(), refreshMs);
      const clock = setInterval(tick, 30000); // re-check the closing time
      return () => {
        clearInterval(timer);
        clearInterval(clock);
      };
    }, [load, refreshMs]);

    if (!poll) return h("p", null, message.content);
    const now = Date.now() / 1000;
    const closeAt = [poll.closes, data.closedAt].filter((x) => x != null).reduce((a, b) => Math.min(a, b), Infinity);
    const closed = now >= closeAt || !!data.tally?.closed;

    // Counts: open polls count here; anonymous polls use the bot's totals.
    let counts = poll.options.map(() => 0);
    let voters = 0;
    const names = poll.options.map(() => []);
    const faces = poll.options.map(() => []); // open polls: { pk, name, picture } per option
    const profileNames = session?.profiles?.snapshot?.() ?? new Map();
    if (poll.anonymous) {
      if (data.tally && data.tally.counts.length === counts.length) {
        counts = data.tally.counts.map((n) => (Number.isInteger(n) && n >= 0 ? n : 0));
        voters = Number(data.tally.voters) || 0;
      }
      // Until the bot has counted your new vote, move it here already.
      if (pendingOpen) {
        for (const n of pending.prev) if (counts[n] > 0) counts[n]--;
        for (const n of pending.next) counts[n]++;
        if (!pending.prev.length && pending.next.length) voters++;
        if (pending.prev.length && !pending.next.length) voters = Math.max(0, voters - 1);
      }
    } else {
      for (const [pk, v] of data.votes) {
        if (v.encrypted || !v.choices?.length || v.at > closeAt) continue;
        voters++;
        for (const n of v.choices) {
          counts[n]++;
          const name = pk === viewer ? "you" : profileNames.get(pk)?.name ?? pk.slice(0, 8);
          names[n].push(name);
          faces[n].push({ pk, name: pk === viewer ? profileNames.get(pk)?.name ?? "you" : name, picture: profileNames.get(pk)?.picture });
        }
      }
    }
    // Anonymous: your own choice is only known on this device (it is encrypted for the bot).
    const myChoices = poll.anonymous ? mine?.choices ?? [] : data.votes.get(viewer)?.choices ?? [];
    const total = poll.multiple ? Math.max(voters, 1) : Math.max(counts.reduce((a, b) => a + b, 0), 1);
    const isAuthor = viewer && viewer === message.authorId;

    const vote = async (choices) => {
      if (!session || closed || busy) return;
      setBusy(true);
      setError("");
      try {
        const body = poll.anonymous
          ? { v: 1, poll: id, enc: await encryptVote(id, choices) }
          : { v: 1, poll: id, choices };
        await publishOwn(session, `clavis-vote:${id}`, JSON.stringify(body));
        if (poll.anonymous) {
          setPending({ since: Math.floor(Date.now() / 1000), prev: myChoices, next: choices });
          const saved = { choices };
          try {
            localStorage.setItem(`clavis.poll.vote:${id}`, JSON.stringify(saved));
          } catch {}
          setMine(saved);
        }
        setData((d) => {
          const votes = new Map(d.votes);
          votes.set(viewer, { at: Math.floor(Date.now() / 1000), choices, encrypted: poll.anonymous });
          return { ...d, votes };
        });
        setTimeout(() => void load(), poll.anonymous ? 3000 : 1500);
      } catch (e) {
        setError(`Your vote was not saved: ${e?.message ?? e}`);
      } finally {
        setBusy(false);
      }
    };
    const toggle = (n) => {
      if (poll.multiple) vote(myChoices.includes(n) ? myChoices.filter((x) => x !== n) : [...myChoices, n].sort());
      else vote(myChoices[0] === n ? [] : [n]);
    };
    const closePoll = async () => {
      if (!session || busy) return;
      setBusy(true);
      try {
        await publishOwn(session, `clavis-poll-close:${id}`, JSON.stringify({ v: 1, poll: id }));
        setData((d) => ({ ...d, closedAt: Math.floor(Date.now() / 1000) }));
      } catch (e) {
        setError(`Could not close the poll: ${e?.message ?? e}`);
      } finally {
        setBusy(false);
      }
    };

    const fmt = (t) => new Date(t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const meta = [
      poll.anonymous ? "🔒 Anonymous" : "👁 Open",
      poll.multiple ? "multiple choices" : "one choice",
      closed ? `closed${Number.isFinite(closeAt) ? ` ${fmt(Math.min(closeAt, now))}` : ""}` : poll.closes ? `closes ${fmt(poll.closes)}` : "ongoing",
    ].join(" · ");

    return h(
      "div",
      { className: "ui-card", style: { display: "grid", gap: "var(--space-3, 0.75rem)", padding: "var(--space-4, 1rem)", maxWidth: "34rem", marginTop: "var(--space-1)" } },
      h(
        "div",
        null,
        h("strong", { style: { display: "inline-flex", alignItems: "center", gap: "var(--space-2)" } }, pollIcon(), poll.question),
        h("div", { className: "buzz-field-description" }, meta),
      ),
      poll.options.map((label, n) => {
        const pct = Math.round((counts[n] / total) * 100);
        const chosen = myChoices.includes(n);
        return h(
          "button",
          {
            key: n,
            type: "button",
            disabled: closed || busy || !session,
            onClick: () => toggle(n),
            "aria-pressed": chosen,
            title: !poll.anonymous && names[n].length ? names[n].join(", ") : undefined,
            style: {
              position: "relative", display: "flex", justifyContent: "space-between", gap: "var(--space-2)", alignItems: "center",
              width: "100%", textAlign: "left", padding: "var(--space-2) var(--space-3, 0.75rem)", overflow: "hidden",
              borderRadius: "var(--radius-control, 8px)", border: `1px solid ${chosen ? "var(--affordance-prominent)" : "var(--interaction-border, rgba(127,127,127,0.35))"}`,
              background: "var(--surface-inset, transparent)", color: "inherit", cursor: closed ? "default" : "pointer", font: "inherit",
            },
          },
          h("span", { "aria-hidden": true, style: { position: "absolute", inset: 0, width: `${pct}%`, background: "var(--affordance-prominent)", opacity: 0.18, transition: "width 300ms ease" } }),
          h("span", { style: { position: "relative" } }, `${chosen ? (poll.multiple ? "☑ " : "◉ ") : poll.multiple ? "☐ " : "○ "}${label}`),
          h(
            "span",
            { style: { position: "relative", display: "inline-flex", alignItems: "center", gap: "var(--space-2)", flex: "none" } },
            poll.anonymous ? null : h(VoterAvatars, { voters: faces[n] }),
            h("span", { style: { whiteSpace: "nowrap", opacity: 0.8, fontSize: "13px" } }, `${counts[n]} · ${pct}%`),
          ),
        );
      }),
      !poll.anonymous && voters
        ? h("div", { className: "buzz-field-description" }, poll.options.map((label, n) => (names[n].length ? `${label}: ${names[n].join(", ")}` : null)).filter(Boolean).join(" · "))
        : null,
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center", justifyContent: "space-between" } },
        h("span", { className: "buzz-field-description" },
          `${voters} ${voters === 1 ? "vote" : "votes"}` + (busy ? " · saving…" : pendingOpen ? " · updating…" : "")),
        h("span", { style: { display: "flex", gap: "var(--space-2)" } },
          myChoices.length && !closed ? h("button", { type: "button", className: "buzz-button", "data-size": "sm", "data-variant": "glass", style: variantText("glass"), disabled: busy, onClick: () => vote([]) }, "Withdraw vote") : null,
          isAuthor && !closed ? h("button", { type: "button", className: "buzz-button", "data-size": "sm", "data-variant": "glass", style: variantText("glass"), disabled: busy, onClick: closePoll }, "Close poll") : null),
      ),
      error ? h("span", { className: "buzz-field-error" }, error) : null,
    );
  }

  try {
    const conversation = ctx.reflect?.get?.("conversation");
    if (typeof conversation?.registerMessage !== "function" || typeof conversation?.registerTool !== "function")
      throw new Error("this Buzz version cannot show polls");
    conversation.registerMessage({
      id: "poll",
      title: "Poll",
      matches: (message) => {
        try {
          return !!parsePoll(message?.content);
        } catch {
          return false;
        }
      },
      component: PollCard,
    });
    conversation.registerTool({ id: "poll", title: "Poll", order: 50, component: PollTool });
    if (status.polls === "starting") setStatus("polls", "ok");
  } catch (error) {
    setStatus("polls", `off: ${error?.message ?? error}`);
  }

  // ── Profile panel: show the Clavis profile under "Info" ───────────────
  // Buzz's documented way: a panel that specializes person profiles, renders
  // Buzz's own profile panel and adds content through renderPersonInfo. Agent
  // profiles and history targets stay with Buzz's own panel. Isolated: if this
  // fails, Buzz's normal profile panel is shown as usual.
  function ClavisInfo({ pubkey }) {
    const [, force] = React.useReducer((n) => n + 1, 0);
    React.useEffect(() => {
      listeners.add(force);
      return () => listeners.delete(force);
    }, []);
    const p = people.get(pubkey)?.profile;
    if (!p || !Object.keys(p).length) return null;
    const line = (label, value, key) =>
      value
        ? h(
            "div",
            { key: key ?? label, style: { display: "grid", gap: "2px" } },
            h("span", { className: "buzz-field-description" }, label),
            h("span", null, value),
          )
        : null;
    let birthday;
    if (p.birthday) {
      const [m, d] = p.birthday.split("-");
      birthday = `🎂 ${Number(d)} ${MONTHS[Number(m) - 1]}`;
    }
    let since;
    if (p.since) {
      const [y, m] = p.since.split("-");
      since = `${MONTHS[Number(m) - 1]} ${y}`;
    }
    const days = p.days
      ? WEEKDAYS.map(([d, l]) => `${l} ${p.days[d] === "office" ? "🏢" : p.days[d] === "home" ? "🏠" : "–"}`).join("  ")
      : undefined;
    return h(
      "div",
      {
        className: "ui-card",
        style: { display: "grid", gap: "var(--space-3, 0.75rem)", padding: "var(--space-4, 1rem)", marginBottom: "var(--space-3, 0.75rem)" },
      },
      line("Job title", p.title),
      line("Departments", p.departments?.length ? p.departments.map((d) => `@${d}`).join("  ") : undefined),
      line("At Clavis since", since),
      line("Office or home", days),
      line("Birthday", birthday),
      ...TEXT_FIELDS.filter(([key]) => key !== "title").map(([key, label]) => line(label, p[key], key)),
    );
  }

  try {
    const panels = ctx.reflect?.get?.("panels");
    if (typeof panels?.register !== "function") throw new Error("no panels in this Buzz version");
    const personKey = (target) => {
      if (typeof target !== "string" || !/^nostr:npub1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(target)) return undefined;
      return npubToHex(target.slice(6));
    };
    panels.register({
      id: "profile",
      title: "Profile",
      order: -10,
      matches: (target) => {
        try {
          return !!personKey(target);
        } catch {
          return false;
        }
      },
      component: Object.assign(
        function ClavisProfilePanel(props) {
          const pubkey = personKey(props.target);
          let Native;
          try {
            Native = panels.snapshot?.().find((panel) => panel.key === "buzz.profiles/profile")?.component;
          } catch {}
          if (Native && Native.supportsPersonInfoContent)
            return h(Native, {
              ...props,
              renderPersonInfo: (content) => h(React.Fragment, null, h(ClavisInfo, { pubkey }), content),
            });
          if (Native) return h(Native, props);
          // Buzz's Profiles plugin is off: show at least the Clavis profile.
          return h("div", { style: { padding: "var(--space-panel-inset)" } }, h(ClavisInfo, { pubkey }));
        },
        { profileHistory: true },
      ),
    });
  } catch (error) {
    note(`Profile panel unavailable (${error?.message ?? error}); Buzz's own profile panel is used.`);
  }

  // Settings → "Clavis profile": the profile form where people expect it, next to
  // Buzz's own Profile. Optional and isolated: without it, the form stays on the page.
  const SETTINGS_SECTION = "clavis.team-sections/profile";
  let settingsCard = false;
  try {
    const cards = ctx.reflect?.get?.("settingsCards");
    if (typeof cards?.register !== "function") throw new Error("no settings cards in this Buzz version");
    cards.register({
      id: "profile",
      title: "Clavis profile",
      component: function ClavisProfileSettings() {
        const [, force] = React.useReducer((n) => n + 1, 0);
        React.useEffect(() => {
          listeners.add(force);
          const off = relay.subscribe(force);
          return () => {
            listeners.delete(force);
            off();
          };
        }, []);
        const c = currentConnection();
        if (!c) return h("p", null, `Connect to ${COMMUNITY_HOST} to edit your Clavis profile.`);
        if (status.profiles === "starting") return h("p", null, "Loading your profile...");
        return h(
          "div",
          null,
          h(MyProfile, { connection: c, key: `${c.scope}:${people.get(c.session.viewer)?.createdAt ?? 0}` }),
        );
      },
    });
    settingsCard = true;
  } catch (error) {
    note(`Settings card unavailable (${error?.message ?? error}); the profile form stays on the plugin page.`);
  }
  const openSettings = async () => {
    try {
      const nav = ctx.reflect?.get?.("navigation");
      const result = await nav?.open?.({ version: 1, kind: "settings", section: SETTINGS_SECTION });
      if (result?.status !== "opened") note("Could not open Settings; use Settings → Clavis profile.");
    } catch {
      note("Could not open Settings; use Settings → Clavis profile.");
    }
  };

  // Unread counters: a red pill with the number of unread messages (99+ above
  // 99) on every channel and DM row in the sidebar, instead of Buzz's white,
  // bold row. Buzz 1.0 itself only makes the row bold. The number is Buzz's
  // own count (session.unread), the same one it uses for the bold row. Muted
  // channels only get a counter for mentions. Isolated like the other features.
  try {
    const STYLE_ID = "clavis-unread-style";
    const BADGE = "clavis-unread-count";
    const ROW = "[data-channel-sidebar-row]";
    const BUTTON = "button[data-channel-id]";
    if (typeof document === "undefined" || typeof MutationObserver === "undefined")
      throw new Error("no DOM access in this Buzz version");
    ctx.effect(() => {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
.${BADGE} {
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0; box-sizing: border-box;
  min-width: 1.125rem; height: 1.125rem; padding: 0 0.3125rem;
  margin-inline-start: auto; border-radius: 999px;
  background: #e5242b !important; color: #fff !important;
  font-size: 0.6875rem; font-weight: 700 !important; line-height: 1;
  font-variant-numeric: tabular-nums; pointer-events: none;
}
/* No white, bold row: the red counter shows that there is something new. */
${ROW}[data-clavis-unread] ${BUTTON} span:not(.${BADGE}):not([data-channel-row-icon]):not([data-channel-row-icon] *):not([role="img"]) {
  color: inherit !important; font-weight: inherit !important;
}
/* The counter replaces Buzz's small mention dot on the same row. */
${ROW}[data-clavis-unread] [data-channel-priority] { display: none !important; }
`;
      document.getElementById(STYLE_ID)?.remove();
      document.head.appendChild(style);

      const subs = new Map(); // channelId -> unsubscribe
      let session;
      let frame = 0;
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(paint);
      };
      const clearSubs = () => {
        subs.forEach((off) => { try { off(); } catch {} });
        subs.clear();
      };
      const mutedIds = () => {
        try {
          const s = session?.sidebarPreferences?.snapshot?.();
          return new Set(s?.data?.muted ?? []);
        } catch {
          return new Set();
        }
      };
      // Number to show for one row, or 0 for none.
      const countFor = (row, button, channelId, muted) => {
        const unread = session?.unread;
        if (typeof unread?.snapshot === "function") {
          const target = { kind: "channel", channelId };
          if (!subs.has(channelId) && typeof unread.subscribe === "function")
            subs.set(channelId, unread.subscribe(target, schedule));
          const snap = unread.snapshot(target);
          const shown = snap.row ?? snap;
          const count = shown.observedCount ?? 0;
          const attention = shown.attentionCount ?? 0;
          if (muted) return attention;
          if (count > 0) return count;
          return snap.manual && snap.manual !== "none" ? 1 : 0;
        }
        // Fallback: Buzz's own accessible label, "12 observed unread messages…".
        const marker = button.querySelector("[data-channel-unread]:not([data-channel-muted])");
        if (!marker) return 0;
        const n = /^(\d+)/.exec(marker.getAttribute("aria-label") ?? "");
        return n ? Number(n[1]) : 1;
      };
      function paint() {
        frame = 0;
        const c = relay.snapshot();
        const next = c.status === "ready" ? c.session : undefined;
        if (next !== session) {
          clearSubs();
          session = next;
        }
        const muted = mutedIds();
        const seen = new Set();
        for (const row of document.querySelectorAll(ROW)) {
          const button = row.querySelector(BUTTON);
          if (!button) continue;
          const channelId = button.getAttribute("data-channel-id");
          let n = 0;
          try {
            seen.add(channelId);
            n = countFor(row, button, channelId, muted.has(channelId));
          } catch {}
          let badge = button.querySelector(`:scope > .${BADGE}`);
          if (n > 0 && button.getAttribute("aria-current") !== "page") {
            const text = n > 99 ? "99+" : String(n);
            if (!badge) {
              badge = document.createElement("span");
              badge.className = BADGE;
              badge.setAttribute("aria-hidden", "true");
              button.appendChild(badge);
            }
            if (badge.textContent !== text) badge.textContent = text;
            if (!row.hasAttribute("data-clavis-unread")) row.setAttribute("data-clavis-unread", "");
          } else {
            badge?.remove();
            if (row.hasAttribute("data-clavis-unread")) row.removeAttribute("data-clavis-unread");
          }
        }
        // Stop listening to channels that left the sidebar.
        for (const [id, off] of subs) if (!seen.has(id)) { try { off(); } catch {} subs.delete(id); }
      }

      // Rows come and go as people scroll, switch community or open sections.
      // Our own changes are ignored, so this never loops.
      const observer = new MutationObserver((records) => {
        for (const r of records) {
          const nodes = [...r.addedNodes, ...r.removedNodes];
          if (r.type === "attributes" || nodes.some((n) => !(n.classList?.contains(BADGE) || n.parentElement?.classList?.contains(BADGE))))
            return schedule();
        }
      });
      observer.observe(document.body, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ["data-ordinary", "aria-current", "data-channel-id"],
      });
      const offRelay = relay.subscribe(schedule);
      schedule();
      setStatus("unread", "ok");
      return () => {
        observer.disconnect();
        offRelay?.();
        clearSubs();
        if (frame) cancelAnimationFrame(frame);
        document.querySelectorAll(`.${BADGE}`).forEach((b) => b.remove());
        document.querySelectorAll("[data-clavis-unread]").forEach((r) => r.removeAttribute("data-clavis-unread"));
        style.remove();
      };
    });
  } catch (error) {
    setStatus("unread", `off: ${error?.message ?? error}`);
  }

  ctx.pages.register({
    id: "main",
    title: "Clavis team",
    primary: true,
    component: function TeamPage() {
      const [, force] = React.useReducer((n) => n + 1, 0);
      const [tab, setTab] = React.useState("profile");
      React.useEffect(() => {
        listeners.add(force);
        const off = relay.subscribe(force);
        return () => {
          listeners.delete(force);
          off();
        };
      }, []);
      const c = currentConnection();
      const tabButton = (id, label) =>
        h("button", { type: "button", onClick: () => setTab(id), "aria-pressed": tab === id, style: { marginRight: "var(--space-2)", fontWeight: tab === id ? 700 : 400 } }, label);
      let body;
      if (!c) body = h("p", null, `Not connected to ${COMMUNITY_HOST}.`);
      else if (tab === "profile")
        body = settingsCard
          ? h(
              "div",
              null,
              h("p", null, "Your Clavis profile is in Settings, next to your Buzz profile."),
              h("p", null, h("button", { type: "button", onClick: openSettings }, "Open Settings → Clavis profile")),
            )
          : h(MyProfile, { connection: c, key: `${c.scope}:${people.get(c.session.viewer)?.createdAt ?? 0}` });
      else if (tab === "colleagues") body = h(Colleagues);
      else
        body = h(
          "div",
          null,
          h("p", null, h("button", { type: "button", disabled: busy, onClick: () => run("Manual sync...") }, busy ? "Syncing..." : "Sync now")),
          h("ul", null, Object.keys(FEATURES).map((f) =>
            h("li", { key: f }, `${status[f] === "ok" ? "✅" : status[f] === "starting" ? "⏳" : "⚠️"} ${FEATURES[f]}: ${status[f]}`))),
          h("h3", null, "Tags"),
          h("ul", null, resolvedTags.map((t) =>
            h("li", { key: t.tag }, `@${t.tag} (${t.size}): ${t.recipients.map((r) => r.name).join(", ") || "–"}${t.tooMany ? ` ⚠️ only the first ${MAX_MENTIONS} are mentioned` : ""}`))),
          h("h3", null, "Log"),
          h("pre", { style: { whiteSpace: "pre-wrap", fontSize: "12px" } }, log.join("\n") || "(no activity yet)"),
        );
      return h(
        "section",
        { className: "ui-card", style: { padding: "var(--space-panel-inset)" } },
        h("h1", null, "Clavis team"),
        h("p", null, tabButton("profile", "My profile"), tabButton("colleagues", "Colleagues"), tabButton("status", "Status")),
        body,
      );
    },
  });
}
