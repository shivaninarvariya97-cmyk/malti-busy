require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const XLSX = require("xlsx");
const { MongoClient } = require("mongodb");
const { PDFParse } = require("pdf-parse");

const app = express();

const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4000),
  jwtSecret: process.env.JWT_SECRET || "busy-ai-secret",
  corsOrigin: process.env.CORS_ORIGIN || "*",
  dataFile: path.resolve(__dirname, process.env.DATA_FILE || "./data/store.json"),
  mongodbUri: process.env.MONGODB_URI || "",
  mongodbDbName: process.env.MONGODB_DB_NAME || "busy_ai_accounting",
  seedAdminEmail: process.env.SEED_ADMIN_EMAIL || "admin@busy.ai",
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD || "admin123",
  seedDemoEmail: process.env.SEED_DEMO_EMAIL || "owner@busy.ai",
  seedDemoPassword: process.env.SEED_DEMO_PASSWORD || "demo123",
};

config.storageDriver = (
  process.env.STORAGE_DRIVER ||
  (config.mongodbUri ? "mongodb" : "json")
).toLowerCase();

const CLIENT_DIST = path.join(__dirname, "client", "dist");
const upload = multer({ storage: multer.memoryStorage() });

app.use(
  cors({
    origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",").map((item) => item.trim()),
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function currency(value) {
  return Number(Number(value || 0).toFixed(2));
}

function sanitizeUser(user) {
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

function createToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    config.jwtSecret,
    { expiresIn: "7d" }
  );
}

function createSeedData() {
  const passwordHash = bcrypt.hashSync(config.seedAdminPassword, 10);
  const demoHash = bcrypt.hashSync(config.seedDemoPassword, 10);

  const seed = {
    users: [
      {
        id: id("user"),
        name: "Admin User",
        email: config.seedAdminEmail.toLowerCase(),
        passwordHash,
        role: "admin",
        status: "active",
        createdAt: new Date().toISOString(),
      },
      {
        id: id("user"),
        name: "Demo Business",
        email: config.seedDemoEmail.toLowerCase(),
        passwordHash: demoHash,
        role: "user",
        status: "active",
        createdAt: new Date().toISOString(),
      },
    ],
      profiles: [],
      invoices: [],
      transactions: [],
      reconciliations: [],
      uploads: [],
  };

  const demoUser = seed.users.find((user) => user.role === "user");
  seed.profiles.push({
    id: id("profile"),
    userId: demoUser.id,
    businessName: "Busy Demo Traders",
    gstNumber: "27ABCDE1234F1Z5",
    bankName: "Axis Bank",
    bankAccount: "XXXXXX9087",
    aiAssistantName: "LedgerLens",
  });
  seed.invoices.push(
    {
      id: id("inv"),
      userId: demoUser.id,
      partyName: "Sunrise Retail",
      item: "Office Chairs",
      quantity: 4,
      rate: 3200,
      gstRate: 18,
      subtotal: 12800,
      gstAmount: 2304,
      total: 15104,
      status: "sent",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 36).toISOString(),
    },
    {
      id: id("inv"),
      userId: demoUser.id,
      partyName: "Metro Foods",
      item: "Packaging Material",
      quantity: 10,
      rate: 580,
      gstRate: 12,
      subtotal: 5800,
      gstAmount: 696,
      total: 6496,
      status: "paid",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString(),
    }
  );
  seed.transactions.push(
    {
      id: id("txn"),
      userId: demoUser.id,
      date: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
      description: "Office rent transfer",
      amount: -18000,
      category: "Rent",
      type: "expense",
      matchedInvoiceId: null,
      source: "seed",
    },
    {
      id: id("txn"),
      userId: demoUser.id,
      date: new Date(Date.now() - 1000 * 60 * 60 * 18).toISOString(),
      description: "Payment received - Metro Foods",
      amount: 6496,
      category: "Sales",
      type: "income",
      matchedInvoiceId: seed.invoices[1].id,
      source: "seed",
    }
  );

  return seed;
}

function createJsonStorage(filePath) {
  return {
    driver: "json",
    async init() {
      ensureDir(path.dirname(filePath));
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(createSeedData(), null, 2));
      }
    },
    async getDb() {
      await this.init();
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    },
    async saveDb(db) {
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, JSON.stringify(db, null, 2));
    },
    async close() {},
  };
}

function createMongoStorage(uri, dbName) {
  const client = new MongoClient(uri);
  let connectedDb;

  async function getCollection() {
    if (!connectedDb) {
      await client.connect();
      connectedDb = client.db(dbName);
    }
    return connectedDb.collection("app_state");
  }

  return {
    driver: "mongodb",
    async init() {
      const collection = await getCollection();
      const state = await collection.findOne({ _id: "busy-app-state" });
      if (!state) {
        await collection.insertOne({ _id: "busy-app-state", ...createSeedData() });
      }
    },
    async getDb() {
      await this.init();
      const collection = await getCollection();
      const state = await collection.findOne({ _id: "busy-app-state" });
      const { _id, ...db } = state;
      return db;
    },
    async saveDb(db) {
      const collection = await getCollection();
      await collection.updateOne(
        { _id: "busy-app-state" },
        { $set: db },
        { upsert: true }
      );
    },
    async close() {
      await client.close();
    },
  };
}

const storage =
  config.storageDriver === "mongodb" && config.mongodbUri
    ? createMongoStorage(config.mongodbUri, config.mongodbDbName)
    : createJsonStorage(config.dataFile);

function userScope(user, entries) {
  return user.role === "admin" ? entries : entries.filter((entry) => entry.userId === user.id);
}

function upsertProfile(db, userId, payload = {}) {
  let profile = db.profiles.find((entry) => entry.userId === userId);

  if (!profile) {
    profile = {
      id: id("profile"),
      userId,
      businessName: "",
      gstNumber: "",
      bankName: "",
      bankAccount: "",
      aiAssistantName: "LedgerLens",
    };
    db.profiles.push(profile);
  }

  Object.assign(profile, payload);
  return profile;
}

function suggestInvoiceFields(partyName, item) {
  const party = String(partyName || "").toLowerCase();
  const product = String(item || "").toLowerCase();

  const gstRate =
    product.includes("service") || product.includes("consult") ? 18 :
    product.includes("food") || product.includes("grain") ? 5 :
    product.includes("pack") ? 12 :
    18;

  const rate =
    product.includes("chair") ? 3200 :
    product.includes("pack") ? 580 :
    product.includes("software") ? 7500 :
    product.includes("service") ? 12000 :
    1500;

  const partySegment =
    party.includes("retail") ? "B2C Retail" :
    party.includes("foods") ? "Distribution" :
    party.includes("tech") ? "Technology" :
    "General";

  return { gstRate, rate, partySegment };
}

function categorizeTransaction(description, amount) {
  const text = String(description || "").toLowerCase();
  if (text.includes("rent")) return "Rent";
  if (text.includes("salary")) return "Payroll";
  if (text.includes("gst")) return "Tax";
  if (text.includes("fuel")) return "Travel";
  if (text.includes("bank")) return "Bank";
  if (text.includes("payment received") || amount > 0) return "Sales";
  return "Operations";
}

function parseCsvBuffer(buffer) {
  const content = buffer.toString("utf8");
  const rows = content
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);

  if (rows.length < 2) return [];

  const headers = rows[0].split(",").map((header) => header.trim().toLowerCase());
  return rows.slice(1).map((row) => {
    const values = row.split(",").map((value) => value.trim());
    const item = {};
    headers.forEach((header, index) => {
      item[header] = values[index] || "";
    });
    return item;
  });
}

async function parsePdfBuffer(buffer) {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy();

  const lines = result.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .map((line) => {
      const amountMatch = line.match(/(-?\d[\d,]*\.?\d{0,2})$/);
      const dateMatch = line.match(/(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/);

      if (!amountMatch) {
        return null;
      }

      return {
        date: dateMatch ? dateMatch[1] : new Date().toLocaleDateString("en-IN"),
        description: line.replace(amountMatch[0], "").trim(),
        amount: Number(amountMatch[0].replace(/,/g, "")),
      };
    })
    .filter(Boolean);
}

function parseSheetBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
}

function normalizeTransactions(rows) {
  return rows
    .map((row) => {
      const date = row.date || row.Date || row.transactionDate || row.TransactionDate;
      const description =
        row.description ||
        row.Description ||
        row.narration ||
        row.Narration ||
        row.details ||
        row.Details;
      const amountRaw =
        row.amount ||
        row.Amount ||
        row.credit ||
        row.Credit ||
        row.debit ||
        row.Debit;

      if (!description || amountRaw === undefined || amountRaw === "") {
        return null;
      }

      const amount = Number(String(amountRaw).replace(/,/g, ""));
      if (Number.isNaN(amount)) {
        return null;
      }

      return {
        date: new Date(date || Date.now()).toISOString(),
        description,
        amount: currency(amount),
        category: categorizeTransaction(description, amount),
        type: amount >= 0 ? "income" : "expense",
      };
    })
    .filter(Boolean);
}

function findInvoiceMatch(invoices, transaction) {
  return invoices.find((invoice) => {
    const desc = transaction.description.toLowerCase();
    return (
      Math.abs(invoice.total - Math.abs(transaction.amount)) < 1 &&
      desc.includes(invoice.partyName.toLowerCase().split(" ")[0])
    );
  });
}

function buildInsights(invoices, transactions) {
  const totals = transactions.reduce(
    (acc, transaction) => {
      if (transaction.amount >= 0) acc.income += transaction.amount;
      else acc.expense += Math.abs(transaction.amount);
      return acc;
    },
    { income: 0, expense: 0 }
  );

  const openInvoices = invoices.filter((invoice) => invoice.status !== "paid");
  const cashflowForecast = currency(
    totals.income - totals.expense + openInvoices.reduce((sum, item) => sum + item.total, 0)
  );

  const anomalies = transactions
    .filter((transaction) => Math.abs(transaction.amount) > 10000)
    .slice(0, 4)
    .map(
      (transaction) =>
        `${transaction.description} for Rs ${Math.abs(transaction.amount).toLocaleString("en-IN")}`
    );

  return {
    cashflowForecast,
    tips: [
      openInvoices.length > 0
        ? `Follow up on ${openInvoices.length} open invoice${openInvoices.length > 1 ? "s" : ""} to improve collections.`
        : "Collections look healthy. Keep invoice turnaround fast.",
      totals.expense > totals.income * 0.75
        ? "Expenses are approaching income. Review recurring outflows this week."
        : "Expense control looks stable. Consider reinvesting surplus into working capital.",
      "Use uploaded statements daily so reconciliation stays near real time.",
    ],
    anomalies,
  };
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

const authRequired = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Authentication required." });
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const db = await storage.getDb();
    const user = db.users.find((entry) => entry.id === payload.id);

    if (!user || user.status !== "active") {
      return res.status(401).json({ message: "Account is unavailable." });
    }

    req.user = user;
    req.db = db;
    req.saveDb = async () => storage.saveDb(req.db);
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid session." });
  }
});

function adminRequired(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin access required." });
  }
  next();
}

app.get("/api/health", asyncHandler(async (_req, res) => {
  await storage.init();
  res.json({
    ok: true,
    storage: storage.driver,
    environment: config.nodeEnv,
  });
}));

app.post("/api/auth/signup", asyncHandler(async (req, res) => {
  const { name, email, password } = req.body || {};
  const db = await storage.getDb();

  if (!name || !email || !password) {
    return res.status(400).json({ message: "Name, email, and password are required." });
  }

  if (db.users.some((user) => user.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ message: "Email already exists." });
  }

  const user = {
    id: id("user"),
    name,
    email: String(email).toLowerCase(),
    passwordHash: bcrypt.hashSync(password, 10),
    role: "user",
    status: "active",
    createdAt: new Date().toISOString(),
  };

  db.users.push(user);
  upsertProfile(db, user.id, { aiAssistantName: "LedgerLens" });
  await storage.saveDb(db);

  const token = createToken(user);
  res.json({ token, user: sanitizeUser(user) });
}));

app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const db = await storage.getDb();
  const user = db.users.find((entry) => entry.email.toLowerCase() === String(email).toLowerCase());

  if (!user || !bcrypt.compareSync(password || "", user.passwordHash)) {
    return res.status(401).json({ message: "Invalid email or password." });
  }

  if (user.status !== "active") {
    return res.status(403).json({ message: "Account is inactive." });
  }

  const token = createToken(user);
  res.json({ token, user: sanitizeUser(user) });
}));

app.get("/api/auth/me", authRequired, asyncHandler(async (req, res) => {
  const profile = upsertProfile(req.db, req.user.id);
  await req.saveDb();
  res.json({ user: sanitizeUser(req.user), profile });
}));

app.get("/api/profile", authRequired, asyncHandler(async (req, res) => {
  const profile = upsertProfile(req.db, req.user.id);
  await req.saveDb();
  res.json(profile);
}));

app.put("/api/profile", authRequired, asyncHandler(async (req, res) => {
  const profile = upsertProfile(req.db, req.user.id, req.body || {});
  await req.saveDb();
  res.json(profile);
}));

app.get("/api/dashboard", authRequired, asyncHandler(async (req, res) => {
  const invoices = userScope(req.user, req.db.invoices);
  const transactions = userScope(req.user, req.db.transactions);
  const insights = buildInsights(invoices, transactions);

  const invoiceTotal = currency(invoices.reduce((sum, invoice) => sum + invoice.total, 0));
  const collected = currency(
    invoices.filter((invoice) => invoice.status === "paid").reduce((sum, invoice) => sum + invoice.total, 0)
  );
  const expenses = currency(
    transactions.filter((transaction) => transaction.amount < 0).reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0)
  );

  res.json({
    summary: {
      invoiceTotal,
      collected,
      expenses,
      openInvoices: invoices.filter((invoice) => invoice.status !== "paid").length,
      unmatchedTransactions: transactions.filter((transaction) => !transaction.matchedInvoiceId).length,
    },
    recentInvoices: invoices.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5),
    recentTransactions: transactions.slice().sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 6),
    insights,
  });
}));

app.get("/api/invoices", authRequired, asyncHandler(async (req, res) => {
  const invoices = userScope(req.user, req.db.invoices).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(invoices);
}));

app.post("/api/invoices", authRequired, asyncHandler(async (req, res) => {
  const { partyName, item, quantity } = req.body || {};
  const suggestions = suggestInvoiceFields(partyName, item);
  const qty = Number(quantity || 1);
  const subtotal = currency(qty * suggestions.rate);
  const gstAmount = currency((subtotal * suggestions.gstRate) / 100);
  const total = currency(subtotal + gstAmount);

  const invoice = {
    id: id("inv"),
    userId: req.user.id,
    partyName,
    item,
    quantity: qty,
    rate: suggestions.rate,
    gstRate: suggestions.gstRate,
    subtotal,
    gstAmount,
    total,
    partySegment: suggestions.partySegment,
    status: "sent",
    createdAt: new Date().toISOString(),
  };

  req.db.invoices.push(invoice);
  await req.saveDb();
  res.status(201).json(invoice);
}));

app.patch("/api/invoices/:id/status", authRequired, asyncHandler(async (req, res) => {
  const invoice = req.db.invoices.find((entry) => entry.id === req.params.id);
  if (!invoice || (req.user.role !== "admin" && invoice.userId !== req.user.id)) {
    return res.status(404).json({ message: "Invoice not found." });
  }

  invoice.status = req.body.status || invoice.status;
  await req.saveDb();
  res.json(invoice);
}));

app.get("/api/transactions", authRequired, asyncHandler(async (req, res) => {
  const transactions = userScope(req.user, req.db.transactions).sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(transactions);
}));

app.post("/api/statements/upload", authRequired, upload.single("statement"), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "Statement file is required." });
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  let rows = [];

  if (ext === ".csv") rows = parseCsvBuffer(req.file.buffer);
  else if (ext === ".xlsx" || ext === ".xls") rows = parseSheetBuffer(req.file.buffer);
  else if (ext === ".pdf") rows = await parsePdfBuffer(req.file.buffer);
  else return res.status(400).json({ message: "Upload CSV, XLSX, XLS, or PDF only." });

  const normalized = normalizeTransactions(rows);
  const invoices = userScope(req.user, req.db.invoices);
  const created = normalized.map((transaction) => {
    const match = findInvoiceMatch(invoices, transaction);
    return {
      id: id("txn"),
      userId: req.user.id,
      ...transaction,
      matchedInvoiceId: match ? match.id : null,
      source: req.file.originalname,
    };
  });

  req.db.transactions.push(...created);
  req.db.uploads.push({
    id: id("upload"),
    userId: req.user.id,
    fileName: req.file.originalname,
    uploadedAt: new Date().toISOString(),
    parsedRows: created.length,
  });
  await req.saveDb();

  res.status(201).json({
    added: created.length,
    unmatched: created.filter((transaction) => !transaction.matchedInvoiceId).length,
    transactions: created,
  });
}));

app.get("/api/reconciliation", authRequired, asyncHandler(async (req, res) => {
  const transactions = userScope(req.user, req.db.transactions);
  const invoices = userScope(req.user, req.db.invoices);

  const suggestions = transactions
    .filter((transaction) => !transaction.matchedInvoiceId)
    .map((transaction) => ({
      transaction,
      suggestedInvoice: findInvoiceMatch(invoices, transaction),
    }));

  res.json(suggestions);
}));

app.post("/api/reconciliation/:transactionId", authRequired, asyncHandler(async (req, res) => {
  const transaction = req.db.transactions.find((entry) => entry.id === req.params.transactionId);
  if (!transaction || (req.user.role !== "admin" && transaction.userId !== req.user.id)) {
    return res.status(404).json({ message: "Transaction not found." });
  }

  transaction.matchedInvoiceId = req.body.invoiceId || null;
  req.db.reconciliations.push({
    id: id("rec"),
    transactionId: transaction.id,
    invoiceId: transaction.matchedInvoiceId,
    approvedBy: req.user.id,
    createdAt: new Date().toISOString(),
  });
  await req.saveDb();
  res.json(transaction);
}));

app.get("/api/reports", authRequired, asyncHandler(async (req, res) => {
  const invoices = userScope(req.user, req.db.invoices);
  const transactions = userScope(req.user, req.db.transactions);

  const gstCollected = currency(invoices.reduce((sum, invoice) => sum + invoice.gstAmount, 0));
  const totalIncome = currency(
    transactions.filter((transaction) => transaction.amount > 0).reduce((sum, transaction) => sum + transaction.amount, 0)
  );
  const totalExpense = currency(
    transactions.filter((transaction) => transaction.amount < 0).reduce((sum, transaction) => sum + Math.abs(transaction.amount), 0)
  );
  const netProfit = currency(totalIncome - totalExpense);

  res.json({
    gst: {
      collected: gstCollected,
      estimatedPayable: currency(gstCollected * 0.82),
      invoicesFiled: invoices.length,
    },
    profitAndLoss: {
      revenue: totalIncome,
      expenses: totalExpense,
      netProfit,
    },
    balanceSheet: {
      assets: currency(
        totalIncome + invoices.filter((invoice) => invoice.status !== "paid").reduce((sum, invoice) => sum + invoice.total, 0)
      ),
      liabilities: currency(totalExpense * 0.35),
      equity: currency(netProfit),
    },
  });
}));

app.get("/api/insights", authRequired, asyncHandler(async (req, res) => {
  const invoices = userScope(req.user, req.db.invoices);
  const transactions = userScope(req.user, req.db.transactions);
  res.json(buildInsights(invoices, transactions));
}));

app.get("/api/admin/overview", authRequired, adminRequired, asyncHandler(async (req, res) => {
  const users = req.db.users;
  const invoices = req.db.invoices;
  const transactions = req.db.transactions;

  res.json({
    userCount: users.length,
    activeUsers: users.filter((user) => user.status === "active").length,
    invoiceCount: invoices.length,
    transactionCount: transactions.length,
    uploads: req.db.uploads.length,
    revenueTracked: currency(invoices.reduce((sum, invoice) => sum + invoice.total, 0)),
  });
}));

app.get("/api/admin/users", authRequired, adminRequired, asyncHandler(async (req, res) => {
  const enriched = req.db.users.map((user) => ({
    ...sanitizeUser(user),
    profile: req.db.profiles.find((profile) => profile.userId === user.id) || null,
    invoiceCount: req.db.invoices.filter((invoice) => invoice.userId === user.id).length,
    transactionCount: req.db.transactions.filter((transaction) => transaction.userId === user.id).length,
  }));
  res.json(enriched);
}));

app.patch("/api/admin/users/:id", authRequired, adminRequired, asyncHandler(async (req, res) => {
  const user = req.db.users.find((entry) => entry.id === req.params.id);
  if (!user) {
    return res.status(404).json({ message: "User not found." });
  }

  if (req.body.status) user.status = req.body.status;
  if (req.body.role) user.role = req.body.role;

  await req.saveDb();
  res.json(sanitizeUser(user));
}));

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^(?!\/api).*/, (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    return res.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    message: config.nodeEnv === "production" ? "Internal server error." : error.message,
  });
});

async function startServer() {
  await storage.init();
  app.listen(config.port, () => {
    console.log(
      `Busy AI server running on http://localhost:${config.port} using ${storage.driver} storage`
    );
  });
}

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
