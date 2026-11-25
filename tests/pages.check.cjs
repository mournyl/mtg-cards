// Browser checks for every page, with Playwright (not run in CI).
//   python3 -m http.server 8777 --directory public &      (from the repo root)
//   node tests/pages.check.cjs http://127.0.0.1:8777 /tmp/shots
// Scryfall is mocked: "text" mode makes every Scryfall call fail; "images" mode answers with placeholder cards.
const { chromium, devices } = require("playwright");
const fs = require("fs");
const BASE = (process.argv[2] || "http://127.0.0.1:8777").replace(/\/$/, "");
const OUT = process.argv[3] || "shots";
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log("  ok  " + msg); else { failures++; console.log("  FAIL " + msg); } };
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function fakeCard(name, i = 0) {
  const u = `https://cards.scryfall.io/normal/front/x/${slug(name)}.jpg`;
  return { object: "card", id: `00000000-0000-4000-8000-${String(100000000000 + i).slice(-12)}`, name, mana_cost: "{1}{U}", type_line: "Instant",
    oracle_text: `Rules text of ${name}. Draw a card.`, game_changer: i % 10 === 0, image_uris: { small: u, normal: u, large: u }, prices: { usd: "1.23", eur: "1.10" },
    scryfall_uri: "https://scryfall.com/card/x", related_uris: { edhrec: "https://edhrec.com/cards/x" }, legalities: { commander: "legal" },
    set: "tst", set_name: "Test", collector_number: "1", rarity: "rare", artist: "Nobody", color_identity: ["U"] };
}

async function newPage(browser, mode, viewport) {
  const ctx = await browser.newContext(viewport || { viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const errors = [], sf = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|ERR_|404/.test(m.text())) errors.push(m.text()); });
  await page.route("https://fonts.googleapis.com/**", r => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://fonts.gstatic.com/**", r => r.abort());
  await page.route("https://cards.scryfall.io/**", r => {
    const name = decodeURIComponent(r.request().url().split("/").pop().replace(".jpg", ""));
    r.fulfill({ status: 200, contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" rx="22" fill="#2a3550"/><text x="24" y="60" font-size="30" fill="#fff" font-family="sans-serif">${name.replace(/[<&]/g, "")}</text></svg>` });
  });
  await page.route("https://api.scryfall.com/**", async r => {
    let doc = ""; try { doc = r.request().frame().url().split("#")[0]; } catch { /* no frame */ }
    sf.push({ t: Date.now(), url: r.request().url(), doc });
    if (mode === "text") return r.abort();
    const url = new URL(r.request().url());
    if (url.pathname === "/cards/collection") {
      const ids = JSON.parse(r.request().postData()).identifiers;
      return r.fulfill({ json: { object: "list", not_found: [], data: ids.map((x, i) => fakeCard(x.name, i)) } });
    }
    if (url.pathname === "/cards/search") {
      const pageNo = +(url.searchParams.get("page") || 1);
      const names = [["Sol Ring", "Cultivate", "Counterspell", "Divination", "Llanowar Elves"], ["Rampant Growth", "Cancel", "Swords to Plowshares"], ["Wrath of God", "Opt"]][pageNo - 1] || [];
      const next = pageNo < 3 ? `https://api.scryfall.com/cards/search?${new URLSearchParams({ ...Object.fromEntries(url.searchParams), page: pageNo + 1 })}` : null;
      return r.fulfill({ json: { object: "list", total_cards: 10, has_more: !!next, next_page: next, data: names.map((n, i) => fakeCard(n, pageNo * 10 + i)) } });
    }
    if (url.pathname === "/cards/named") return r.fulfill({ json: fakeCard(url.searchParams.get("exact"), 99) });
    return r.fulfill({ status: 404, json: { details: "not mocked" } });
  });
  return { ctx, page, errors, sf };
}

(async () => {
  const browser = await chromium.launch();
  for (const mode of ["text", "images"]) {
    console.log(`\n== tier lists (${mode})`);
    let { ctx, page, errors, sf } = await newPage(browser, mode);
    await page.goto(`${BASE}/tiers/`);
    await page.waitForSelector(".rcard");
    ok((await page.$$(".rcard")).length === 10, "hub shows 10 lists");
    await page.screenshot({ path: `${OUT}/tiers-hub-${mode}.png`, fullPage: false });
    await page.fill("#q", "sol ring");
    await page.waitForSelector("#board .tile");
    const found = await page.$$eval("#board .tile", ts => ts.map(t => t.querySelector(".card").dataset.n + ": " + [...t.querySelectorAll(".tag")].map(g => [...g.children].map(x => x.textContent).join(" ")).join(", ")));
    ok(found.some(f => f.startsWith("Sol Ring: S Ramp #1")), "hub search shows Sol Ring as a full card tagged Ramp #1");
    await page.fill("#q", "");
    await page.click(".rcard[href='#counterspells']");
    await page.waitForSelector(".tier .card");
    ok(/counterspells/i.test(await page.textContent("h1")), "counterspell list opens");
    ok((await page.textContent("#tier-s")).includes("Counterspell"), "Counterspell sits in S");
    if (mode === "images") { await page.waitForTimeout(1500); ok((await page.$$(".tier .card img")).length > 5, "tiles get images from (mocked) Scryfall"); }
    await page.screenshot({ path: `${OUT}/tiers-counterspells-${mode}.png` });
    await page.goto(`${BASE}/tiers/#ramp/green/rocks`); await page.waitForTimeout(300);
    await page.waitForSelector(".tier");
    ok((await page.textContent("h1")).toLowerCase().includes("green ramp"), "color route #ramp/green/rocks");
    ok(await page.$eval(".seg [aria-current='page']", e => e.textContent.startsWith("Mana rocks")), "sub-list route selects Mana rocks");
    const pressedColors = () => page.$$eval(".levels [data-color][aria-pressed='true']", els => els.map(e => e.dataset.color).join(""));
    await page.goto(`${BASE}/tiers/#removal/id-ub`); await page.waitForTimeout(300);
    await page.waitForSelector(".tier");
    ok(await pressedColors() === "UBC", "old My colors link opens as Blue + Black + Colorless");
    ok(!/Multicolor|My colors/.test(await page.textContent("#hero")), "Multicolor and My colors are gone");
    await page.goto(`${BASE}/tiers/#removal`); await page.waitForTimeout(300); await page.waitForSelector(".tier");
    await page.click(".levels [data-color='U']"); await page.click(".levels [data-color='B']"); await page.waitForTimeout(200);
    ok(await pressedColors() === "UB" && page.url().endsWith("#removal/ub") && /^Dimir /.test(await page.textContent("h1")), "colors toggle on together: " + page.url().split("#")[1]);
    const lede = await page.textContent("#hero p");
    ok(/fit a blue-black deck/.test(lede), "the list explains what the picks show: " + lede.slice(0, 60));
    await page.click(".levels [data-color='']"); await page.waitForTimeout(200);
    ok(await pressedColors() === "" && page.url().endsWith("#removal"), "All colors clears the picks");
    // filters + show more
    await page.goto(`${BASE}/tiers/#draw`); await page.waitForTimeout(300);
    await page.waitForSelector("[data-more]");
    const before = await page.$$eval("#tier-d .tile", r => r.length);
    await page.click("#tier-d [data-more]");
    const after = await page.$$eval("#tier-d .tile", r => r.length);
    ok(after === before + 48, `lower tiers show full cards, 48 more at a time (${before} -> ${after})`);
    const misaligned = await page.$$eval("#tier-d .tile", ts => {
      const rows = new Map();
      ts.forEach(t => { const top = Math.round(t.querySelector(".card").getBoundingClientRect().top), tg = t.querySelector(".tags");
        if (tg && tg.offsetParent) { const r = rows.get(top) || []; r.push(Math.round(tg.getBoundingClientRect().top)); rows.set(top, r); } });
      return [...rows.values()].filter(r => Math.max(...r) - Math.min(...r) > 1).length;
    });
    ok(misaligned === 0, `tag boxes line up across each row (${misaligned} rows off)`);
    ok(!(await page.isVisible("#mv")), "filters stay folded until asked");
    await page.click("#filtersBtn");
    await page.selectOption("#mv", "1");
    await page.check("#inst");
    const mvs = await page.$$eval("#board [data-n]", els => els.length);
    ok(mvs > 0, "MV and instant filters leave cards");
    await page.click(".tab[data-t='D']"); await page.click(".tab[data-t='F']");
    ok(!(await page.$("#tier-d")), "tier toggle hides D");
    await page.click("#clear");
    await page.goto(`${BASE}/tiers/#protection`); await page.waitForTimeout(300); await page.waitForSelector(".tier");
    const levels = await page.$$eval(".levels .lvl", ls => ls.map(l => [l.querySelector(".lvl-l").textContent, l.querySelector(".seg").textContent]));
    ok(levels.map(l => l[0]).join("|") === "Colors|What it protects|How it protects", "filter rows each have their own label: " + levels.map(l => l[0]).join(" | "));
    ok(await page.$eval(".sizetop [data-size='full']", b => b.getAttribute("aria-pressed")) === "true" && (await page.$$(".tier .grid .card")).length > 0, "cards start at Full size");
    ok((await page.$$eval(".sizetop [data-size]", bs => bs.map(b => b.textContent))).join("|") === "Large|Full|Medium|Condensed", "sizes are Large, Full, Medium, Condensed");
    const spot = await page.evaluate(() => { const h = document.querySelector("header").getBoundingClientRect(), s = document.querySelector(".sizetop .seg").getBoundingClientRect(), m = document.querySelector(".me").getBoundingClientRect(); return { below: s.top >= h.bottom - 1, right: Math.abs(s.right - m.right) < 4 }; });
    ok(spot.below && spot.right, "card size sits just under the header line, lined up under Saved and the account button");
    const wFull = await page.$eval(".tier .grid .card", c => c.getBoundingClientRect().width);
    await page.click(".sizetop [data-size='large']"); await page.waitForTimeout(200);
    const wLarge = await page.$eval(".tier .grid .card", c => c.getBoundingClientRect().width);
    await page.click(".sizetop [data-size='medium']"); await page.waitForTimeout(200);
    const wMed = await page.$eval(".tier .grid .card", c => c.getBoundingClientRect().width);
    ok(wLarge > wFull && wFull > wMed && wMed > 60, `Large > Full > Medium (${Math.round(wLarge)}px, ${Math.round(wFull)}px, ${Math.round(wMed)}px)`);
    await page.click(".sizetop [data-size='condensed']"); await page.waitForTimeout(200);
    ok((await page.$$(".tier .rows .row")).length > 0 && !(await page.$(".tier .card")), "Condensed shows names only");
    await page.goto(`${BASE}/`); await page.fill("#q", "t:instant"); await page.keyboard.press("Enter"); await page.waitForTimeout(1500);
    const condSearch = await page.$$("#grid .crow");
    ok(mode === "text" || (condSearch.length > 0 && !(await page.$("#grid .card"))), "the card size carries over to card search");
    await page.goto(`${BASE}/tiers/#protection`); await page.waitForSelector(".tier");
    await page.click(".sizetop [data-size='full']"); await page.waitForTimeout(200);
    ok(/Can't be countered/.test(levels[1][1]) && !/Can't be countered/.test(levels[2][1]), "Can't be countered shows once, as a sub-list");
    const tagText = await page.$$eval(".tier .tags", ts => ts.map(t => t.textContent).join(" "));
    ok(!/Unreviewed|New 20\d\d|Color identity/.test(tagText), "no Unreviewed, New or color identity tags");
    await page.click("[data-pt='phasing']"); await page.waitForTimeout(300);
    const ph = await page.$$eval("#board [data-n]", els => els.map(e => e.dataset.n));
    ok(ph.includes("Slip Out the Back") && ph.includes("Teferi's Protection") && !ph.includes("Lightning Greaves"), `protection type filter: phasing (${ph.length} cards)`);
    const slip = await page.$$eval(".tile", ts => { const t = ts.find(x => x.querySelector("[data-n='Slip Out the Back']")); return t ? [...t.querySelectorAll(".tags .tag")].map(r => (r.querySelector(".ti svg") ? "icon " : "") + r.textContent.trim()) : []; });
    ok(slip.includes("icon One creature") && slip.includes("icon Phasing"), "tile tags are rows with icons: " + slip.join(" | "));
    ok(slip.filter(t => /Phasing/.test(t)).length === 1, "a function tag doesn't repeat the protection kind (one Phasing row)");
    await page.goto(`${BASE}/tiers/#counterspells`); await page.waitForSelector(".tier .card"); await page.waitForTimeout(500);
    const ftags = await page.$$eval(".tier .tile .tags a.tag[href*='role=']", as => as.map(a => a.textContent.trim()));
    ok(ftags.length > 0 && !ftags.includes("Counterspell"), "tier tiles add what else a card does, not the list's own job: " + [...new Set(ftags)].slice(0, 6).join(", "));
    // card sheet
    await page.goto(`${BASE}/tiers/#draw`); await page.waitForTimeout(300); await page.waitForSelector(".tier .card");
    await page.fill("#q", "divination"); await page.waitForTimeout(400);
    await page.click("[data-n='Divination']");
    await page.waitForSelector("#cardModal.open .trole");
    const sheet = await page.textContent("#cardModal");
    ok(sheet.includes("Card draw") && sheet.includes("Better card draw"), "card sheet shows tiers and better options");
    const what = await page.$$eval("#cardModal .tags.wide a.tag", as => as.map(a => a.textContent.trim() + " -> " + a.getAttribute("href")));
    ok(what.some(t => /^Card draw -> .*#role=draw$/.test(t)), "the sheet lists what the card does, each tag linking to card search: " + what.join(" | "));
    await page.screenshot({ path: `${OUT}/card-sheet-${mode}.png` });
    ok(!(await page.$("[data-feedback]")) && !/Suggest a tier/.test(sheet), "no tier feedback in the card sheet");
    // Back walks back through the cards you opened, then closes the sheet
    const firstUrl = page.url();
    const alt = await page.$eval("#cardModal [data-open]", b => b.dataset.open);
    await page.click("#cardModal [data-open]");
    await page.waitForFunction(n => document.querySelector("#cardModal .nameline h2")?.textContent.startsWith(n.split(" // ")[0]), alt);
    ok(/Back to Divination/.test(await page.textContent("#cardModal [data-sheet-back]")), `a better option opens in the sheet with a way back (${alt})`);
    await page.goBack(); await page.waitForTimeout(400);
    ok(await page.isVisible("#cardModal.open") && /Divination/.test(await page.textContent("#cardModal .nameline h2")), "browser Back returns to the card you came from");
    await page.goForward(); await page.waitForTimeout(400);
    ok(/^/.test(alt) && (await page.textContent("#cardModal .nameline h2")).startsWith(alt.split(" // ")[0]), "Forward goes to it again");
    await page.click("#cardModal [data-sheet-back]"); await page.waitForTimeout(400);
    ok(/Divination/.test(await page.textContent("#cardModal .nameline h2")), "the in-sheet Back link works too");
    await page.goBack(); await page.waitForTimeout(400);
    ok(!(await page.$("#cardModal.open")) && page.url() === firstUrl, "Back from the first card closes the sheet and stays on the list");
    await page.click("[data-n='Divination']"); await page.waitForSelector("#cardModal.open .trole");
    await page.click("#cardModal [data-open]"); await page.waitForTimeout(300);
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    ok(!(await page.$("#cardModal.open")) && page.url() === firstUrl, "Escape closes the sheet and unwinds its history");
    await page.goBack(); await page.waitForTimeout(400);
    ok(!(await page.$("#cardModal.open")), "Back after closing doesn't reopen old cards");
    if (mode === "images") {
      // pacing is per page: a new page can't know when the last one asked
      const gaps = sf.slice(1).map((x, i) => x.doc === sf[i].doc ? x.t - sf[i].t : Infinity).filter(g => g !== Infinity);
      ok(gaps.every(g => g >= 500), `Scryfall calls are at least 500 ms apart on each page (${sf.length} calls, min gap ${gaps.length ? Math.min(...gaps) : "n/a"} ms)`);
    }
    ok(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await ctx.close();

    console.log(`\n== card search (${mode})`);
    ({ ctx, page, errors, sf } = await newPage(browser, mode));
    await page.goto(`${BASE}/`);
    if (mode === "images") {
      await page.fill("#q", "t:instant"); await page.keyboard.press("Enter");
      await page.waitForSelector("#grid .tile"); await page.waitForTimeout(800);
      ok(!/f:commander|id<=|o:\//.test(await page.textContent("#status")), "status line hides the query code: " + (await page.textContent("#status")).trim());
      ok(!(await page.isVisible("#type")) && await page.isVisible("#filtersBtn"), "after a search the filters fold behind the button");
      const tierTags = await page.$$eval("#grid .tile .tags a.tag", els => els.map(a => a.querySelector(".ti").textContent + " " + a.querySelector(".tx").textContent + " " + a.querySelector(".rk").textContent));
      ok(tierTags.includes("S Ramp #1"), "result tiles show tier rows (Sol Ring: S Ramp #1)");
      ok(await page.$$eval("#grid .tile .tags", els => els.every(t => getComputedStyle(t).flexDirection === "column")), "tile tags stack one per row");
      ok(await page.$$eval("#grid .tile button.tag[data-role] .ti svg", els => els.length > 0), "function tag rows lead with an icon block");
      const cultTags = await page.$$eval("#grid .tile", ts => { const t = ts.find(x => x.querySelector("img[alt='Cultivate']")); return t ? [...t.querySelectorAll(".tag")].map(g => g.textContent.trim()) : []; });
      ok(cultTags.some(t => /Ramp/.test(t)) && cultTags.includes("Card selection") && cultTags.filter(t => /Ramp/.test(t)).length === 1, "Cultivate: its Ramp tier row, then Card selection (no repeat): " + cultTags.join(" | "));
      ok(await page.$$eval("#grid .tile .tag", els => els.some(t => /Game Changer/.test(t.textContent) && t.querySelector(".ti svg"))), "Game Changer gets its own row on search tiles");
      await page.click("#filtersBtn");
      await page.selectOption("#tier", "B"); await page.waitForTimeout(2500);
      ok(/Filters\s*1/.test(await page.textContent("#filtersBtn")), "Filters button counts active filters");
      ok(/Tier B or better/.test(await page.textContent("#status")), "active filter shows as a chip");
      const shown = await page.$$eval("#grid .tile .card img", els => els.map(e => e.alt));
      ok(shown.includes("Sol Ring") && !shown.includes("Divination") && !shown.includes("Cancel"), `tier B or better filters across all pages (${shown.join(", ")})`);
      await page.selectOption("#order", "tier"); await page.waitForTimeout(2500);
      const order = await page.$$eval("#grid .tile .card img", els => els.map(e => e.alt));
      ok(order[0] === "Sol Ring" || order[0] === "Counterspell" || order[0] === "Swords to Plowshares", "sort by tier puts a top card first: " + order.slice(0, 3).join(", "));
      const searchCalls = sf.filter(x => x.url.includes("/cards/search"));
      const gaps = searchCalls.slice(1).map((x, i) => x.t - searchCalls[i].t);
      ok(gaps.every(g => g >= 500), `search pages are paced 500 ms+ apart (min gap ${Math.min(...gaps)} ms)`);
      await page.click("#grid .tile .card"); await page.waitForSelector("#tierBox .tierrows");
      ok((await page.textContent("#tierBox")).includes("Tiers"), "card modal shows tiers");
      ok((await page.$$("#whatBox .tags.wide button.tag[data-role]")).length > 0, "card modal lists the card's tags");
      ok(!(await page.$("#suggestTier")), "no tier feedback in the search popup");
      await page.screenshot({ path: `${OUT}/search-modal.png` });
      await page.keyboard.press("Escape"); await page.waitForTimeout(400);
      await page.click("#grid .tile .card img[alt='Cultivate']"); await page.waitForSelector("#tierBox [data-better]");
      const firstName = await page.textContent("#sheet .nameline h2");
      {
        await page.click("#tierBox [data-better]"); await page.waitForTimeout(1200);
        ok(await page.isVisible("#sheetBack"), "search popup: a better option shows a Back link");
        await page.goBack(); await page.waitForTimeout(800);
        ok(await page.isVisible("#modal.open") && (await page.textContent("#sheet .nameline h2")) === firstName, `search popup: browser Back returns to ${firstName}`);
      }
      await page.keyboard.press("Escape"); await page.waitForTimeout(400);
      ok(!(await page.isVisible("#modal.open")), "search popup closes");
      // the Tag filter: grouped, searched from the site's own list (no Scryfall search), pictures from the collection endpoint
      await page.goto(`${BASE}/`); await page.waitForTimeout(300);
      const groups = await page.$$eval("#role optgroup", gs => gs.map(g => g.label));
      ok(groups.includes("Interaction") && groups.includes("Combat") && (await page.$$("#role option")).length > 60, "Tag filter is grouped: " + groups.join(", "));
      const before = sf.filter(x => x.url.includes("/cards/search")).length;
      await page.selectOption("#role", "pinger"); await page.click("#go"); await page.waitForSelector("#grid .tile"); await page.waitForTimeout(600);
      const st = await page.textContent("#status");
      ok(/\d+ cards tagged pinger/.test(st) && sf.filter(x => x.url.includes("/cards/search")).length === before, "a tag alone searches the site's list: " + st.trim().slice(0, 60));
      const pingNames = await page.$$eval("#grid .tile .card img", els => els.map(e => e.alt));
      const allPing = await page.evaluate(async ns => { const i = await window.MTG.loadCards(); return ns.every(n => (window.MTG.findCard(i, n)?.tags || []).includes("pinger")); }, pingNames);
      ok(pingNames.length === 60 && allPing, `first page shows 60 cards, every one tagged pinger (${pingNames.slice(0, 4).join(", ")}…)`);
      await page.click("#filtersBtn"); await page.click(".pip[data-c='R']"); await page.waitForTimeout(1500);
      const redPing = await page.textContent("#status");
      ok(/cards tagged pinger/.test(redPing) && +redPing.match(/([\d,]+) cards/)[1].replace(",", "") < +st.match(/([\d,]+) cards/)[1].replace(",", ""), "colors narrow a tag search: " + redPing.trim().slice(0, 40));
      await page.goto(`${BASE}/#role=swap`); await page.waitForSelector("#grid .tile"); await page.waitForTimeout(400);
      ok((await page.$$eval("#grid .tile .card img", els => els.map(e => e.alt))).includes("Twisted Image"), "a #role= link opens that tag (Twisted Image switches power and toughness)");
      await page.fill("#q", "t:instant"); await page.keyboard.press("Enter"); await page.waitForTimeout(3500);
      const both = await page.$$eval("#grid .tile .card img", els => els.map(e => e.alt));
      ok(!both.length || both.every(n => n === "Twisted Image"), "a tag with a text search filters Scryfall's results: " + (both.join(", ") || "none") + " · " + (await page.textContent("#status")).trim().slice(0, 50));
      await page.fill("#q", ""); await page.selectOption("#role", ""); await page.waitForTimeout(200);
    } else {
      ok(await page.$eval("#format", e => e.value) === "commander", "format starts on Commander");
      const box = await page.$eval("#heroFilters #filters", f => ({ w: f.getBoundingClientRect().width, cols: getComputedStyle(f).gridTemplateColumns.split(" ").length, chips: document.querySelector("#chips").getBoundingClientRect().width }));
      ok(box.cols === 2 && box.w > 950, `start-page filter box is wide with two columns (${Math.round(box.w)}px, ${box.cols} columns)`);
      ok(await page.isVisible("#heroFilters #type") && !(await page.isVisible("#filtersBtn")), "start page shows the filters in the middle");
      ok(!(await page.$("#cmode:not([type=hidden])")) && !(await page.$("select#unique")), "identity mode and Show are gone");
      ok(!(await page.isVisible("#format")), "Format and Rarity sit under Advanced");
      ok((await page.$$eval("#type option", o => o.map(x => x.textContent))).includes("Creature"), "card types are capitalized");
      ok(!(await page.$("#random")), "Random button is gone");
      ok(await page.isVisible("#navAcct") && await page.isVisible("#navSaved"), "profile and Saved sit in the header");
      await page.click("#navSaved"); await page.waitForTimeout(300);
      ok(await page.isVisible("#savedView"), "Saved opens");
    }
    ok(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await ctx.close();
  }

  console.log("\n== my decks (no server, so this browser)");
  {
    const { ctx, page, errors } = await newPage(browser, "images");
    await page.goto(`${BASE}/decks/`); await page.waitForSelector("#newForm");
    ok(await page.$eval("nav.site [aria-current=page]", a => a.textContent) === "My Decks", "My Decks tab is in the header");
    ok((await page.$$eval("nav.site a", as => as.map(a => a.textContent))).join("|") === "Card Search|Tier Lists|My Decks|Users", "tab names are title case");
    await page.fill("#newName", "Simic test"); await page.click("#newForm button[type=submit]");
    await page.waitForSelector("#deckView:not([hidden])");
    ok(/Simic test/.test(await page.textContent("#dtop h1")), "new deck opens");
    await page.fill("#addCard", "sol ri"); await page.waitForSelector("#sugg:not([hidden])");
    await page.keyboard.press("Enter"); await page.waitForTimeout(300);
    const inGroup = (g, n) => page.$$eval("#groups .grp", (gs, [g, n]) => gs.some(x => x.querySelector(".dgh").textContent.trim().startsWith(g) && x.querySelector(`[data-open="${n}"]`)), [g, n]);
    ok(await page.$eval("#groupSeg [data-g=type]", b => b.getAttribute("aria-pressed")) === "true", "decks group by Card Type unless changed");
    ok(await inGroup("Artifacts", "Sol Ring"), "typing a name adds it, sorted under Artifacts");
    ok((await page.$$("#groups .gcards .tile .card")).length === 1 && !(await page.$("#groups .drow")), "decks show full cards by default");
    await page.click("#pasteBtn");
    await page.fill("#pasteTxt", "Commander\n1 Tatyova, Benthic Druid (C19) 220\nDeck\n1x Cultivate\n30 Forest\n1 Counterspell *F*\n1 Swords to Plowshares [Removal]\n1 Not A Real Card");
    await page.click(".paste button[type=submit]"); await page.waitForTimeout(400);
    await page.click("#groupSeg [data-g=role]"); await page.waitForTimeout(200);
    const groupsTxt = await page.$$eval("#groups .grp", gs => gs.map(g => g.querySelector(".dgh").textContent.trim()));
    ok(groupsTxt[0].startsWith("Commander") && groupsTxt.some(g => /^Lands\s*30/.test(g)) && groupsTxt.some(g => /^Ramp\s*2/.test(g)) && groupsTxt.some(g => /^Counterspells/.test(g)),
      "pasting a list sets the commander and sorts by role: " + groupsTxt.join(" | "));
    ok(/35/.test(await page.textContent("#stats")), "deck count adds copies: " + (await page.textContent("#stats")).trim().slice(0, 40));
    await page.click("#groupSeg [data-g=type]");
    const typeGroups = await page.$$eval("#groups .dgh span", s => s.map(x => x.textContent));
    ok(typeGroups.includes("Lands") && typeGroups.includes("Instants") && typeGroups.includes("Sorceries"), "group by card type: " + typeGroups.join(", "));
    await page.click("#groupSeg [data-g=mv]");
    ok((await page.$$eval("#groups .dgh span", s => s.map(x => x.textContent))).includes("1 mana"), "group by mana value");
    await page.click("#groupSeg [data-g=role]");
    await page.click("[data-menu='Counterspell']");
    await page.selectOption(".cardmenu select", "protection"); await page.waitForTimeout(200);
    ok(await inGroup("Protection", "Counterspell"), "a card can be moved to another group");
    await page.waitForTimeout(1500);
    ok((await page.$$("#groups .tile .card")).length >= 6, "the deck shows as full cards");
    await page.screenshot({ path: `${OUT}/deck-cards.png` });
    await page.click(".sizetop [data-size=condensed]"); await page.waitForTimeout(200);
    ok((await page.$$("#groups .drow")).length === 6 && !(await page.$("#groups .card")), "Condensed shows names only, no images");
    await page.screenshot({ path: `${OUT}/deck-list.png`, fullPage: true });
    await page.reload(); await page.waitForSelector("#deckView:not([hidden]) .drow");
    ok((await page.$$("#groups .drow")).length === 6, "the deck is still there after a reload");
    // Back from a card sheet on the deck page stays on the deck
    const deckUrl = page.url();
    await page.click("#groups [data-open='Cultivate']"); await page.waitForSelector("#cardModal.open");
    await page.goBack(); await page.waitForTimeout(400);
    ok(!(await page.$("#cardModal.open")) && page.url() === deckUrl, "Back closes a card sheet on the deck page");
    // recommendations instead of "better" cards, never cards already in the deck
    const deckNames = () => page.evaluate(() => JSON.parse(localStorage.getItem("mournyl-mtg-decks"))[0].cards.map(c => c.n));
    await page.click("#groups [data-open='Sol Ring']"); await page.waitForSelector("#cardModal.open .rec");
    const recHead = await page.$$eval("#cardModal .sheet h3", hs => hs.map(h => h.textContent));
    const recNames = await page.$$eval("#cardModal .rec [data-open]", bs => bs.map(b => b.dataset.open));
    const before = await deckNames();
    ok(recHead.some(h => /^Recommended ramp for Tatyova/.test(h)) && !recHead.some(h => /^Better/.test(h)), "a deck card shows Recommended, not Better: " + recHead.filter(h => /Recommend/.test(h)).join(" | "));
    ok(recNames.length >= 3 && !recNames.some(n => before.includes(n)), `recommendations skip cards already in the deck (${recNames.slice(0, 3).join(", ")}…)`);
    await page.click("#cardModal .rec .addrec"); await page.waitForTimeout(400);
    const afterAdd = await deckNames();
    ok(afterAdd.includes(recNames[0]) && !(await page.$$eval("#cardModal .rec [data-open]", bs => bs.map(b => b.dataset.open))).includes(recNames[0]), `+ Add puts ${recNames[0]} in the deck and drops it from the list`);
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    await page.fill("#addCard", "grizzly bears"); await page.waitForSelector("#sugg:not([hidden])"); await page.keyboard.press("Enter"); await page.waitForTimeout(300);
    await page.click("#groups [data-open='Grizzly Bears']"); await page.waitForSelector("#cardModal.open");
    await page.waitForTimeout(300);
    const bearRecs = await page.$$eval("#cardModal .sheet h3", hs => hs.map(h => h.textContent).filter(h => /Recommended/.test(h)));
    ok(bearRecs.length >= 1, "a card on no tier list still gets recommendations: " + bearRecs.join(" | "));
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    await page.fill("#addCard", "blood artist"); await page.waitForSelector("#sugg:not([hidden])"); await page.keyboard.press("Enter"); await page.waitForTimeout(300);
    await page.click(".sizetop [data-size=full]"); await page.click("#groupSeg [data-g=role]"); await page.waitForTimeout(300);
    ok(await inGroup("Death trigger", "Blood Artist") && await inGroup("Other creatures", "Grizzly Bears"), "Role grouping: a card on no tier list goes under its main tag (Blood Artist: Death trigger)");
    await page.click("#groupSeg [data-g=tag]"); await page.waitForTimeout(300);
    const tagGroups = await page.$$eval("#groups .dgh span", s => s.map(x => x.textContent));
    ok(tagGroups.includes("Mana generation") && tagGroups.includes("Extra lands") && tagGroups.includes("Counterspell") && tagGroups.includes("Lands"), "Tag grouping: " + tagGroups.join(", "));
    const artistTags = await page.$$eval("#groups .tile", ts => { const t = ts.find(x => x.querySelector("[data-open='Blood Artist']")); return t ? [...t.querySelectorAll(".tag")].map(g => g.textContent.trim()) : []; });
    ok(artistTags.includes("Death trigger") && artistTags.length <= 4, "deck tiles show function tags: " + artistTags.join(" | "));
    await page.click("#groupSeg [data-g=role]"); await page.click(".sizetop [data-size=condensed]"); await page.waitForTimeout(200);
    await page.evaluate(() => window.MTG.openCard("Some Card Not In The List", {})); await page.waitForTimeout(600);
    ok(await page.isVisible("#cardModal.open") && /Some Card Not In The List/.test(await page.textContent("#cardModal .nameline h2")), "a card missing from the site's list still opens");
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    // remove the extra cards again so the later counts hold
    await page.evaluate(([n]) => { const d = JSON.parse(localStorage.getItem("mournyl-mtg-decks")); d[0].cards = d[0].cards.filter(c => c.n !== n && c.n !== "Grizzly Bears" && c.n !== "Blood Artist"); localStorage.setItem("mournyl-mtg-decks", JSON.stringify(d)); }, [recNames[0]]);
    // + Add to deck from the tier lists
    await page.goto(`${BASE}/tiers/#ramp`); await page.waitForSelector(".tier .rows .row");
    ok(true, "Condensed stays on across pages");
    await page.click(".sizetop [data-size='full']"); await page.waitForSelector(".tier .card");
    await page.click("[data-n='Arcane Signet']"); await page.waitForSelector("#cardModal.open [data-adddeck]");
    await page.click("#cardModal [data-adddeck]"); await page.waitForSelector(".deckmenu button[data-i]");
    await page.click(".deckmenu button[data-i]"); await page.waitForTimeout(300);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("mournyl-mtg-decks"))[0].cards.map(c => c.n));
    ok(saved.includes("Arcane Signet"), "+ Add to deck on a card sheet adds it to the deck");
    await page.goto(`${BASE}/decks/`); await page.waitForSelector(".dcard");
    ok(/Simic test[\s\S]*Tatyova[\s\S]*36 \/ 100/.test(await page.textContent("#deckCards")), "deck list shows name, commander and count");
    ok(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await ctx.close();
  }

  console.log("\n== users (no server)");
  {
    const { ctx, page, errors } = await newPage(browser, "text");
    await page.goto(`${BASE}/users/`); await page.waitForTimeout(800);
    ok(/needs the live site/.test(await page.textContent("#userCards")), "Users says it needs the live site when there's no server");
    ok(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await ctx.close();
  }

  console.log("\n== phone layout");
  for (const [name, url, wait] of [["tiers-hub", "/tiers/", ".rcard"], ["tiers-ramp", "/tiers/#ramp/green", ".tier"], ["search", "/", "#hero"], ["decks", "/decks/", "#newForm"], ["users", "/users/", "#userCards"], ["tiers-protection", "/tiers/#protection", ".levels"]]) {
    const { ctx, page, errors } = await newPage(browser, "images", { ...devices["iPhone 13"] });
    await page.goto(BASE + url); await page.waitForSelector(wait);
    await page.waitForTimeout(600);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 1, `${name}: no sideways scroll on a phone (${over}px)`);
    await page.screenshot({ path: `${OUT}/phone-${name}.png` });
    ok(await page.isVisible("#navAcct"), `${name}: profile visible on a phone`);
    ok(errors.length === 0, `${name}: no script errors` + (errors.length ? ": " + errors.join(" | ") : ""));
    await ctx.close();
  }

  for (const [from, to] of [["/counterspells/#blue", /tiers\/#counterspells\/(blue|u)$/], ["/tiers/ramp/", /tiers\/#ramp$/], ["/saved/", /\/#saved$/]]) {
    const { ctx, page } = await newPage(browser, "text");
    await page.goto(BASE + from); await page.waitForTimeout(500);
    ok(to.test(page.url()), `${from} forwards to ${page.url().replace(BASE, "")}`);
    await ctx.close();
  }
  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nall page checks passed");
  process.exit(failures ? 1 : 0);
})();
