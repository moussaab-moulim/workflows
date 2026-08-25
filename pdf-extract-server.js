const http = require("http");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

const monthNamesFr = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

async function getText(buffer) {
  const data = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({ data }).promise;
  let fullText = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map((it) => it.str).join(" ") + "\n";
  }
  return fullText;
}

function toNumber(str) {
  return parseFloat(str.replace(/\s/g, "").replace(",", "."));
}

// Every regex targets a stable label on the vendor's PDF (not a hardcoded number),
// verified against real bills. Rent uses "Total à régler" (actual bank debit,
// includes one-off adjustments some months) and phone uses the recurring
// subscription charge rather than "Montant net à payer" (which can read 0.00€ on
// months a device-refund credit lands) — both per explicit user confirmation.
function extractAmount(docType, text, monthLabel, monthNum, year) {
  if (docType === "rent") {
    const m = text.match(/Total\s*à\s*régler\s*(?:\(\d+\))?\s*([\d]+[.,]\d{2})/i);
    return m ? toNumber(m[1]) : null;
  }
  if (docType === "phone") {
    const m = text.match(/Montant\s*factur[ée]\s*\([^)]*\)\s*([\d]+[.,]\d{2})\s*€\s*TTC/i);
    return m ? toNumber(m[1]) : null;
  }
  if (docType === "wifi") {
    const m = text.match(/Somme\s*à\s*payer\s*le\s*\d{1,2}\s*\p{L}+\s*\d{4}\s*([\d]+[.,]\d{2})\s*€/iu);
    return m ? toNumber(m[1]) : null;
  }
  if (docType === "electricity") {
    const re = new RegExp("(\\p{L}+)\\s+(\\d{4})\\s+\\d{2}/\\d{2}/\\d{4}\\s+([\\d]+[.,]\\d{2})\\s*€", "giu");
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match[1].toLowerCase() === monthLabel && match[2] === String(year)) {
        return toNumber(match[3]);
      }
    }
    return null;
  }
  if (docType === "water") {
    const re = /(\d{2})\/(\d{2})\/(\d{4})\s+([\d]+[.,]\d{2})\s*€/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (parseInt(match[2], 10) === monthNum && parseInt(match[3], 10) === year) {
        return toNumber(match[4]);
      }
    }
    return null;
  }
  return null;
}

const RULES = [
  { type: "rent", category: "Télétravail", typeDeFrais: "Loyer", label: "loyer" },
  { type: "water", category: "Télétravail", typeDeFrais: "Facture d'eau", label: "eau" },
  { type: "electricity", category: "Télétravail", typeDeFrais: "Facture électricité", label: "électricité" },
  { type: "wifi", category: "Autres", typeDeFrais: "Abonnement téléphonique / internet", label: "internet" },
  { type: "phone", category: "Autres", typeDeFrais: "Abonnement téléphonique / internet", label: "téléphone" },
];

async function handleExtractBills(body) {
  const { month, files } = body;
  const [year, monthNum] = month.split("-").map(Number);
  const monthLabel = monthNamesFr[monthNum - 1];
  const dateDeLaNote = "01/" + String(monthNum).padStart(2, "0") + "/" + year;

  const results = [];
  for (const rule of RULES) {
    const fileBase64 = files && files[rule.type];
    if (!fileBase64) {
      results.push({ month, docType: rule.type, amount: null, category: rule.category, typeDeFrais: rule.typeDeFrais, comment: rule.label + " " + monthLabel, dateDeLaNote, status: "file_missing" });
      continue;
    }
    const text = await getText(Buffer.from(fileBase64, "base64"));
    const amount = extractAmount(rule.type, text, monthLabel, monthNum, year);
    results.push({ month, docType: rule.type, amount, category: rule.category, typeDeFrais: rule.typeDeFrais, comment: rule.label + " " + monthLabel, dateDeLaNote, status: amount === null ? "amount_not_found" : "ok" });
  }
  return results;
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/extract-bills") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        const rows = await handleExtractBills(parsed);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ rows }));
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

server.listen(4000, () => console.log("pdf-extract listening on 4000"));
