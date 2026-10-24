const http = require("http");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

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
//
// AMOUNT tolerates a French thousands-separator space (e.g. "1 019.26"), not just
// plain "836.67" — found live when October's rent crossed 1000€ and the regex
// couldn't match past the embedded space before the decimal point.
const AMOUNT = "[\\d]+(?:\\s\\d{3})*[.,]\\d{2}";

function extractAmount(docType, text, monthLabel, monthNum, year) {
  if (docType === "rent") {
    const m = text.match(new RegExp("Total\\s*à\\s*régler\\s*(?:\\(\\d+\\))?\\s*(" + AMOUNT + ")", "i"));
    return m ? toNumber(m[1]) : null;
  }
  if (docType === "phone") {
    const m = text.match(new RegExp("Montant\\s*factur[ée]\\s*\\([^)]*\\)\\s*(" + AMOUNT + ")\\s*€\\s*TTC", "i"));
    return m ? toNumber(m[1]) : null;
  }
  if (docType === "wifi") {
    const m = text.match(new RegExp("Somme\\s*à\\s*payer\\s*le\\s*\\d{1,2}\\s*\\p{L}+\\s*\\d{4}\\s*(" + AMOUNT + ")\\s*€", "iu"));
    return m ? toNumber(m[1]) : null;
  }
  if (docType === "electricity") {
    const re = new RegExp("(\\p{L}+)\\s+(\\d{4})\\s+\\d{2}/\\d{2}/\\d{4}\\s+(" + AMOUNT + ")\\s*€", "giu");
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match[1].toLowerCase() === monthLabel && match[2] === String(year)) {
        return toNumber(match[3]);
      }
    }
    return null;
  }
  if (docType === "water") {
    const re = new RegExp("(\\d{2})/(\\d{2})/(\\d{4})\\s+(" + AMOUNT + ")\\s*€", "g");
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
      results.push({ month, docType: rule.type, amount: null, category: rule.category, typeDeFrais: rule.typeDeFrais, comment: rule.label + " " + monthLabel, dateDeLaNote, status: "file_missing", debugText: null });
      continue;
    }
    const text = await getText(Buffer.from(fileBase64, "base64"));
    const amount = extractAmount(rule.type, text, monthLabel, monthNum, year);
    // On failure, keep the first 1000 chars of the extracted text so a future miss
    // is diagnosable straight from the Data Table row, instead of redeploying a
    // throwaway debug endpoint every time a vendor changes their PDF format.
    results.push({ month, docType: rule.type, amount, category: rule.category, typeDeFrais: rule.typeDeFrais, comment: rule.label + " " + monthLabel, dateDeLaNote, status: amount === null ? "amount_not_found" : "ok", debugText: amount === null ? text.slice(0, 1000) : null });
  }
  return results;
}

// Fixed coordinates match the CRA template's "Jour" and "Total" row cells,
// found by trial against the real template (see local session history).
async function handleFillCraPdf(body) {
  const { fileBase64, dayCount } = body;
  const pdfDoc = await PDFDocument.load(Buffer.from(fileBase64, "base64"));
  const page = pdfDoc.getPages()[0];
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const valueX = 235.5;
  const jourRowY = 386.7;
  const totalRowY = 337.2;
  page.drawText(String(dayCount), { x: valueX, y: jourRowY, size: 11, font, color: rgb(0, 0, 0) });
  page.drawText(String(dayCount), { x: valueX, y: totalRowY, size: 11, font, color: rgb(0, 0, 0) });

  const filledBytes = await pdfDoc.save();
  return { fileBase64: Buffer.from(filledBytes).toString("base64") };
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
  if (req.method === "POST" && req.url === "/fill-cra-pdf") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        const result = await handleFillCraPdf(parsed);
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

server.listen(4000, () => console.log("pdf-extract listening on 4000"));
