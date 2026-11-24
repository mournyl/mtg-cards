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
    sf.push({ t: Date.now(), url: r.request().url() });
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
    await page.waitForSelector("#board .row");
    ok((await page.textContent("#board")).includes("Ramp #1"), "hub search finds Sol Ring as Ramp #1");
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
    await page.goto(`${BASE}/tiers/#removal/id-ub`); await page.waitForTimeout(300);
    await page.waitForSelector(".tier");
    const pipsOn = await page.$$eval("#minePips .pip[aria-pressed='true']", els => els.map(e => e.dataset.c).join(""));
    ok(pipsOn === "UB", "My colors route picks U and B");
    // filters + show more
    await page.goto(`${BASE}/tiers/#draw`); await page.waitForTimeout(300);
    await page.waitForSelector("[data-more]");
    const before = await page.$$eval("#tier-d .tile", r => r.length);
    await page.click("#tier-d [data-more]");
    const after = await page.$$eval("#tier-d .tile", r => r.length);
    ok(after === before + 48, `lower tiers show full cards, 48 more at a time (${before} -> ${after})`);
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
    await page.click("[data-pt='phasing']"); await page.waitForTimeout(300);
    const ph = await page.$$eval("#board [data-n]", els => els.map(e => e.dataset.n));
    ok(ph.includes("Slip Out the Back") && ph.includes("Teferi's Protection") && !ph.includes("Lightning Greaves"), `protection type filter: phasing (${ph.length} cards)`);
    const slip = await page.$$eval(".tile", ts => { const t = ts.find(x => x.querySelector("[data-n='Slip Out the Back']")); return t ? [...t.querySelectorAll(".tags .tag")].map(r => (r.querySelector(".ti svg") ? "icon " : "") + r.textContent.trim()) : []; });
    ok(slip.includes("icon One creature") && slip.includes("icon Phasing"), "tile tags are rows with icons: " + slip.join(" | "));
    // card sheet
    await page.goto(`${BASE}/tiers/#draw`); await page.waitForTimeout(300); await page.waitForSelector(".tier .card");
    await page.fill("#q", "divination"); await page.waitForTimeout(400);
    await page.click("[data-n='Divination']");
    await page.waitForSelector("#cardModal.open .trole");
    const sheet = await page.textContent("#cardModal");
    ok(sheet.includes("Card draw") && sheet.includes("Better card draw"), "card sheet shows tiers and better options");
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
      const gaps = sf.slice(1).map((x, i) => x.t - sf[i].t);
      ok(gaps.every(g => g >= 500), `Scryfall calls are at least 500 ms apart (${sf.length} calls, min gap ${gaps.length ? Math.min(...gaps) : "n/a"} ms)`);
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
      ok(await page.$$eval("#grid .tile button.tag[data-role='draw'] .ti svg", els => els.length > 0), "role rows lead with an icon block (Card draw)");
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
    } else {
      ok(await page.$eval("#format", e => e.value) === "commander", "format starts on Commander");
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
    ok(await page.$eval("nav.site [aria-current=page]", a => a.textContent) === "My decks", "My decks tab is in the header");
    await page.fill("#newName", "Simic test"); await page.click("#newForm button[type=submit]");
    await page.waitForSelector("#deckView:not([hidden])");
    ok(/Simic test/.test(await page.textContent("#dtop h1")), "new deck opens");
    await page.fill("#addCard", "sol ri"); await page.waitForSelector("#sugg:not([hidden])");
    await page.keyboard.press("Enter"); await page.waitForTimeout(300);
    ok(/Ramp[\s\S]*Sol Ring/.test(await page.textContent("#groups")), "typing a name adds it, sorted under Ramp");
    await page.click("#pasteBtn");
    await page.fill("#pasteTxt", "Commander\n1 Tatyova, Benthic Druid (C19) 220\nDeck\n1x Cultivate\n30 Forest\n1 Counterspell *F*\n1 Swords to Plowshares [Removal]\n1 Not A Real Card");
    await page.click(".paste button[type=submit]"); await page.waitForTimeout(400);
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
    ok(/Protection[\s\S]*Counterspell/.test(await page.$eval("#groups", g => [...g.querySelectorAll(".grp")].find(x => /Protection/.test(x.textContent))?.textContent || "")), "a card can be moved to another group");
    await page.click("#viewSeg [data-v=cards]"); await page.waitForTimeout(1500);
    ok((await page.$$("#groups .tile .card")).length >= 6, "card view shows the deck as cards");
    await page.screenshot({ path: `${OUT}/deck-cards.png` });
    await page.click("#viewSeg [data-v=list]");
    await page.screenshot({ path: `${OUT}/deck-list.png`, fullPage: true });
    await page.reload(); await page.waitForSelector("#deckView:not([hidden]) .drow");
    ok((await page.$$("#groups .drow")).length === 6, "the deck is still there after a reload");
    // Back from a card sheet on the deck page stays on the deck
    const deckUrl = page.url();
    await page.click("#groups [data-open='Cultivate']"); await page.waitForSelector("#cardModal.open");
    await page.goBack(); await page.waitForTimeout(400);
    ok(!(await page.$("#cardModal.open")) && page.url() === deckUrl, "Back closes a card sheet on the deck page");
    // + Add to deck from the tier lists
    await page.goto(`${BASE}/tiers/#ramp`); await page.waitForSelector(".tier .card");
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

  console.log("\n== phone layout");
  for (const [name, url, wait] of [["tiers-hub", "/tiers/", ".rcard"], ["tiers-ramp", "/tiers/#ramp/green", ".tier"], ["search", "/", "#hero"], ["decks", "/decks/", "#newForm"]]) {
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

  for (const [from, to] of [["/counterspells/#blue", /tiers\/#counterspells\/blue$/], ["/tiers/ramp/", /tiers\/#ramp$/], ["/saved/", /\/#saved$/]]) {
    const { ctx, page } = await newPage(browser, "text");
    await page.goto(BASE + from); await page.waitForTimeout(500);
    ok(to.test(page.url()), `${from} forwards to ${page.url().replace(BASE, "")}`);
    await ctx.close();
  }
  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nall page checks passed");
  process.exit(failures ? 1 : 0);
})();
