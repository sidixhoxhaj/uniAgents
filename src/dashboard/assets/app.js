/* uniAgents dashboard — read-only view of a running session.
   Everything rendered here is fetched from the daemon. Nothing is invented:
   an empty section means there is genuinely no record of it yet. */

/* Injected by the server: the provider SVGs, inlined because the page CSP
   allows no external origin. */
const MARKS = window.__MARKS__ || { claude: "", codex: "" };


/* ---------------- live state ---------------- */
let ACCOUNTS = [];
let PARITY = [];
let SETTINGS = { language: 'en', theme: 'auto', notifications: {} };
let HISTORY = { month: '', daysInMonth: 30, calendar: [], models: [], projects: [], events: [] };
let TOTALS = { requests: 0, rotations: 0, inputTokens: 0, outputTokens: 0 };
let RUNNING = false;

/* A stable colour per account, so the same account keeps its identity across
   every view. Assigned by position in the pool rather than hashed, so two
   accounts can never collide on the same swatch. */
const PALETTE = ['var(--a1)', 'var(--a2)', 'var(--a3)', 'var(--a4)', 'var(--a5)'];
function colourFor(i) { return PALETTE[i % PALETTE.length]; }

const NOTIFS = [
  ['rotated', 'notif.rot', 'notif.rotD'],
  ['exhausted', 'notif.exh', 'notif.exhD'],
  ['reset', 'notif.reset', 'notif.resetD'],
  ['auth', 'notif.auth', 'notif.authD'],
];

const CMDS = [
  ['unicode', 'help.c1'],
  ['unicode --model opus', 'help.c2'],
  ['unicode usage', 'help.c3'],
  ['unicode status --check', 'help.c4'],
  ['unicode --port 4400', 'help.c5'],
  ['CLAUDE_CONFIG_DIR=~/.claude-work claude', 'help.c6'],
];

// Filled from /api/models, which reads what each CLI itself knows. These
// were hardcoded once and drifted: the list still named `claude-haiku-4.5`
// and `claude-fable-5.1`, neither of which is a real id, so the parity table
// offered models that could never answer. Never reintroduce a constant here.
let MODELS = [];
let ACTIVE_MODEL = null;
const CLAUDE_MODELS = () => MODELS.filter(m => m.kind === 'claude').map(m => m.id);
const GPT_MODELS = () => MODELS.filter(m => m.kind === 'codex').map(m => m.id);

/* ---------------- i18n ---------------- */
const I18N = {
  en:{
    'nav.overview':'Overview','nav.logs':'Logs','nav.settings':'Settings','nav.help':'Help',
    'ov.slug':"All your CLI agents in one place",'ov.intro':"Claude and Codex accounts already on this machine, pooled behind a single session — when one hits its limit, the next takes over and you keep working.",'ov.status':'Status','ov.next':'Next reset','ov.ofWork':"of {n} requests so far",'ov.left':"of the pool left",'ov.across':"across {n} accounts",'ov.free':"unused",'ov.refresh':"Refresh usage",'ov.profiles':'Profiles','ov.combined':'Combined usage',
    'ov.running':'Running','ov.idle':'No session','ov.pooled':'accounts pooled','ov.serving':'serving from',
    'ov.noSession':'Start one with unicode','ov.in':'in','ov.resetsNext':'resets next','st.ready':'eligible','st.exh':'exhausted',
    'w.5h':'5-hour','w.7d':'7-day','w.allow':'allowance','w.resets':'resets',
    'logs.daily':'Daily usage','logs.models':'Usage by model','logs.projects':'Usage by project',
    'logs.activity':'Activity','logs.tokens30':'tokens · last 30 days','prof.nameL':"Display name",'prof.nameH':"Shown instead of the email everywhere. Leave empty to use the email.",'prof.cancel':"Cancel",'prof.save':"Save",'prof.drag':"Drag to change rotation order",'ov.order':"Drag a profile to reorder the funnel. The top account serves first; when it hits its limit the next one takes over automatically.",'prof.rename':"Rename",'prof.renameP':"Name for this profile (leave empty to use the email):",'st.overageT':"This account has spent past its included quota and is now billing paid usage.",'st.off':"disabled",'prof.disable':"Remove from pool",'prof.enable':"Add to pool",'logs.peakHour':"busiest hour",'logs.peak':"busiest day",'logs.active':"active days",'logs.rel':"shaded against each account's own busiest day",'logs.none':"Nothing recorded yet",'logs.noData':"no data",'ov.noReset':"no reset reported",'logs.less':'less','logs.more':'more',
    'f.all':'All','f.session':'Session','f.rotation':'Rotation','f.config':'Config','f.error':'Error','f.general':'General',
    'set.accounts':'Accounts','set.scan':'Scan for accounts',
    'set.scanD':'Look for Claude and Codex logins already on this machine. Nothing is written — credentials stay where the official CLIs put them.',
    'set.scanning':"Scanning…",'set.scanAdded':"{n} new account(s) found",'set.scanGone':"{n} no longer available",'set.scanSame':"No change — {n} account(s) in the pool",'set.scanFail':"Could not scan. Is the session still running?",'set.scanB':'Scan now','set.multi':'Using several accounts',
    'set.multiD':'Each login needs its own config directory, or the second overwrites the first.',
    'set.guide':'Guide','set.parity':'Model parity',
    'set.model':'Starting model','set.modelD':'Every model the pool can serve. The one you pick is what new sessions start on.',
    'set.modelNote':'Applies to the next session, passed as --model. Inside a running session, /model switches freely and nothing here overrides it.',
    'set.modelNone':'No models found. Sign in with claude or codex, then scan.',
    'set.modelAuto':'Claude Code\u2019s own default','set.modelAutoD':'Pass no --model, and let Claude Code start on whatever it defaults to.',
    'set.modelUse':'Use','set.modelOn':'Active',
    'set.pClaude':"Claude model",'set.pGpt':"GPT model",'set.pAuto':"auto",'set.pAutoT':"Reasoning effort is chosen automatically to match the requested model.",'set.pEffort':"Effort",'set.pBoth':"Works both ways",'set.parityD':"Each row pairs two equivalent models. Whichever provider is serving, a request for one model is answered by its counterpart — so the mapping works in both directions.",
    'set.res':'Live resource usage',
    'set.resCpu':'CPU','set.resRam':'Memory','set.resPid':'PID','set.resUp':'Session uptime',
    
    
    'set.notif':'Notifications','set.data':'Data','set.export':'Export configuration',
    'set.exportD':'Profiles and settings as a file. Credentials are never included.','set.exportB':'Export',
    'set.import':'Import configuration','set.importD':'Restore settings from an exported file.','set.importB':'Import',
    
    
    
    'notif.rot':'Account rotated','notif.rotD':'When one account hands over to another.',
    'notif.exh':'Quota exhausted','notif.exhD':'When an account runs out of its included quota.',
    'notif.reset':'Window reset','notif.resetD':'When an account rejoins the pool.',
    'notif.auth':'Needs attention','notif.authD':'When an account needs re-authenticating.',
    'help.cmds':'Commands',
    'help.note':'uniAgents pools the accounts already on your machine. There is no login here — to add one, run <b>claude</b> or <b>codex</b> and sign in as usual, then scan again.',
    'help.c1':'Start a session. Accounts rotate automatically as limits are hit.',
    'help.c2':'Anything after the command is passed to claude untouched.',
    'help.c3':'Real subscription usage per account, in the terminal.',
    'help.c4':'List accounts and verify each credential is readable and unexpired.',
    'help.c5':'Use a different port if 4317 is taken.',
    'help.c6':'Log in a second account without overwriting the first.',
  },
  nl:{
    'nav.overview':'Overzicht','nav.logs':'Logboek','nav.settings':'Instellingen','nav.help':'Help',
    'ov.slug':"Al je CLI-agents op één plek",'ov.intro':"Claude- en Codex-accounts die al op deze machine staan, gebundeld achter één sessie — loopt de één tegen zijn limiet aan, dan neemt de volgende het over en werk je gewoon door.",'ov.status':'Status','ov.next':'Volgende reset','ov.ofWork':"van {n} verzoeken tot nu toe",'ov.left':"van de pool over",'ov.across':"over {n} accounts",'ov.free':"ongebruikt",'ov.refresh':"Verbruik verversen",'ov.profiles':'Profielen','ov.combined':'Totaal verbruik',
    'ov.running':'Actief','ov.idle':'Geen sessie','ov.pooled':'accounts gebundeld','ov.serving':'bediend door',
    'ov.noSession':'Start er een met unicode','ov.in':'over','ov.resetsNext':'reset als eerste','st.ready':'beschikbaar','st.exh':'uitgeput',
    'w.5h':'5 uur','w.7d':'7 dagen','w.allow':'tegoed','w.resets':'reset',
    'logs.daily':'Dagelijks verbruik','logs.models':'Verbruik per model','logs.projects':'Verbruik per project',
    'logs.activity':'Activiteit','logs.tokens30':'tokens · laatste 30 dagen','prof.nameL':"Weergavenaam",'prof.nameH':"Wordt overal getoond in plaats van het e-mailadres. Leeg laten voor het e-mailadres.",'prof.cancel':"Annuleren",'prof.save':"Opslaan",'prof.drag':"Sleep om de rotatievolgorde te wijzigen",'ov.order':"Sleep een profiel om de volgorde te wijzigen. Het bovenste account bedient eerst; zodra het zijn limiet bereikt, neemt het volgende automatisch over.",'prof.rename':"Hernoemen",'prof.renameP':"Naam voor dit profiel (leeg laten voor het e-mailadres):",'st.overageT':"Dit account is door zijn inbegrepen quotum heen en rekent nu betaald verbruik af.",'st.off':"uitgeschakeld",'prof.disable':"Uit pool halen",'prof.enable':"Aan pool toevoegen",'logs.peakHour':"drukste uur",'logs.peak':"drukste dag",'logs.active':"actieve dagen",'logs.rel':"geschaald op de drukste dag van elk account",'logs.none':"Nog niets vastgelegd",'logs.noData':"geen gegevens",'ov.noReset':"geen reset gemeld",'logs.less':'minder','logs.more':'meer',
    'f.all':'Alles','f.session':'Sessie','f.rotation':'Rotatie','f.config':'Config','f.error':'Fout','f.general':'Algemeen',
    'set.accounts':'Accounts','set.scan':'Zoek naar accounts',
    'set.scanD':"Zoek naar Claude- en Codex-logins die al op deze machine staan. Er wordt niets weggeschreven — inloggegevens blijven waar de officiële CLI's ze zetten.",
    'set.scanning':"Zoeken…",'set.scanAdded':"{n} nieuw(e) account(s) gevonden",'set.scanGone':"{n} niet meer beschikbaar",'set.scanSame':"Geen wijziging — {n} account(s) in de pool",'set.scanFail':"Zoeken mislukt. Loopt de sessie nog?",'set.scanB':'Nu zoeken','set.multi':'Meerdere accounts gebruiken',
    'set.multiD':'Elke login heeft een eigen configuratiemap nodig, anders overschrijft de tweede de eerste.',
    'set.guide':'Handleiding','set.parity':'Modelkoppeling',
    'set.model':'Startmodel','set.modelD':'Elk model dat de pool kan bedienen. Wat je kiest is waar nieuwe sessies mee starten.',
    'set.modelNote':'Geldt voor de volgende sessie, meegegeven als --model. Binnen een lopende sessie wisselt /model vrij en overschrijft dit niets.',
    'set.modelNone':'Geen modellen gevonden. Log in met claude of codex en scan daarna.',
    'set.modelAuto':'Claude Code\u2019s eigen standaard','set.modelAutoD':'Geen --model meegeven; Claude Code start met zijn eigen standaardmodel.',
    'set.modelUse':'Gebruik','set.modelOn':'Actief',
    'set.pClaude':"Claude-model",'set.pGpt':"GPT-model",'set.pAuto':"auto",'set.pAutoT':"De redeneerinspanning wordt automatisch afgestemd op het gevraagde model.",'set.pEffort':"Inspanning",'set.pBoth':"Werkt beide kanten op",'set.parityD':"Elke rij koppelt twee gelijkwaardige modellen. Welke provider ook bedient, een verzoek om het ene model wordt beantwoord door zijn tegenhanger — de koppeling werkt dus in beide richtingen.",
    'set.res':'Live systeemgebruik',
    'set.resCpu':'CPU','set.resRam':'Geheugen','set.resPid':'PID','set.resUp':'Sessieduur',
    
    
    'set.notif':'Meldingen','set.data':'Gegevens','set.export':'Configuratie exporteren',
    'set.exportD':'Profielen en instellingen als bestand. Inloggegevens worden nooit meegenomen.','set.exportB':'Exporteren',
    'set.import':'Configuratie importeren','set.importD':'Herstel instellingen uit een geëxporteerd bestand.','set.importB':'Importeren',
    
    
    
    'notif.rot':'Account gewisseld','notif.rotD':'Wanneer het ene account het overneemt van het andere.',
    'notif.exh':'Quotum op','notif.exhD':'Wanneer een account door zijn inbegrepen quotum heen is.',
    'notif.reset':'Venster gereset','notif.resetD':'Wanneer een account weer meedoet in de pool.',
    'notif.auth':'Aandacht nodig','notif.authD':'Wanneer een account opnieuw moet inloggen.',
    'help.cmds':"Commando's",
    'help.note':'uniAgents bundelt de accounts die al op je machine staan. Hier is geen login — om er een toe te voegen, start je <b>claude</b> of <b>codex</b> en log je normaal in, en zoek daarna opnieuw.',
    'help.c1':'Start een sessie. Accounts wisselen automatisch zodra limieten worden geraakt.',
    'help.c2':'Alles na het commando gaat ongewijzigd door naar claude.',
    'help.c3':'Werkelijk abonnementsverbruik per account, in de terminal.',
    'help.c4':'Toon accounts en controleer of elke inloggegeven leesbaar en geldig is.',
    'help.c5':'Gebruik een andere poort als 4317 bezet is.',
    'help.c6':'Log een tweede account in zonder de eerste te overschrijven.',
  },
  de:{
    'nav.overview':'Übersicht','nav.logs':'Protokoll','nav.settings':'Einstellungen','nav.help':'Hilfe',
    'ov.slug':"Alle deine CLI-Agents an einem Ort",'ov.intro':"Claude- und Codex-Konten, die bereits auf diesem Rechner sind, gebündelt hinter einer Sitzung — erreicht eines sein Limit, übernimmt das nächste und du arbeitest weiter.",'ov.status':'Status','ov.next':'Nächster Reset','ov.ofWork':"von bisher {n} Anfragen",'ov.left':"vom Pool übrig",'ov.across':"über {n} Konten",'ov.free':"ungenutzt",'ov.refresh':"Verbrauch aktualisieren",'ov.profiles':'Profile','ov.combined':'Gesamtverbrauch',
    'ov.running':'Läuft','ov.idle':'Keine Sitzung','ov.pooled':'Konten gebündelt','ov.serving':'bedient von',
    'ov.noSession':'Mit unicode starten','ov.in':'in','ov.resetsNext':'wird zuerst zurückgesetzt','st.ready':'verfügbar','st.exh':'erschöpft',
    'w.5h':'5 Stunden','w.7d':'7 Tage','w.allow':'Guthaben','w.resets':'Reset',
    'logs.daily':'Täglicher Verbrauch','logs.models':'Verbrauch nach Modell','logs.projects':'Verbrauch nach Projekt',
    'logs.activity':'Aktivität','logs.tokens30':'Tokens · letzte 30 Tage','prof.nameL':"Anzeigename",'prof.nameH':"Wird überall statt der E-Mail angezeigt. Leer lassen für die E-Mail.",'prof.cancel':"Abbrechen",'prof.save':"Speichern",'prof.drag':"Ziehen, um die Rotationsreihenfolge zu ändern",'ov.order':"Ziehe ein Profil, um die Reihenfolge zu ändern. Das oberste Konto bedient zuerst; erreicht es sein Limit, übernimmt automatisch das nächste.",'prof.rename':"Umbenennen",'prof.renameP':"Name für dieses Profil (leer lassen für die E-Mail):",'st.overageT':"Dieses Konto hat sein enthaltenes Kontingent überschritten und rechnet nun bezahlte Nutzung ab.",'st.off':"deaktiviert",'prof.disable':"Aus Pool entfernen",'prof.enable':"Zum Pool hinzufügen",'logs.peakHour':"stärkste Stunde",'logs.peak':"stärkster Tag",'logs.active':"aktive Tage",'logs.rel':"skaliert am stärksten Tag des jeweiligen Kontos",'logs.none':"Noch nichts aufgezeichnet",'logs.noData':"keine Daten",'ov.noReset':"kein Reset gemeldet",'logs.less':'weniger','logs.more':'mehr',
    'f.all':'Alle','f.session':'Sitzung','f.rotation':'Rotation','f.config':'Konfig','f.error':'Fehler','f.general':'Allgemein',
    'set.accounts':'Konten','set.scan':'Nach Konten suchen',
    'set.scanD':'Sucht nach Claude- und Codex-Logins, die bereits auf diesem Rechner sind. Es wird nichts geschrieben — Zugangsdaten bleiben dort, wo die offiziellen CLIs sie ablegen.',
    'set.scanning':"Suche…",'set.scanAdded':"{n} neue(s) Konto/Konten gefunden",'set.scanGone':"{n} nicht mehr verfügbar",'set.scanSame':"Keine Änderung — {n} Konto/Konten im Pool",'set.scanFail':"Suche fehlgeschlagen. Läuft die Sitzung noch?",'set.scanB':'Jetzt suchen','set.multi':'Mehrere Konten verwenden',
    'set.multiD':'Jeder Login braucht ein eigenes Konfigurationsverzeichnis, sonst überschreibt der zweite den ersten.',
    'set.guide':'Anleitung','set.parity':'Modellzuordnung',
    'set.model':'Startmodell','set.modelD':'Jedes Modell, das der Pool bedienen kann. Das gewählte ist, womit neue Sitzungen starten.',
    'set.modelNote':'Gilt für die nächste Sitzung, übergeben als --model. In einer laufenden Sitzung wechselt /model frei und nichts hier überschreibt das.',
    'set.modelNone':'Keine Modelle gefunden. Mit claude oder codex anmelden und dann scannen.',
    'set.modelAuto':'Claude Codes eigener Standard','set.modelAutoD':'Kein --model übergeben; Claude Code startet mit seinem eigenen Standardmodell.',
    'set.modelUse':'Verwenden','set.modelOn':'Aktiv',
    'set.pClaude':"Claude-Modell",'set.pGpt':"GPT-Modell",'set.pAuto':"auto",'set.pAutoT':"Der Reasoning-Aufwand wird automatisch passend zum angefragten Modell gewählt.",'set.pEffort':"Aufwand",'set.pBoth':"Gilt in beide Richtungen",'set.parityD':"Jede Zeile koppelt zwei gleichwertige Modelle. Welcher Anbieter auch bedient — eine Anfrage nach einem Modell wird von seinem Gegenstück beantwortet, die Zuordnung gilt also in beide Richtungen.",
    'set.res':'Live-Ressourcenverbrauch',
    'set.resCpu':'CPU','set.resRam':'Speicher','set.resPid':'PID','set.resUp':'Sitzungsdauer',
    
    
    'set.notif':'Benachrichtigungen','set.data':'Daten','set.export':'Konfiguration exportieren',
    'set.exportD':'Profile und Einstellungen als Datei. Zugangsdaten sind nie enthalten.','set.exportB':'Exportieren',
    'set.import':'Konfiguration importieren','set.importD':'Einstellungen aus einer exportierten Datei wiederherstellen.','set.importB':'Importieren',
    
    
    
    'notif.rot':'Konto gewechselt','notif.rotD':'Wenn ein Konto an ein anderes übergibt.',
    'notif.exh':'Kontingent erschöpft','notif.exhD':'Wenn ein Konto sein enthaltenes Kontingent aufgebraucht hat.',
    'notif.reset':'Fenster zurückgesetzt','notif.resetD':'Wenn ein Konto wieder im Pool verfügbar ist.',
    'notif.auth':'Aufmerksamkeit nötig','notif.authD':'Wenn ein Konto neu angemeldet werden muss.',
    'help.cmds':'Befehle',
    'help.note':'uniAgents bündelt die Konten, die bereits auf deinem Rechner sind. Hier gibt es keinen Login — um eines hinzuzufügen, starte <b>claude</b> oder <b>codex</b> und melde dich wie gewohnt an, dann erneut suchen.',
    'help.c1':'Startet eine Sitzung. Konten wechseln automatisch, sobald Limits erreicht werden.',
    'help.c2':'Alles nach dem Befehl wird unverändert an claude weitergereicht.',
    'help.c3':'Tatsächlicher Abonnementverbrauch pro Konto, im Terminal.',
    'help.c4':'Konten auflisten und prüfen, ob jede Zugangsdatei lesbar und gültig ist.',
    'help.c5':'Anderen Port verwenden, falls 4317 belegt ist.',
    'help.c6':'Ein zweites Konto anmelden, ohne das erste zu überschreiben.',
  },
};

let lang = 'en';
const t = (k) => I18N[lang][k] ?? I18N.en[k] ?? k;

/* ---------------- helpers ---------------- */

/** "14:32:09" from an ISO timestamp, for the activity feed. */
function clock(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
}

/** What an account is called: its alias when set, otherwise the daemon's label. */
function displayName(a) { return (a && (a.alias || a.label)) || ''; }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n) => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? Math.round(n/1e3)+'k' : String(n);
const num = (n) => n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toLocaleString('en-US',{maximumFractionDigits:2});
const width = (p) => p == null || p <= 0 ? '0' : Math.max(1.5, Math.min(100, p)) + '%';

function until(d){
  // The API sends ISO strings; some call sites pass a Date. Subtracting a
  // string yields NaN and the card silently reads "NaNd NaNh", so parse first.
  const at = d instanceof Date ? d : new Date(d);
  const ms = at.getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const m = Math.round(ms/6e4);
  if (m < 60) return m + 'm';
  const h = Math.floor(m/60);
  if (h < 24) return h + 'h ' + (m%60) + 'm';
  return Math.floor(h/24) + 'd ' + (h%24) + 'h';
}
function dayLabel(d){
  return d.toLocaleDateString(lang === 'en' ? 'en-US' : lang === 'nl' ? 'nl-NL' : 'de-DE',
    { month:'short', day:'numeric' });
}
/** "10–11" — the hour of day this account is busiest. */
function hourRange(h){
  if (h == null) return '—';
  const pad = (n) => String(n).padStart(2,'0');
  return `${pad(h)}–${pad((h+1)%24)}`;
}
/** Usage at or above this is exhausted; below it the account is eligible. */
const EXHAUSTED_AT = 95;

/** Usage decides it, and nothing else. Below the threshold an account is
 *  eligible; at or above it, exhausted. */
function isExhausted(a){
  return (a.usagePercent ?? 0) >= EXHAUSTED_AT;
}
function stateLabel(a){ return t(isExhausted(a) ? 'st.exh' : 'st.ready') }
function statePill(a){ return isExhausted(a) ? 'pill-bad' : 'pill-ok' }

/* ---------------- overview ---------------- */
function renderOverview(){
  const pool = ACCOUNTS.filter(a => a.enabled);
  const active = ACCOUNTS.find(a => a.active) ?? null;
  const withReset = pool.filter(a => a.resetsAt);
  const soonest = withReset.sort((a,b) => new Date(a.resetsAt) - new Date(b.resetsAt))[0] ?? null;

  document.getElementById('stat-row').innerHTML = `
    <div class="card stat">
      <div class="k"><span class="dot${RUNNING ? '' : ' idle'}"></span>${esc(t('ov.status'))}</div>
      <div class="v">${esc(t(RUNNING ? 'ov.running' : 'ov.idle'))}</div>
      <div class="s">${pool.length} ${esc(t('ov.pooled'))} · ${esc(t('ov.serving'))} ${esc(active ? displayName(active) : '—')}</div>
    </div>
    <div class="card stat">
      <div class="k">${esc(t('ov.next'))}</div>
      <div class="v num">${soonest ? esc(until(soonest.resetsAt)) : '—'}</div>
      <div class="s">${soonest
        ? `<span style="color:${soonest.colour}">●</span> ${esc(displayName(soonest))} · ${esc(t('ov.resetsNext'))}`
        : esc(t('ov.noReset'))}</div>
    </div>
    <div class="card stat">
      <div class="k">${esc(t('ov.profiles'))}</div>
      <div class="v num">${pool.length}<span style="font-size:13px;color:var(--faint);font-weight:500">${ACCOUNTS.length!==pool.length?` / ${ACCOUNTS.length}`:''}</span></div>
      <div class="s mini-av" style="margin-top:7px">
        ${ACCOUNTS.map(a => `<span style="background:color-mix(in srgb,${a.colour} 16%,transparent);color:${a.colour}">${MARKS[a.kind]}</span>`).join('')}
      </div>
    </div>`;

  document.getElementById('profiles').innerHTML = ACCOUNTS.map((a, i) => `
    <div class="card prof ${a.enabled && a.state==='active'?'active':''} ${a.enabled?'':'off'}"
         style="--c:${a.colour}" draggable="true" data-id="${a.id}">
      <div class="ptop">
        <span class="grip" title="${esc(t('prof.drag'))}">⠿</span>
        <span class="ord">${i + 1}</span>
        <div class="av">${MARKS[a.kind]}</div>
        <div style="min-width:0">
          <div class="pname">${esc(displayName(a))}${a.alias && a.email?`<span class="palias">${esc(a.email)}</span>`:''}</div>
          <div class="pplan">${esc(a.product)}${a.plan?' · '+esc(a.plan):''}</div>
        </div>

        <span class="pill ${a.enabled ? statePill(a) : 'pill-idle'}"
          ${a.enabled && a.overagePercent > 0 ? `title="${esc(t('st.overageT'))}"` : ''}
          >${esc(a.enabled ? stateLabel(a) : t('st.off'))}</span>
        <button class="sw-s ${a.enabled?'on':''}" data-acc="${a.id}"
          title="${esc(t(a.enabled?'prof.disable':'prof.enable'))}" aria-pressed="${a.enabled}"></button>
        <button class="edit" data-edit="${a.id}" title="${esc(t('prof.rename'))}">&#9998;</button>
      </div>
      ${a.credits
        ? `<div class="wins one">${win(t('w.allow'), a.usagePercent, a.resetsAt, `${num(a.credits.used)} / ${num(a.credits.limit)} ${a.credits.unit}s · ${num(a.credits.remaining)} left`)}</div>`
        : `<div class="wins">${win(t('w.5h'), a.usagePercent, a.resetsAt)}${win(t('w.7d'), a.usagePercent7d, a.resetsAt7d)}</div>`}
    </div>`).join('');

  document.getElementById('order-hint').innerHTML =
    `<span class="grip">⠿</span>${esc(t('ov.order'))}`;

  // Share of the work done so far: every account's requests as a slice of
  // 100%. This answers "who has actually been serving me", which the windows
  // above cannot — an account at 74% of a small window may have done far less
  // work than one at 31% of a large one.
  // Every account appears, enabled or not: the strip is a picture of the
  // whole pool, and hiding a disabled account makes its share vanish
  // without explanation.
  const served = ACCOUNTS.filter(a => (a.requests ?? 0) > 0 || !a.enabled);
  const totalReq = served.reduce((s,a) => s + a.requests, 0) || 1;
  const byProvider = ['claude','codex'].map(k => ({
    kind: k,
    requests: served.filter(a => a.kind === k).reduce((s,a) => s + a.requests, 0),
  })).filter(x => x.requests > 0);

  document.getElementById('strip').innerHTML = `
    <div class="strip-head">
      <div class="strip-prov">
        ${byProvider.map(x => `<span class="prov" style="--c:var(--${x.kind})">
          ${MARKS[x.kind]}<b class="num">${Math.round(x.requests / totalReq * 100)}%</b>
        </span>`).join('')}
      </div>
      <div class="strip-sub">${esc(t('ov.ofWork').replace('{n}', totalReq.toLocaleString('en-US')))}</div>
    </div>
    <div class="strip-bar">
      ${served.map(a => `<i style="--c:${a.colour};width:${(a.requests / totalReq * 100).toFixed(2)}%"
        title="${esc(displayName(a))}: ${a.requests}"></i>`).join('')}
    </div>
    <div class="legend">
      ${served.map(a => `<div class="lg" style="--c:${a.colour}">
        <i class="sw"></i><b>${Math.round(a.requests / totalReq * 100)}%</b>
        <span>${esc(displayName(a))}</span></div>`).join('')}
    </div>`;
}

function win(label, pct, resets, extra){
  // `extra` replaces the reset line for a credit-metered window, which has a
  // balance to show instead of a countdown.
  const sub = extra ?? (resets ? `${t('w.resets')} ${t('ov.in')} ${until(resets)}` : '');
  return `<div>
    <div class="wlab"><span>${esc(label)}</span><b class="num">${pct == null ? '—' : pct + '%'}</b></div>
    <div class="trk"><i class="fil" style="width:${width(pct)};display:block"></i></div>
    <div class="wsub">${esc(sub)}</div>
  </div>`;
}

/* ---------------- logs ---------------- */
let actFilter = 'all';

function renderLogs(){
  const wd = { en:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
               nl:['Ma','Di','Wo','Do','Vr','Za','Zo'],
               de:['Mo','Di','Mi','Do','Fr','Sa','So'] }[lang];
  const locale = lang === 'en' ? 'en-US' : lang === 'nl' ? 'nl-NL' : 'de-DE';
  const months = HISTORY.months ?? [];

  /** One month grid for one account, headed by the month's own name. */
  function grid(m, row, unit, busiestDay){
    const [y, mo] = m.month.split('-').map(Number);
    const label = new Date(y, mo - 1, 1).toLocaleDateString(locale, { month:'long' });
    const today = new Date();

    const cells = [];
    for (let k = 0; k < m.startsOn; k++) cells.push('<div class="day pad"></div>');
    (row ? row.days : new Array(m.daysInMonth).fill(null)).forEach((cell, di) => {
      const date = new Date(y, mo - 1, di + 1);
      const dayLabel = esc(date.toLocaleDateString(locale, { month:'short', day:'numeric' }));
      if (!cell) {
        const future = date > today;
        cells.push(`<div class="day ${future ? 'future' : 'zero'}" data-t="${dayLabel} · ${esc(t('logs.noData'))}">`
          + `<span class="n">${di + 1}</span></div>`);
        return;
      }
      const amount = unit === 'credits' ? (cell.credits ?? 0) : cell.inputTokens + cell.outputTokens;
      // Shaded against this account's busiest day ACROSS BOTH months, so the
      // two grids are directly comparable rather than each scaled to itself.
      const intensity = busiestDay > 0 ? Math.round(18 + (amount / busiestDay) * 82) : 0;
      cells.push(`<div class="day${amount === 0 ? ' zero' : intensity >= 62 ? ' hot' : ''}" style="--i:${intensity}%"
        data-t="${dayLabel} · ${esc(fmt(amount))} ${esc(unit)} · ${cell.requests} req"><span class="n">${di + 1}</span></div>`);
    });

    return `<div class="cal-month">
      <div class="cal-mname">${esc(label)}</div>
      <div class="cal-hd">${wd.map((x) => `<span>${x}</span>`).join('')}</div>
      <div class="cal">${cells.join('')}</div>
    </div>`;
  }

  // One block per account, each showing every month side by side.
  const accountIds = [...new Set(months.flatMap((m) => m.rows.map((r) => r.accountId)))];

  document.getElementById('cals').innerHTML = accountIds.length === 0
    ? `<div class="empty">${esc(t('logs.none'))}</div>`
    : accountIds.map((id) => {
        const a = ACCOUNTS.find((x) => x.id === id);
        const colour = a ? a.colour : 'var(--a1)';
        const perMonth = months.map((m) => m.rows.find((r) => r.accountId === id) ?? null);
        const unit = perMonth.find((r) => r && r.unit)?.unit ?? (a && a.kind === 'codex' ? 'credits' : 'tokens');

        // Totals span both months, so the figures describe the whole view.
        const total = perMonth.reduce((sum, r) => sum + (r?.total ?? 0), 0);
        const busiestDay = perMonth.reduce((max, r) => Math.max(max, r?.busiestDay ?? 0), 0);
        const activeDays = perMonth.reduce((sum, r) => sum + (r?.activeDays ?? 0), 0);
        const busiestHour = perMonth.map((r) => r?.busiestHour).find((h) => h != null) ?? null;

        return `<div class="cal-row" style="--c:${colour}">
          <div class="cal-side">
            <div class="cal-id">
              <div class="cal-prod"><span class="av-s">${a ? MARKS[a.kind] : MARKS.claude}</span><b>${esc(a ? a.product : 'Claude Code')}</b></div>
              <div class="cal-plan">${esc(a && a.plan ? a.plan : '')}</div>
              <div class="cal-who">${esc(a ? displayName(a) : id)}</div>
            </div>
            <div class="cal-stats">
              <div class="cal-stat"><b class="num">${esc(fmt(total))}</b><span>${esc(unit)}</span></div>
              <div class="cal-stat"><b class="num">${esc(fmt(busiestDay))}</b><span>${esc(t('logs.peak'))}</span></div>
              <div class="cal-stat"><b class="num">${activeDays}</b><span>${esc(t('logs.active'))}</span></div>
              <div class="cal-stat"><b class="num">${esc(hourRange(busiestHour))}</b><span>${esc(t('logs.peakHour'))}</span></div>
            </div>
          </div>
          <div class="cal-months">
            ${months.map((m, i) => grid(m, perMonth[i], unit, busiestDay)).join('')}
          </div>
        </div>`;
      }).join('');

  const maxM = Math.max(...HISTORY.models.map(m => m.tokens), 1);
  document.getElementById('models').innerHTML = HISTORY.models.length === 0
    ? `<div class="empty">${esc(t('logs.none'))}</div>`
    : HISTORY.models.map(m => {
        const kind = /^gpt|^o\d/.test(m.name) ? 'codex' : 'claude';
        return `<div class="mrow" style="--c:${kind==='codex'?'var(--codex)':'var(--claude)'}">
          <div class="mname">${MARKS[kind]}<span>${esc(m.name)}</span></div>
          <div class="mbar"><i style="width:${(m.tokens/maxM*100).toFixed(1)}%"></i></div>
          <div class="mval num">${fmt(m.tokens)}</div>
        </div>`;
      }).join('');

  const maxP = Math.max(...HISTORY.projects.map(p => p.tokens), 1);
  document.getElementById('projects').innerHTML = HISTORY.projects.length === 0
    ? `<div class="empty">${esc(t('logs.none'))}</div>`
    : HISTORY.projects.map((p,i) => `
    <div class="mrow" style="--c:var(--a${(i%5)+1})">
      <div class="mname"><span>${esc(p.name)}</span></div>
      <div class="mbar"><i style="width:${(p.tokens/maxP*100).toFixed(1)}%"></i></div>
      <div class="mval num">${fmt(p.tokens)}</div>
    </div>`).join('');

  document.getElementById('act-filters').innerHTML =
    ['all','session','rotation','config','error','general'].map(k =>
      `<button class="chip ${actFilter===k?'on':''}" data-f="${k}">${esc(t('f.'+k))}</button>`).join('');

  const list = HISTORY.events.filter(e => actFilter === 'all' || e.kind === actFilter);
  document.getElementById('act-list').innerHTML = list.length === 0
    ? `<div class="empty">${esc(t('logs.none'))}</div>`
    : list.map(e => {
        const detail = (e.inputTokens || e.outputTokens)
          ? `${fmt(e.inputTokens||0)} in / ${fmt(e.outputTokens||0)} out`
            + (e.durationMs ? ` · ${(e.durationMs/1000).toFixed(1)}s` : '')
            + (e.model ? ` · ${e.model}` : '')
          : (e.meta || '');
        return `<div class="ev">
          <div class="ev-top">
            <div class="ev-x">${esc(e.text)}</div>
            <span class="ev-tag k-${esc(e.kind)}">${esc(t('f.'+e.kind))}</span>
          </div>
          ${detail ? `<div class="ev-m">${esc(detail)}</div>` : ''}
          <div class="ev-t">${esc(clock(e.at))}</div>
        </div>`;
      }).join('');
}

/* ---------------- settings & help ---------------- */
function renderSettings(){
  const opts = (list, sel) => list.map(o =>
    `<option value="${esc(o)}"${o === sel ? ' selected' : ''}>${esc(o)}</option>`).join('');

  document.getElementById('parity').innerHTML = `
    <div class="par par-h">
      <span>${esc(t('set.pClaude'))}</span><span></span>
      <span>${esc(t('set.pGpt'))}</span><span>${esc(t('set.pEffort'))}</span>
    </div>` + PARITY.map((r,i) => `
    <div class="par">
      <div class="m c">${MARKS.claude}
        <select class="psel" data-par="${i}" data-side="claude">${opts(CLAUDE_MODELS(), r.claude)}</select>
      </div>
      <div class="ar" title="${esc(t('set.pBoth'))}">⇄</div>
      <div class="m g">${MARKS.codex}
        <select class="psel" data-par="${i}" data-side="gpt">${opts(GPT_MODELS(), r.gpt)}</select>
      </div>
      <span class="eff-auto" title="${esc(t('set.pAutoT'))}">${esc(t('set.pAuto'))}</span>
    </div>`).join('');

  const models = document.getElementById('models');
  if (models) {
    models.innerHTML = MODELS.length === 0
      ? `<p style="margin:0;font-size:12.5px;color:var(--dim)">${esc(t('set.modelNone'))}</p>`
      : `<div class="srow">
          <div class="t"><b>${esc(t('set.modelAuto'))}</b><span>${esc(t('set.modelAutoD'))}</span></div>
          <button class="btn${ACTIVE_MODEL === null ? ' on' : ''}" data-model="">${esc(t(ACTIVE_MODEL === null ? 'set.modelOn' : 'set.modelUse'))}</button>
        </div>` + MODELS.map(m => {
          const on = m.id === ACTIVE_MODEL;
          return `<div class="srow">
            <div class="t"><b>${m.kind === 'codex' ? MARKS.codex : MARKS.claude} ${esc(m.name)}</b><span>${esc(m.id)}</span></div>
            <button class="btn${on ? ' on' : ''}" data-model="${esc(m.id)}">${esc(t(on ? 'set.modelOn' : 'set.modelUse'))}</button>
          </div>`;
        }).join('');
  }

  document.getElementById('notifs').innerHTML = NOTIFS.map(([key,label,desc]) => {
    const on = SETTINGS.notifications[key] !== false;
    return `<div class="srow">
      <div class="t"><b>${esc(t(label))}</b><span>${esc(t(desc))}</span></div>
      <button class="sw-t ${on?'on':''}" data-notif="${esc(key)}" aria-pressed="${on}"></button>
    </div>`;
  }).join('');
}

function renderHelp(){
  document.getElementById('cmds').innerHTML = CMDS.map(([c,k]) => `
    <div class="cmd">
      <div class="cmd-t"><code>${esc(c)}</code><button class="copy" data-c="${esc(c)}">copy</button></div>
      <p>${esc(t(k))}</p>
    </div>`).join('');
}

/* ---------------- shell ---------------- */
function applyI18n(){
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n) });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml) });
}
function renderAll(){
  applyI18n();
  renderOverview();
  // Logs is driven by HISTORY, which arrives on its own schedule. Rendering
  // it here before the first fetch lands would paint an empty month and then
  // overwrite the real one on the next state frame.
  if (historyLoaded) renderLogs();
  renderSettings();
  renderHelp();
}

document.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab){
    if (tab.dataset.p === 'settings') void loadProcess();
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === tab));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === 'p'+'-'+tab.dataset.p));
    window.scrollTo({ top:0 });
    return;
  }
  const chip = e.target.closest('.chip');
  if (chip){ actFilter = chip.dataset.f; renderLogs(); return }
  const ed = e.target.closest('.edit');
  if (ed){ openRename(ed.dataset.edit); return }
  if (e.target.closest('[data-close]')){ closeRename(); return }
  if (e.target.closest('[data-save]')){ saveRename(); return }
  const acc = e.target.closest('.sw-s');
  if (acc){
    const a = ACCOUNTS.find(x => x.id === acc.dataset.acc);
    if (a){
      a.enabled = !a.enabled;
      renderOverview();
      save({ profileId: a.id, changes: { enabled: a.enabled } });
    }
    return;
  }
  const sw = e.target.closest('.sw-t');
  if (sw){
    sw.classList.toggle('on');
    const key = sw.dataset.notif;
    if (key){
      SETTINGS.notifications[key] = sw.classList.contains('on');
      save({ settings: { notifications: SETTINGS.notifications } });
    }
    return;
  }
  const pick = e.target.closest('[data-model]');
  if (pick){
    // An empty value is the "let the client choose" row, which clears the
    // override — null, not '', is what the API treats as cleared.
    const wanted = pick.dataset.model === '' ? null : pick.dataset.model;
    if (wanted !== ACTIVE_MODEL){
      ACTIVE_MODEL = wanted;
      renderSettings();           // reflect the choice before the round trip
      save({ activeModel: wanted });
    }
    return;
  }
  const copy = e.target.closest('.copy');
  if (copy){
    navigator.clipboard?.writeText(copy.dataset.c);
    const was = copy.textContent; copy.textContent = 'copied';
    setTimeout(() => { copy.textContent = was }, 1200);
  }
});

/* ---------------- reordering ---------------- */
let dragId = null;

document.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.prof');
  if (!card) return;
  dragId = card.dataset.id;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

document.addEventListener('dragend', (e) => {
  const card = e.target.closest('.prof');
  if (card) card.classList.remove('dragging');
  document.querySelectorAll('.prof').forEach((c) => c.classList.remove('over'));
  dragId = null;
});

document.addEventListener('dragover', (e) => {
  const card = e.target.closest('.prof');
  if (!card || dragId === null) return;
  e.preventDefault();                       // required to allow a drop
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.prof').forEach((c) => c.classList.toggle('over', c === card && c.dataset.id !== dragId));
});

document.addEventListener('drop', (e) => {
  const card = e.target.closest('.prof');
  if (!card || dragId === null) return;
  e.preventDefault();
  const from = ACCOUNTS.findIndex((a) => a.id === dragId);
  const to = ACCOUNTS.findIndex((a) => a.id === card.dataset.id);
  if (from > -1 && to > -1 && from !== to){
    ACCOUNTS.splice(to, 0, ACCOUNTS.splice(from, 1)[0]);
    renderAll();
    // Positions are 1-based and contiguous, so the daemon can sort by them.
    ACCOUNTS.forEach((a, i) => save({ profileId: a.id, changes: { order: i + 1 } }));
  }
  dragId = null;
});

/* ---------------- rename dialog ---------------- */
let editing = null;

function openRename(id){
  const a = ACCOUNTS.find(x => x.id === id);
  if (!a) return;
  editing = id;
  const m = document.getElementById('modal');
  m.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="modal-h">
        <span class="av-s" style="--c:${a.colour}">${MARKS[a.kind]}</span>
        <div>
          <b>${esc(t('prof.rename'))}</b>
          <span>${esc(a.product)} · ${esc(a.plan)}</span>
        </div>
      </div>
      <label class="modal-l" for="alias-in">${esc(t('prof.nameL'))}</label>
      <input id="alias-in" class="modal-in" value="${esc(a.alias ?? '')}"
             placeholder="${esc(a.email || a.id)}" autocomplete="off" spellcheck="false">
      <p class="modal-hint">${esc(t('prof.nameH'))}</p>
      <div class="modal-f">
        <button class="btn" data-close>${esc(t('prof.cancel'))}</button>
        <button class="btn btn-p" data-save>${esc(t('prof.save'))}</button>
      </div>
    </div>`;
  m.classList.add('on');
  const input = document.getElementById('alias-in');
  input.focus(); input.select();
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') saveRename();
    if (ev.key === 'Escape') closeRename();
  });
}

function saveRename(){
  const a = ACCOUNTS.find(x => x.id === editing);
  const input = document.getElementById('alias-in');
  if (a && input){
    a.alias = input.value.trim() || null;
    a.label = a.alias || a.email || a.id;
    save({ profileId: a.id, changes: { alias: a.alias } });
  }
  closeRename();
  renderAll();
}

function closeRename(){
  editing = null;
  const m = document.getElementById('modal');
  m.classList.remove('on');
  m.innerHTML = '';
}

document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeRename();      // click the backdrop to dismiss
});

document.addEventListener('change', (e) => {
  const sel = e.target.closest('.psel');
  if (!sel) return;
  if (sel.dataset.lang !== undefined) return; // handled by its own listener
  const row = PARITY[+sel.dataset.par];
  if (!row) return;
  row[sel.dataset.side] = sel.value;
  save({ parity: PARITY });
});

document.getElementById('refresh-usage').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.classList.add('spin');
  try {
    // /api/refresh re-probes every account, so the numbers come from the
    // provider rather than from whatever was last cached.
    applyState(await (await fetch('/api/refresh')).json());
  } catch {
    // Nothing to say: the existing numbers simply stay as they were.
  } finally {
    btn.disabled = false;
    btn.classList.remove('spin');
  }
});

document.getElementById('scan').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const out = document.getElementById('scan-result');
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('set.scanning');
  try {
    const r = await fetch('/api/scan', { method: 'POST' });
    if (!r.ok) throw new Error(String(r.status));
    const { added, removed, total } = await r.json();
    // Say what actually happened. "Done" with no detail leaves you unsure
    // whether it looked at all.
    const parts = [];
    if (added.length) parts.push(t('set.scanAdded').replace('{n}', added.length));
    if (removed.length) parts.push(t('set.scanGone').replace('{n}', removed.length));
    out.className = 'scan-result' + (parts.length ? '' : ' none');
    out.textContent = parts.length
      ? parts.join(' · ')
      : t('set.scanSame').replace('{n}', total);
    out.hidden = false;
    // A scan can add the first Codex login, which brings its own models.
    if (added.length || removed.length){ await loadModels(); renderSettings(); }
  } catch {
    out.className = 'scan-result bad';
    out.textContent = t('set.scanFail');
    out.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
});

document.getElementById('lang').addEventListener('change', (e) => {
  lang = e.target.value;
  SETTINGS.language = lang;
  save({ settings: { language: lang } });
  renderAll();
});
document.getElementById('theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.getAttribute('data-theme') === 'dark'
    || (!root.hasAttribute('data-theme') && matchMedia('(prefers-color-scheme:dark)').matches);
  SETTINGS.theme = dark ? 'light' : 'dark';
  root.setAttribute('data-theme', SETTINGS.theme);
  save({ settings: { theme: SETTINGS.theme } });
});

/* ---------------- data ---------------- */

/**
 * Persist a change. Fire-and-forget by design: the UI has already updated
 * optimistically, and a failed save must not freeze the page. The daemon
 * broadcasts the authoritative state back over SSE either way.
 */
function save(change) {
  fetch('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(change),
  }).catch(() => {});
}

/** Fold a /api/stats or SSE payload into local state. */
function applyState(payload) {
  if (!payload) return;
  RUNNING = true;
  TOTALS = payload.totals ?? TOTALS;

  ACCOUNTS = (payload.accounts ?? []).map((a, i) => ({
    ...a,
    colour: colourFor(i),
    // The daemon reports the pool; a disabled account is out of rotation.
    enabled: a.state !== 'disabled',
    product: a.kind === 'codex' ? 'Codex' : 'Claude Code',
    alias: payload.config?.profiles?.[a.id]?.alias ?? null,
  }));

  if (payload.config) {
    // Do not overwrite the table while the user is mid-edit: a broadcast
    // arriving between selecting and blurring would snap the dropdown back.
    const editing = document.activeElement?.classList?.contains('psel');
    if (!editing) PARITY = payload.config.parity?.length ? payload.config.parity : PARITY;
    SETTINGS = { ...SETTINGS, ...payload.config.settings };
    if (SETTINGS.theme && SETTINGS.theme !== 'auto') {
      document.documentElement.setAttribute('data-theme', SETTINGS.theme);
    }
    if (SETTINGS.language && SETTINGS.language !== lang) {
      lang = SETTINGS.language;
      const sel = document.getElementById('lang');
      if (sel) sel.value = lang;
    }
  }
  renderAll();
  // Logs and Settings read from HISTORY and the saved config, neither of
  // which a state frame carries. Without this the overview updated while the
  // other two pages silently kept showing stale data.
  void loadHistory();
}

/** Live process cost. Polled only while Settings is open — there is nothing
 *  to watch on the other pages, and this is a real syscall each time. */
/**
 * The models the pool can actually serve, merged across every account and
 * deduplicated by the server. Failure leaves the list empty, which the
 * picker renders as an honest empty state rather than inventing entries.
 */
async function loadModels() {
  try {
    const payload = await (await fetch('/api/models')).json();
    MODELS = Array.isArray(payload.models) ? payload.models : [];
    ACTIVE_MODEL = payload.active ?? null;
  } catch {
    MODELS = [];
  }
}

async function loadProcess() {
  try {
    const p = await (await fetch('/api/process')).json();
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    set('cpu-val', p.cpuPercent.toFixed(1) + '%');
    set('ram-val', Math.round(p.memoryBytes / 1048576) + ' MB');
    set('pid-val', String(p.pid));
    // Real minutes, floored to at least one: a session up 40 seconds is
    // running, and "0m" reads as though it is not. So 0s-1m59s both show
    // "1m", and it ticks to "2m" at two minutes.
    set('up-val', Math.max(1, Math.floor(p.uptimeSeconds / 60)) + 'm');
  } catch {
    // Not running: the dashes already say so.
  }
}


let historyRequest = 0;
let historyLoaded = false;

async function loadHistory() {
  // Several callers fire this without awaiting, so responses can arrive out
  // of order. Only the newest one is allowed to write, or a slow early
  // request overwrites fresh data with an empty month.
  const mine = ++historyRequest;
  try {
    const next = await (await fetch('/api/history')).json();
    if (mine !== historyRequest) return;
    HISTORY = next;
    historyLoaded = true;
    renderLogs();
  } catch {
    // The Logs page simply stays as it was; nothing else depends on it.
  }
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => { try { applyState(JSON.parse(e.data)) } catch {} });
  es.addEventListener('activity', () => { void loadHistory() });
  es.onerror = () => {
    RUNNING = false;
    renderOverview();
    es.close();
    setTimeout(connect, 3000); // the session probably ended; keep trying quietly
  };
}

async function boot() {
  // Models first: the parity defaults below are built from them, and a
  // hardcoded fallback is what made this list wrong in the first place.
  await loadModels();
  // Default the parity table so Settings is never blank before a first edit.
  const claude = CLAUDE_MODELS(), gpt = GPT_MODELS();
  PARITY = claude.map((c, i) => ({ claude: c, gpt: gpt[i] ?? gpt[0] ?? '' }));
  try {
    applyState(await (await fetch('/api/stats')).json());
  } catch {
    renderAll(); // offline or not running: render the empty state honestly
  }
  await loadHistory();
  void loadProcess();
  connect();
  // Process cost moves constantly; refresh it while Settings is on screen.
  setInterval(() => {
    const open = document.getElementById('p-settings');
    if (open && open.className.includes('on')) void loadProcess();
  }, 5000);
  // Reset countdowns tick down without waiting for an event.
  setInterval(() => { void fetch('/api/stats').then(r => r.json()).then(applyState).catch(() => {}) }, 30000);
}

boot();
