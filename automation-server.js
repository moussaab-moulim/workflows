const http = require("http");
const { chromium } = require("playwright");

const BASE_URL = "https://extranet.digiportage.com";

async function loginAndGetPage(browser) {
  const page = await browser.newPage();
  await page.goto(BASE_URL + "/", { waitUntil: "networkidle" });
  await page.fill("#ed_login", process.env.DIGIPORTAGE_EMAIL);
  await page.fill("#ed_password", process.env.DIGIPORTAGE_PASSWORD);
  await page.click("#login");
  await page.waitForURL(/home\.php/, { timeout: 15000 });
  return page;
}

// The CRA page always opens on whatever month is currently editable (not
// necessarily the target month — after the 27th it rolls to next month).
// Compute the click delta from the picker's actual value rather than assuming
// a fixed number of clicks, so this stays correct on any day of the month.
async function navigateToMonth(page, targetMonth) {
  await page.goto(BASE_URL + "/modules/cra/", { waitUntil: "networkidle" });
  await page.waitForSelector("#monthPicker", { timeout: 15000 });

  const [targetYear, targetMonthNum] = targetMonth.split("-").map(Number);

  for (let i = 0; i < 24; i++) {
    const current = await page.inputValue("#monthPicker");
    const [curMonth, curYear] = current.split("/").map(Number);
    const diff = (targetYear * 12 + targetMonthNum) - (curYear * 12 + curMonth);
    if (diff === 0) break;
    await page.evaluate(diff > 0 ? "nextMonth()" : "previousMonth()");
    await page.waitForTimeout(1800);
  }

  const finalValue = await page.inputValue("#monthPicker");
  const [finalMonth, finalYear] = finalValue.split("/").map(Number);
  if (finalYear !== targetYear || finalMonth !== targetMonthNum) {
    throw new Error(`Could not navigate to ${targetMonth}, stuck at ${finalValue}`);
  }
}

// Frais Supplémentaires: unlike CRA, this needs NO month navigation. The site
// always opens "Ajouter" against whatever period is currently open (rolls to
// next month after the 27th, same cutoff as CRA) — the expense's real month is
// carried entirely by the "date de la note" field, independent of which period
// it's filed under. Confirmed live: adding a Juillet-dated expense while the
// open period is Août still shows in the site's own Juillet-dated total.
async function gotoFraisSupp(page) {
  await page.goto(BASE_URL + "/modules/frais/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.click("text=Frais supplémentaires");
  await page.waitForTimeout(1500);
}

async function handleFraisList() {
  const browser = await chromium.launch();
  try {
    const page = await loginAndGetPage(browser);
    await gotoFraisSupp(page);

    const rows = await page.$$eval("#supp table tr", (trs) =>
      trs
        .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim()))
        .filter((cells) => cells.length === 6 && cells[0])
        .map(([date, mission, type, montant, facturation]) => ({
          date,
          mission,
          type,
          montant: parseFloat(montant.replace("€", "").replace(",", ".")),
          facturation,
        }))
    );
    return { rows };
  } finally {
    await browser.close();
  }
}

// dateDeLaNote arrives as "DD/MM/YYYY" (matches the monthly_expenses Data Table
// column) — the <input type=date> field needs "YYYY-MM-DD".
function toIsoDate(ddmmyyyy) {
  const [d, m, y] = ddmmyyyy.split("/");
  return `${y}-${m}-${d}`;
}

async function waitForOverlayToClear(page) {
  await page.waitForSelector("#loading", { state: "visible", timeout: 5000 }).catch(() => {});
  await page.waitForFunction(
    () => {
      const el = document.getElementById("loading");
      return !el || el.style.display === "none";
    },
    { timeout: 60000 }
  );
}

async function handleFraisAdd(body) {
  const { fileBase64, fileName, category, typeDeFrais, dateDeLaNote, amount, comment } = body;
  const browser = await chromium.launch();
  try {
    const page = await loginAndGetPage(browser);
    await gotoFraisSupp(page);

    const addHref = await page.getAttribute("#supp a.btn-primary", "href");
    if (!addHref) throw new Error("Could not find the Ajouter link on the Frais supplémentaires tab");
    await page.goto(BASE_URL + addHref, { waitUntil: "networkidle" });

    await page.setInputFiles("#ed_file", {
      name: fileName,
      mimeType: "application/pdf",
      buffer: Buffer.from(fileBase64, "base64"),
    });
    // The OCR/extraction pass after picking the file shows the #loading overlay —
    // wait it out before clicking Suivant (clicking while visible silently no-ops,
    // the overlay eats the click).
    await waitForOverlayToClear(page);
    // Clicking Suivant fires an async POST (action=post_pj) that creates the real
    // note-de-frais row, then the page NAVIGATES from key=0000000 to a real key —
    // a real page load, not just the overlay toggling on the same page. Waiting on
    // #loading here is a race: it can clear before the navigation actually
    // happens, leaving the selector wait below looking at a half-loaded document.
    // Wait for the URL itself to change instead (confirmed live: can take ~9s).
    const urlBeforeSuivant = page.url();
    await Promise.all([
      page.waitForURL((url) => url.toString() !== urlBeforeSuivant, { timeout: 30000 }),
      page.click("input[type=submit][value=Suivant]"),
    ]);
    await page.waitForLoadState("networkidle", { timeout: 30000 });
    await page.waitForSelector("#sel_code_parent_type_frais", { timeout: 15000 });

    await page.selectOption("#sel_code_parent_type_frais", { label: category });
    await page.waitForTimeout(2500); // type-de-frais options repopulate via AJAX
    await page.selectOption("#sel_code_type_frais", { label: typeDeFrais });
    await page.waitForTimeout(2500); // refacturable options + default repopulate via AJAX

    await page.fill("#ed_date_frais", toIsoDate(dateDeLaNote));
    await page.locator("#ed_date_frais").blur();
    await page.fill("#ed_montant_ttc", String(amount));
    await page.locator("#ed_montant_ttc").blur();
    await page.fill("#ed_commentaire_detail", comment);
    await page.locator("#ed_commentaire_detail").blur();
    await page.waitForTimeout(1500);

    // "Refacturable au client" defaults correctly per category/type once repopulated
    // (confirmed: Télétravail → "Non refacturable client" by default) — only override
    // if a "Non refacturable*" option exists and isn't already selected.
    const refacturableState = await page.$eval("#sel_refacturable", (el) => ({
      selected: el.selectedOptions[0]?.textContent.trim() || "",
      options: Array.from(el.options).map((o) => o.textContent.trim()),
    }));
    if (!refacturableState.selected.startsWith("Non refacturable")) {
      const nonRefac = refacturableState.options.find((o) => o.startsWith("Non refacturable"));
      if (nonRefac) {
        await page.selectOption("#sel_refacturable", { label: nonRefac });
        await page.waitForTimeout(1000);
      }
    }

    // The "Enregistrer" submit button is hidden until every mandatory field
    // (date, mission, catégorie, type, montant TTC, TVA, commentaire) validates —
    // it only renders once that's satisfied. This is the actual save action;
    // nothing before this point persists anything server-side.
    const saveButton = page.locator("#frm_frais [type=submit]");
    await saveButton.waitFor({ state: "visible", timeout: 10000 });
    await saveButton.click();
    await page.waitForURL(/tab=supp/, { timeout: 15000 });

    return { ok: true, category, typeDeFrais, dateDeLaNote, amount, comment };
  } finally {
    await browser.close();
  }
}

async function handleCraDays(body) {
  const { month } = body;
  const browser = await chromium.launch();
  try {
    const page = await loginAndGetPage(browser);
    await navigateToMonth(page, month);

    const headingText = await page.$eval("body", (b) => {
      const m = b.innerText.match(/Compte rendu d'activité du mois de [^\n]+/);
      return m ? m[0] : null;
    });
    const daysEl = await page.$(".mission-days-count");
    const days = daysEl ? parseInt((await daysEl.innerText()).trim(), 10) : null;

    return { month, days, heading: headingText };
  } finally {
    await browser.close();
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/cra-days") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        const result = await handleCraDays(parsed);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/frais/list") {
    handleFraisList()
      .then((result) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      })
      .catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }
  if (req.method === "POST" && req.url === "/frais/add") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        const result = await handleFraisAdd(parsed);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(4001, () => console.log("automation server listening on 4001"));
