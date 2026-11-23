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
    oracle_text: `Rules text of ${name}.`, image_uris: { small: u, normal: u, large: u }, prices: { usd: "1.23", eur: "1.10" },
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
    const before = await page.$$eval("#tier-d .row", r => r.length);
    await page.click("#tier-d [data-more]");
    const after = await page.$$eval("#tier-d .row", r => r.length);
    ok(after === before + 100, `show more adds 100 rows (${before} -> ${after})`);
    await page.selectOption("#mv", "1");
    await page.check("#inst");
    const mvs = await page.$$eval("#board [data-n]", els => els.length);
    ok(mvs > 0, "MV and instant filters leave cards");
    await page.click(".tab[data-t='D']"); await page.click(".tab[data-t='F']");
    ok(!(await page.$("#tier-d")), "tier toggle hides D");
    await page.click("#clear");
    // card sheet
    await page.goto(`${BASE}/tiers/#draw`); await page.waitForTimeout(300); await page.waitForSelector(".tier .card");
    await page.fill("#q", "divination"); await page.waitForTimeout(400);
    await page.click("[data-n='Divination']");
    await page.waitForSelector("#cardModal.open .trole");
    const sheet = await page.textContent("#cardModal");
    ok(sheet.includes("Card draw") && sheet.includes("Better card draw"), "card sheet shows tiers and better options");
    await page.screenshot({ path: `${OUT}/card-sheet-${mode}.png` });
    await page.click("[data-feedback]"); await page.click("#fbForm button[type=submit]");
    await page.waitForFunction(() => /preview|server|queue|reachable/i.test(document.querySelector("#fbMsg").textContent));
    ok(true, "feedback form answers without a server: " + (await page.textContent("#fbMsg")));
    await page.keyboard.press("Escape");
    ok(!(await page.$("#cardModal.open")), "Escape closes the sheet");
    if (mode === "images") {
      const gaps = sf.slice(1).map((x, i) => x.t - sf[i].t);
      ok(gaps.every(g => g >= 500), `Scryfall calls are at least 500 ms apart (${sf.length} calls, min gap ${gaps.length ? Math.min(...gaps) : "n/a"} ms)`);
    }
    ok(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await ctx.close();

    console.log(`\n== deck checker (${mode})`);
    ({ ctx, page, errors } = await newPage(browser, mode));
    await page.goto(`${BASE}/deck/`);
    await page.click("#sample");
    await page.waitForSelector(".stat");
    const txt = await page.textContent("#report");
    ok(txt.includes("100/100") && txt.includes("Legal"), "sample deck: 100 cards, legal");
    ok(/Game Changers: 4 \(max 3\)/.test(txt), "house rules flag 4 Game Changers");
    ok(txt.includes("Divination"), "weak links list Divination");
    ok(/didn't|isn't|preview/i.test(await page.textContent("#comboRows")), "Spellbook falls back without a server");
    await page.screenshot({ path: `${OUT}/deck-${mode}.png`, fullPage: true });
    // pick the first replacement for the first weak card and apply it
    const firstOpt = await page.$("#report .picks input[type=radio][value]:not([value=''])");
    const swapIn = await firstOpt.getAttribute("value"), swapOut = await firstOpt.getAttribute("data-out");
    await firstOpt.check();
    await page.click("#applySwaps"); await page.waitForTimeout(400);
    const list = await page.inputValue("#list");
    ok(list.includes("1 " + swapIn) && !list.includes("1 " + swapOut + "\n"), `apply swaps: ${swapOut} -> ${swapIn}`);
    // save in this browser (no server here)
    await page.fill("#deckName", "Niv test"); await page.click("#saveBtn"); await page.waitForTimeout(300);
    ok((await page.textContent("#savedSel")).includes("Niv test"), "deck saves in this browser without a server");
    // typo fix
    await page.fill("#list", "Commander\n1 Niv-Mizzet, Parun\n\nDeck\n1 Brainstrom\n1 Sol Ring");
    await page.click("#check"); await page.waitForSelector("[data-fix]");
    await page.click("[data-fix][data-to='Brainstorm']"); await page.waitForTimeout(300);
    ok((await page.inputValue("#list")).includes("1 Brainstorm"), "did-you-mean fixes the line");
    ok(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await ctx.close();

    console.log(`\n== slot finder (${mode})`);
    ({ ctx, page, errors } = await newPage(browser, mode));
    await page.goto(`${BASE}/build/`);
    await page.fill("#cmd1", "Niv-Mizzet, Parun");
    await page.fill("#need", "2 ramp at 3 mana or less");
    await page.click("#go");
    await page.waitForSelector("#out .tile");
    const sel = await page.evaluate(() => [document.querySelector("#role").value, document.querySelector("#n").value, document.querySelector("#mv").value].join(","));
    ok(sel === "ramp,2,3", "phrase fills the form (ramp, 2, max 3)");
    const names = await page.$$eval("#out .tile .card", els => els.map(e => e.dataset.n));
    ok(names.includes("Sol Ring") && !names.includes("Cultivate"), "picks fit Izzet colors (Sol Ring yes, Cultivate no)");
    await page.screenshot({ path: `${OUT}/build-${mode}.png` });
    await page.click(`[data-pick='${names[0]}']`); await page.click(`[data-pick='${names[1]}']`);
    ok((await page.textContent("#trayCount")) === "2 picked", "two picks in the tray");
    await page.click("#toDeck"); await page.waitForURL(/deck\//); await page.waitForSelector(".stat");
    ok((await page.inputValue("#list")).includes("1 " + names[0]), "picks carry over to the deck checker");
    ok(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await ctx.close();

    console.log(`\n== card search (${mode})`);
    ({ ctx, page, errors, sf } = await newPage(browser, mode));
    await page.goto(`${BASE}/`);
    if (mode === "images") {
      await page.fill("#q", "t:instant"); await page.keyboard.press("Enter");
      await page.waitForSelector("#grid .tile"); await page.waitForTimeout(800);
      ok(/Ramp #1/.test(await page.textContent("#grid")), "result tiles show tier badges (Sol Ring: Ramp #1)");
      await page.selectOption("#tier", "B"); await page.waitForTimeout(2500);
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
      await page.screenshot({ path: `${OUT}/search-modal.png` });
      await page.keyboard.press("Escape");
    } else {
      ok((await page.$$("nav a")).length >= 3, "nav links to the new pages");
      await page.click("#navSaved"); await page.waitForTimeout(500);
      await page.click("[data-tab='decks']"); await page.waitForTimeout(300);
      ok(/No saved decks|deck checker/i.test(await page.textContent("#deckGrid")), "Saved view has a Decks tab");
    }
    ok(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await ctx.close();
  }

  console.log("\n== phone layout");
  for (const [name, url, wait] of [["tiers-hub", "/tiers/", ".rcard"], ["tiers-ramp", "/tiers/#ramp/green", ".tier"], ["deck", "/deck/", "#sample"], ["build", "/build/#cmd=Niv-Mizzet%2C%20Parun&need=2%20ramp", "#out .tile"]]) {
    const { ctx, page, errors } = await newPage(browser, "images", { ...devices["iPhone 13"] });
    await page.goto(BASE + url); await page.waitForSelector(wait);
    if (name === "deck") { await page.click("#sample"); await page.waitForSelector(".stat"); }
    await page.waitForTimeout(600);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 1, `${name}: no sideways scroll on a phone (${over}px)`);
    await page.screenshot({ path: `${OUT}/phone-${name}.png` });
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
