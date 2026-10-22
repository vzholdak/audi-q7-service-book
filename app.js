"use strict";

const DB_NAME = "service-log-iphone";
const DB_VERSION = 1;
const $ = (selector) => document.querySelector(selector);

const ui = {
  welcome: $("#welcome"),
  welcomeFooter: $("#welcomeFooter"),
  dashboard: $("#dashboard"),
  homeView: $("#homeView"),
  historyView: $("#historyView"),
  documentsView: $("#documentsView"),
  archiveInput: $("#archiveInput"),
  headerImport: $("#headerImport"),
  headerAdd: $("#headerAdd"),
  headerExport: $("#headerExport"),
  welcomeImport: $("#welcomeImport"),
  createEmpty: $("#createEmpty"),
  homeImport: $("#homeImport"),
  homeAddRecord: $("#homeAddRecord"),
  recentRecord: $("#recentRecord"),
  recentDate: $("#recentDate"),
  recentWork: $("#recentWork"),
  recentMeta: $("#recentMeta"),
  recentCost: $("#recentCost"),
  emptyRecent: $("#emptyRecent"),
  quickRecordCount: $("#quickRecordCount"),
  quickDocumentCount: $("#quickDocumentCount"),
  documentsList: $("#documentsList"),
  emptyDocuments: $("#emptyDocuments"),
  addRecord: $("#addRecord"),
  emptyAdd: $("#emptyAdd"),
  replaceImport: $("#replaceImport"),
  search: $("#search"),
  clearSearch: $("#clearSearch"),
  yearFilter: $("#yearFilter"),
  sortFilter: $("#sortFilter"),
  filterButton: $("#filterButton"),
  filterButtonLabel: $("#filterButtonLabel"),
  statusFilter: $("#statusFilter"),
  costFilter: $("#costFilter"),
  fromDateFilter: $("#fromDateFilter"),
  throughDateFilter: $("#throughDateFilter"),
  filterForm: $("#filterForm"),
  resetFilters: $("#resetFilters"),
  recordList: $("#recordList"),
  visibleCount: $("#visibleCount"),
  emptyFilter: $("#emptyFilter"),
  emptyTitle: $("#emptyTitle"),
  emptyMessage: $("#emptyMessage"),
  vehicleTitle: $("#vehicleTitle"),
  heroSubtitle: $("#heroSubtitle"),
  statRecords: $("#statRecords"),
  statTotal: $("#statTotal"),
  statReview: $("#statReview"),
  detailDialog: $("#detailDialog"),
  detailDate: $("#detailDate"),
  detailTitle: $("#detailTitle"),
  detailContent: $("#detailContent"),
  editRecord: $("#editRecord"),
  deleteRecord: $("#deleteRecord"),
  recordDialog: $("#recordDialog"),
  recordDialogTitle: $("#recordDialogTitle"),
  recordForm: $("#recordForm"),
  recordDate: $("#recordDate"),
  recordMileage: $("#recordMileage"),
  recordDocument: $("#recordDocument"),
  recordWork: $("#recordWork"),
  recordParts: $("#recordParts"),
  recordLabor: $("#recordLabor"),
  recordMaterials: $("#recordMaterials"),
  recordTotal: $("#recordTotal"),
  recordStatus: $("#recordStatus"),
  recordNote: $("#recordNote"),
  recordFiles: $("#recordFiles"),
  existingFiles: $("#existingFiles"),
  recordFormError: $("#recordFormError"),
  pdfDialog: $("#pdfDialog"),
  pdfTitle: $("#pdfTitle"),
  pdfPage: $("#pdfPage"),
  pdfOpen: $("#pdfOpen"),
  pdfFrame: $("#pdfFrame"),
  imageFrame: $("#imageFrame"),
  progressOverlay: $("#progressOverlay"),
  progressTitle: $("#progressTitle"),
  progressText: $("#progressText"),
  progressBar: $("#progressBar"),
  cancelImport: $("#cancelImport"),
  toast: $("#toast"),
};

let database;
let importedRecords = [];
let toastTimer;
let currentPdfObjectURL = null;
let importCancelled = false;
let datasetMeta = null;
let editingRecordId = null;
let selectedRecordId = null;
let activeFilters = { status: "all", cost: "all", from: "", through: "" };
let activeView = "home";

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency", currency: "RUB", maximumFractionDigits: 2,
});
const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit", month: "2-digit", year: "numeric",
});
const monthFormatter = new Intl.DateTimeFormat("ru-RU", { month: "short" });

function money(value) {
  const amount = numeric(value);
  return amount === null ? "—" : moneyFormatter.format(amount);
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function recordTotal(record) {
  const total = numeric(record["Итого, ₽"]);
  if (total !== null) return total;
  const labor = numeric(record["Работы, ₽"]);
  const parts = numeric(record["Запчасти и материалы, ₽"]);
  return labor !== null || parts !== null ? (labor ?? 0) + (parts ?? 0) : null;
}

function recordDate(record) {
  const match = String(record["Дата"] ?? "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
}

function needsAttention(record) {
  const text = `${record["Статус сверки"] ?? ""} ${record["Источник / примечание"] ?? ""}`.toLocaleLowerCase("ru-RU");
  return /неразбор|неуверенн|аномальн|не подтвержд|требует[^.]{0,40}(проверк|сверк)|не сопостав|без сопостав|не проверен|новая запись/.test(text);
}

function makeId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `record-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function ensureRecordIds(records) {
  const used = new Set();
  return records.map((source) => {
    const record = { ...source };
    let id = String(record._id ?? "").trim();
    if (!id || used.has(id)) id = makeId();
    used.add(id);
    record._id = id;
    return record;
  });
}

function pageNumber(attachment) {
  if (Number.isInteger(attachment?.page)) return attachment.page;
  const match = String(attachment?.url ?? "").match(/#page=(\d+)/);
  return match ? Number(match[1]) : null;
}

function attachmentPath(attachment) {
  const raw = String(attachment?.url ?? "").split("#", 1)[0];
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep the original path */ }
  return decoded.replaceAll("\\", "/").replace(/^\.\//, "");
}

function showToast(message, duration = 3200) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, duration);
}

function openDatabase() {
  if (database) return Promise.resolve(database);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "path" });
      if (!db.objectStoreNames.contains("stage")) db.createObjectStore("stage", { keyPath: "path" });
    };
    request.onsuccess = () => { database = request.result; resolve(database); };
    request.onerror = () => reject(request.error ?? new Error("Не удалось открыть локальное хранилище."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("Не удалось сохранить данные на устройстве."));
  });
}

async function readSavedDataset() {
  try {
    const db = await openDatabase();
    const tx = db.transaction("meta", "readonly");
    const request = tx.objectStore("meta").get("current");
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    if (result) {
      datasetMeta = result;
      importedRecords = ensureRecordIds(result.records ?? []);
      renderApp(result.importedAt);
      if (importedRecords.some((record, index) => record._id !== result.records?.[index]?._id)) {
        await persistRecords();
      }
    }
  } catch {
    showToast("Не удалось прочитать данные. Сохраните архив и попробуйте импортировать его ещё раз.", 5000);
  }
}

function openImportPicker() {
  ui.archiveInput.value = "";
  ui.archiveInput.click();
}

function setProgress(title, message, value) {
  ui.progressTitle.textContent = title;
  ui.progressText.textContent = message;
  ui.progressBar.value = value;
}

function showProgress() {
  ui.progressOverlay.hidden = false;
  ui.cancelImport.hidden = false;
  ui.cancelImport.disabled = false;
  importCancelled = false;
}

function hideProgress() {
  ui.progressOverlay.hidden = true;
}

async function handleArchive(file) {
  if (!file) return;
  if (datasetMeta && importedRecords.length && !window.confirm("Импорт заменит записи этого журнала, включая добавленные вручную. Сначала сохраните резервную копию, если нужны все изменения. Продолжить?")) return;
  showProgress();
  setProgress("Открываю архив", "Проверяю список файлов…", 2);
  try {
    const entries = await readZipDirectory(file);
    if (importCancelled) throw new Error("Импорт отменён.");
    const entryMap = new Map();
    for (const entry of entries.filter((item) => !item.name.endsWith("/"))) {
      if (entryMap.has(entry.name)) throw new Error(`В ZIP повторяется файл ${entry.name}.`);
      entryMap.set(entry.name, entry);
    }
    const jsonEntry = entryMap.get("Audi_Q7_backup.json");
    if (!jsonEntry) throw new Error("В архиве не найден файл Audi_Q7_backup.json. Выберите архив Audi Q7 v6.");

    const backupBytes = await extractZipEntry(file, jsonEntry);
    const backup = JSON.parse(new TextDecoder("utf-8").decode(backupBytes));
    if (!Array.isArray(backup.records)) {
      throw new Error("В архиве не найден список записей обслуживания.");
    }

    const documents = new Set();
    const recordFileErrors = [];
    for (let i = 0; i < backup.records.length; i += 1) {
      const attachments = backup.records[i]["Вложения"] ?? [];
      for (const attachment of attachments) {
        const path = attachmentPath(attachment);
        if (!path.startsWith("docs/") || path.includes("../")) {
          recordFileErrors.push(`запись ${i + 1}: небезопасный путь`);
          continue;
        }
        documents.add(path);
      }
    }
    if (recordFileErrors.length) throw new Error("В архиве есть некорректные ссылки на документы.");
    const missing = [...documents].filter((path) => !entryMap.has(path));
    if (missing.length) throw new Error(`В архиве не хватает документа: ${missing[0]}`);

    const db = await openDatabase();
    let clearTx = db.transaction("stage", "readwrite");
    clearTx.objectStore("stage").clear();
    await transactionDone(clearTx);

    let doneCount = 0;
    for (const path of documents) {
      if (importCancelled) throw new Error("Импорт отменён.");
      const bytes = await extractZipEntry(file, entryMap.get(path));
      if (!path.toLowerCase().endsWith(".pdf")) throw new Error(`Ожидался PDF-файл: ${path}`);
      const blob = new Blob([bytes], { type: "application/pdf" });
      const stageTx = db.transaction("stage", "readwrite");
      stageTx.objectStore("stage").put({ path, blob });
      await transactionDone(stageTx);
      doneCount += 1;
      const progress = 12 + Math.round((doneCount / documents.size) * 78);
      setProgress("Сохраняю документы", `Файл ${doneCount} из ${documents.size} · остаётся на iPhone`, progress);
    }
    if (importCancelled) throw new Error("Импорт отменён.");

    const normalizedRecords = ensureRecordIds(backup.records);
    await commitDataset(db, normalizedRecords, documents.size, file.name, backup.vehicle ?? null);
    importedRecords = normalizedRecords;
    try { await navigator.storage?.persist?.(); } catch { /* optional browser permission */ }
    hideProgress();
    renderApp(new Date().toISOString());
    showToast(`Готово: импортировано записей — ${importedRecords.length}.`);
  } catch (error) {
    const db = database;
    if (db) {
      try {
        const tx = db.transaction("stage", "readwrite");
        tx.objectStore("stage").clear();
      } catch { /* a failed transaction can be cleaned by the next import */ }
    }
    hideProgress();
    if (error?.message !== "Импорт отменён.") showToast(error?.message ?? "Не удалось прочитать архив.", 6000);
  }
}

async function commitDataset(db, records, documentCount, archiveName, vehicle) {
  const tx = db.transaction(["meta", "docs", "stage"], "readwrite");
  const metaStore = tx.objectStore("meta");
  const docsStore = tx.objectStore("docs");
  const stageStore = tx.objectStore("stage");
  metaStore.clear();
  docsStore.clear();
  metaStore.put({
    key: "current",
    records,
    importedAt: new Date().toISOString(),
    documentCount,
    archiveName,
    vehicle: vehicle ?? null,
  });
  const cursorRequest = stageStore.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor) {
      docsStore.put(cursor.value);
      cursor.continue();
    } else {
      stageStore.clear();
    }
  };
  cursorRequest.onerror = () => tx.abort();
  await transactionDone(tx);
  datasetMeta = {
    key: "current", records, importedAt: new Date().toISOString(),
    documentCount, archiveName, vehicle: vehicle ?? null,
  };
}

async function readZipDirectory(file) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Браузер не поддерживает чтение ZIP. Обновите iOS и Safari до последней версии.");
  }
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tailView.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Не удалось прочитать ZIP. Проверьте, что архив скачан полностью.");
  const totalEntries = tailView.getUint16(eocd + 10, true);
  const directorySize = tailView.getUint32(eocd + 12, true);
  const directoryOffset = tailView.getUint32(eocd + 16, true);
  if (totalEntries === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error("Формат этого ZIP не поддерживается. Выберите архив v6.");
  }
  const directory = new DataView(await file.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer());
  const decoder = new TextDecoder("utf-8");
  const entries = [];
  let offset = 0;
  for (let i = 0; i < totalEntries; i += 1) {
    if (directory.getUint32(offset, true) !== 0x02014b50) throw new Error("Структура ZIP повреждена.");
    const flags = directory.getUint16(offset + 8, true);
    if (flags & 1) throw new Error("Архив защищён паролем; выберите обычный ZIP.");
    const method = directory.getUint16(offset + 10, true);
    const crc = directory.getUint32(offset + 16, true);
    const compressedSize = directory.getUint32(offset + 20, true);
    const uncompressedSize = directory.getUint32(offset + 24, true);
    const nameLength = directory.getUint16(offset + 28, true);
    const extraLength = directory.getUint16(offset + 30, true);
    const commentLength = directory.getUint16(offset + 32, true);
    const localOffset = directory.getUint32(offset + 42, true);
    const nameBytes = new Uint8Array(directory.buffer, directory.byteOffset + offset + 46, nameLength);
    const name = decoder.decode(nameBytes);
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function extractZipEntry(file, entry) {
  const local = new DataView(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
  if (local.getUint32(0, true) !== 0x04034b50) throw new Error(`Повреждён файл ${entry.name}.`);
  const fileNameLength = local.getUint16(26, true);
  const extraLength = local.getUint16(28, true);
  const start = entry.localOffset + 30 + fileNameLength + extraLength;
  const compressed = file.slice(start, start + entry.compressedSize);
  let bytes;
  if (entry.method === 0) {
    bytes = new Uint8Array(await compressed.arrayBuffer());
  } else if (entry.method === 8) {
    try {
      const stream = compressed.stream().pipeThrough(new DecompressionStream("deflate-raw"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      throw new Error("Не удалось распаковать архив. Обновите Safari или попробуйте выбрать ZIP ещё раз.");
    }
  } else {
    throw new Error(`Не поддерживается сжатие файла ${entry.name}.`);
  }
  if (bytes.byteLength !== entry.uncompressedSize || crc32(bytes) !== entry.crc) {
    throw new Error(`Файл ${entry.name} повреждён или скачан не полностью.`);
  }
  return bytes;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function isoDate(value) {
  const match = String(value ?? "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
}

function russianDate(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "";
}

function optionalNumber(value) {
  const normalized = String(value ?? "").replace(/[\s\u00a0]/g, "").replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function persistRecords(records = importedRecords) {
  const db = await openDatabase();
  const value = {
    ...(datasetMeta ?? {}), key: "current", records,
    importedAt: datasetMeta?.importedAt ?? new Date().toISOString(),
    documentCount: datasetMeta?.documentCount ?? 0,
    archiveName: datasetMeta?.archiveName ?? null,
    vehicle: datasetMeta?.vehicle ?? { model: "Audi Q7" },
  };
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put(value);
  await transactionDone(tx);
  datasetMeta = value;
}

async function createEmptyJournal() {
  datasetMeta = { key: "current", records: [], importedAt: new Date().toISOString(), documentCount: 0, archiveName: null, vehicle: { model: "Audi Q7" } };
  importedRecords = [];
  try {
    await persistRecords();
    renderApp(datasetMeta.importedAt);
  } catch {
    datasetMeta = null;
    showToast("Не удалось создать журнал в хранилище этого устройства.", 5000);
  }
}

function renderApp(importedAt) {
  ui.welcome.hidden = true;
  ui.welcomeFooter.hidden = true;
  ui.dashboard.hidden = false;
  ui.headerAdd.hidden = false;
  ui.headerExport.hidden = importedRecords.length === 0;
  ui.vehicleTitle.textContent = datasetMeta?.vehicle?.model || "Audi Q7";
  ui.heroSubtitle.textContent = datasetMeta?.vehicle?.model_year
    ? `${datasetMeta.vehicle.model_year} · личная история обслуживания`
    : "Личная история обслуживания";
  const sorted = [...importedRecords].sort((a, b) => (recordDate(b)?.getTime() ?? 0) - (recordDate(a)?.getTime() ?? 0));
  const total = importedRecords.reduce((sum, record) => sum + (recordTotal(record) ?? 0), 0);
  ui.statRecords.textContent = importedRecords.length.toLocaleString("ru-RU");
  ui.statTotal.textContent = money(total);
  ui.statReview.textContent = importedRecords.filter(needsAttention).length.toLocaleString("ru-RU");
  ui.quickRecordCount.textContent = importedRecords.length.toLocaleString("ru-RU");
  const documentCount = importedRecords.reduce((sum, record) => sum + (record["Вложения"] ?? []).length, 0);
  ui.quickDocumentCount.textContent = documentCount.toLocaleString("ru-RU");
  renderHomeRecent(sorted[0] ?? null);
  renderDocuments();

  const years = [...new Set(importedRecords.map((record) => String(record["Дата"] ?? "").slice(-4)).filter((year) => /^\d{4}$/.test(year)))].sort((a, b) => Number(b) - Number(a));
  const selected = ui.yearFilter.value;
  ui.yearFilter.innerHTML = `<option value="all">Все годы</option>${years.map((year) => `<option value="${year}">${year}</option>`).join("")}`;
  if (years.includes(selected)) ui.yearFilter.value = selected;
  else ui.yearFilter.value = "all";
  renderRecords();
  switchAppView(activeView);
  if (importedAt) document.title = "Audi Q7 · 921";
}

function switchAppView(view) {
  if (!["home", "history", "documents"].includes(view)) return;
  activeView = view;
  ui.homeView.hidden = view !== "home";
  ui.historyView.hidden = view !== "history";
  ui.documentsView.hidden = view !== "documents";
  document.querySelectorAll(".app-tab").forEach((tab) => {
    const selected = tab.dataset.view === view;
    tab.classList.toggle("is-active", selected);
    if (selected) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
}

function renderHomeRecent(record) {
  const hasRecord = Boolean(record);
  ui.recentRecord.hidden = !hasRecord;
  ui.emptyRecent.hidden = hasRecord;
  if (!record) return;
  const date = record["Дата"] || "Дата не указана";
  const mileage = numeric(record["Пробег, км"]);
  ui.recentDate.textContent = date;
  ui.recentWork.textContent = record["Работы / событие"] || record["Документ"] || "Обслуживание";
  ui.recentMeta.textContent = [record["Документ"], mileage === null ? null : `${mileage.toLocaleString("ru-RU")} км`].filter(Boolean).join(" · ") || "Открыть сведения";
  ui.recentCost.textContent = money(recordTotal(record));
  ui.recentRecord.dataset.recordId = recordId(record);
}

function renderDocuments() {
  const items = [];
  importedRecords.forEach((record) => {
    (record["Вложения"] ?? []).forEach((attachment, index) => items.push({ record, attachment, index }));
  });
  ui.emptyDocuments.hidden = items.length > 0;
  ui.documentsList.hidden = items.length === 0;
  ui.documentsList.innerHTML = items.map(({ record, attachment, index }) => {
    const fileName = attachment.name || attachmentPath(attachment).split("/").pop() || "Документ";
    const recordName = record["Документ"] || record["Работы / событие"] || "Обслуживание";
    const page = pageNumber(attachment);
    const type = String(attachment.type ?? "").startsWith("image/") ? "ФОТО" : "PDF";
    return `<button class="document-card" type="button" data-document-record="${escapeHTML(recordId(record))}" data-document-index="${index}">
      <span class="document-file-icon">${type}</span><span class="document-card-main"><strong>${escapeHTML(fileName)}</strong><small>${escapeHTML(record["Дата"] || "")} · ${escapeHTML(recordName)}${page ? ` · страница ${page}` : ""}</small></span><span class="document-chevron" aria-hidden="true">›</span>
    </button>`;
  }).join("");
}

function filterCount() {
  return Number(ui.yearFilter.value !== "all") + Number(activeFilters.status !== "all") + Number(activeFilters.cost !== "all") + Number(Boolean(activeFilters.from)) + Number(Boolean(activeFilters.through));
}

function renderRecords() {
  const query = ui.search.value.trim().toLocaleLowerCase("ru-RU");
  const year = ui.yearFilter.value;
  const sort = ui.sortFilter.value;
  const filtered = importedRecords.filter((record) => {
    const haystack = [record["Дата"], record["Документ"], record["Работы / событие"], record["Запчасти / артикулы"], record["Статус сверки"], record["Источник / примечание"]].join(" ").toLocaleLowerCase("ru-RU");
    const dateISO = isoDate(record["Дата"]);
    const attention = needsAttention(record);
    const total = recordTotal(record);
    return (!query || haystack.includes(query)) &&
      (year === "all" || String(record["Дата"] ?? "").endsWith(year)) &&
      (activeFilters.status === "all" || (activeFilters.status === "review" ? attention : !attention)) &&
      (activeFilters.cost === "all" || (activeFilters.cost === "with" ? total !== null : total === null)) &&
      (!activeFilters.from || (dateISO && dateISO >= activeFilters.from)) &&
      (!activeFilters.through || (dateISO && dateISO <= activeFilters.through));
  });
  filtered.sort((a, b) => {
    if (sort === "oldest") return (recordDate(a)?.getTime() ?? 0) - (recordDate(b)?.getTime() ?? 0);
    if (sort === "cost") return (recordTotal(b) ?? -1) - (recordTotal(a) ?? -1);
    if (sort === "mileage") return (numeric(b["Пробег, км"]) ?? -1) - (numeric(a["Пробег, км"]) ?? -1);
    return (recordDate(b)?.getTime() ?? 0) - (recordDate(a)?.getTime() ?? 0);
  });
  ui.visibleCount.textContent = `(${filtered.length})`;
  ui.clearSearch.hidden = !ui.search.value;
  ui.recordList.hidden = filtered.length === 0;
  ui.emptyFilter.hidden = filtered.length !== 0;
  ui.emptyAdd.hidden = importedRecords.length !== 0 || Boolean(query) || filterCount() !== 0;
  if (!importedRecords.length) {
    ui.emptyTitle.textContent = "Пока нет записей";
    ui.emptyMessage.textContent = "Добавьте первое обслуживание или импортируйте архив Audi Q7.";
  } else {
    ui.emptyTitle.textContent = "Ничего не найдено";
    ui.emptyMessage.textContent = "Измените запрос или фильтры. Все записи останутся в журнале.";
  }
  ui.recordList.innerHTML = filtered.map(recordCard).join("");
  const activeCount = filterCount();
  ui.filterButtonLabel.textContent = activeCount ? `Фильтры · ${activeCount}` : "Фильтры";
}

function recordCard(record) {
  const date = recordDate(record);
  const day = date ? String(date.getDate()).padStart(2, "0") : "—";
  const month = date ? monthFormatter.format(date).replace(".", "").toLocaleUpperCase("ru-RU") : "";
  const mileage = numeric(record["Пробег, км"]);
  const attachments = record["Вложения"] ?? [];
  const warning = needsAttention(record);
  return `<button class="record-card" type="button" data-record-id="${escapeHTML(record._id)}">
    <span class="record-date"><b>${day}</b><span>${escapeHTML(month)}</span></span>
    <span class="record-main"><strong>${escapeHTML(record["Работы / событие"] || "Обслуживание")}</strong><small>${escapeHTML(record["Документ"] || "Запись")}</small>
      <span class="record-meta">${mileage !== null ? `<span>${mileage.toLocaleString("ru-RU")} км</span><i class="meta-separator"></i>` : ""}<span class="attachment-count"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 8.7 9.4 4.8a2.1 2.1 0 0 1 3 3l-5.1 5.1a3.3 3.3 0 0 1-4.7-4.7L8 2.8"/></svg>${attachments.length}</span></span>
    </span><span class="record-price">${escapeHTML(money(recordTotal(record)))}</span>${warning ? '<i class="record-warning" aria-label="Требует внимания"></i>' : ""}
  </button>`;
}

function recordId(record) {
  return String(record._id ?? "");
}

function showRecord(record) {
  selectedRecordId = recordId(record);
  ui.detailDate.textContent = record["Дата"] ?? "";
  ui.detailTitle.textContent = record["Документ"] || "Запись об обслуживании";
  const mileage = numeric(record["Пробег, км"]);
  const parts = record["Запчасти / артикулы"];
  const note = record["Источник / примечание"];
  const attachments = record["Вложения"] ?? [];
  const attention = needsAttention(record);
  const status = record["Статус сверки"] || "Добавлено вручную";
  ui.detailContent.innerHTML = `
    <section class="detail-block"><h3>Что сделано</h3><div class="detail-work">${escapeHTML(record["Работы / событие"] || "Работы не указаны")}</div></section>
    <section class="detail-block detail-facts">
      <div class="fact"><span>Дата</span><strong>${escapeHTML(record["Дата"] || "—")}</strong></div>
      <div class="fact"><span>Пробег</span><strong>${mileage === null ? "—" : `${mileage.toLocaleString("ru-RU")} км`}</strong></div>
      <div class="fact"><span>Документ</span><strong>${escapeHTML(record["Документ"] || "—")}</strong></div>
      <div class="fact"><span>Проверка</span><strong>${escapeHTML(status)}</strong></div>
    </section>
    <section class="detail-block"><h3>Стоимость</h3><div class="cost-list">
      <div class="cost-row"><span>Работы</span><strong>${escapeHTML(money(record["Работы, ₽"]))}</strong></div>
      <div class="cost-row"><span>Запчасти и материалы</span><strong>${escapeHTML(money(record["Запчасти и материалы, ₽"]))}</strong></div>
      <div class="cost-row total"><span>Итого</span><strong>${escapeHTML(money(recordTotal(record)))}</strong></div>
    </div></section>
    ${parts ? `<section class="detail-block"><h3>Запчасти и артикулы</h3><div class="detail-parts">${escapeHTML(parts)}</div></section>` : ""}
    ${note ? `<section class="detail-block"><h3>Примечание</h3>${attention ? `<div class="warning-note"><span>!</span><span>${escapeHTML(note)}</span></div>` : `<div class="detail-note">${escapeHTML(note)}</div>`}</section>` : ""}
    <section class="detail-block"><h3>Документы и фото · ${attachments.length}</h3>${attachments.length ? attachments.map((attachment, index) => `<button class="attachment-button" type="button" data-attachment-record="${escapeHTML(recordId(record))}" data-attachment-index="${index}"><span class="pdf-icon">${String(attachment.type ?? "").includes("image") ? "ФОТО" : "PDF"}</span><span class="attachment-label"><strong>${escapeHTML(attachment.name || "Документ")}</strong><small>${pageNumber(attachment) ? `Страница ${pageNumber(attachment)} · оригинал из архива` : escapeHTML(attachment.source || "Оригинал или файл, добавленный на устройстве")}</small></span><span class="attachment-arrow">›</span></button>`).join("") : '<div class="detail-note">Документы не прикреплены.</div>'}</section>
  `;
  ui.detailDialog.showModal();
}

async function showMedia(attachment) {
  const path = attachmentPath(attachment);
  const page = pageNumber(attachment);
  const db = await openDatabase();
  const tx = db.transaction("docs", "readonly");
  const request = tx.objectStore("docs").get(path);
  const saved = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
  if (!saved?.blob) {
    showToast("Файл не найден. Импортируйте исходный архив заново.", 5000);
    return;
  }
  if (currentPdfObjectURL) URL.revokeObjectURL(currentPdfObjectURL);
  currentPdfObjectURL = URL.createObjectURL(saved.blob);
  const mime = saved.blob.type || attachment.type || "application/octet-stream";
  const isImage = mime.startsWith("image/");
  const url = !isImage && page ? `${currentPdfObjectURL}#page=${page}` : currentPdfObjectURL;
  ui.pdfTitle.textContent = attachment.name || path.split("/").pop();
  ui.pdfPage.textContent = page ? `Страница ${page}` : isImage ? "Фото документа" : "PDF-документ";
  ui.pdfFrame.hidden = isImage;
  ui.imageFrame.hidden = !isImage;
  ui.pdfFrame.removeAttribute("src");
  ui.imageFrame.removeAttribute("src");
  if (isImage) ui.imageFrame.src = url;
  else ui.pdfFrame.src = url;
  ui.pdfOpen.href = url;
  ui.pdfDialog.showModal();
}

function closeDialog(dialogId) {
  const dialog = document.getElementById(dialogId);
  if (dialog?.open) dialog.close();
}

function openRecordEditor(record = null) {
  editingRecordId = record ? recordId(record) : null;
  ui.recordForm.reset();
  ui.recordFormError.hidden = true;
  ui.recordFormError.textContent = "";
  ui.recordDialogTitle.textContent = record ? "Изменить запись" : "Новая запись";
  const today = new Date();
  const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  ui.recordDate.value = record ? isoDate(record["Дата"]) : todayISO;
  ui.recordMileage.value = record?.["Пробег, км"] ?? "";
  ui.recordDocument.value = record?.["Документ"] ?? "";
  ui.recordWork.value = record?.["Работы / событие"] ?? "";
  ui.recordParts.value = record?.["Запчасти / артикулы"] ?? "";
  ui.recordLabor.value = record?.["Работы, ₽"] ?? "";
  ui.recordMaterials.value = record?.["Запчасти и материалы, ₽"] ?? "";
  ui.recordTotal.value = record?.["Итого, ₽"] ?? "";
  ui.recordStatus.value = record?.["Статус сверки"] ?? "Новая запись — не проверена по документу";
  ui.recordNote.value = record?.["Источник / примечание"] ?? "";
  const count = record?.["Вложения"]?.length ?? 0;
  ui.existingFiles.textContent = count ? `Уже прикреплено файлов: ${count}. Новые файлы добавятся к ним.` : "";
  ui.recordDialog.showModal();
  setTimeout(() => ui.recordWork.focus(), 80);
}

async function saveRecord(event) {
  event.preventDefault();
  ui.recordFormError.hidden = true;
  const date = russianDate(ui.recordDate.value);
  const work = ui.recordWork.value.trim();
  if (!date || !work) {
    ui.recordFormError.textContent = "Укажите дату и описание работ.";
    ui.recordFormError.hidden = false;
    return;
  }
  const labor = optionalNumber(ui.recordLabor.value);
  const materials = optionalNumber(ui.recordMaterials.value);
  const total = optionalNumber(ui.recordTotal.value) ?? ((labor !== null || materials !== null) ? (labor ?? 0) + (materials ?? 0) : null);
  const record = {
    _id: editingRecordId ?? makeId(),
    "Дата": date,
    "Пробег, км": optionalNumber(ui.recordMileage.value),
    "Документ": ui.recordDocument.value.trim() || null,
    "Работы / событие": work,
    "Запчасти / артикулы": ui.recordParts.value.trim() || null,
    "Работы, ₽": labor,
    "Запчасти и материалы, ₽": materials,
    "Итого, ₽": total,
    "Статус сверки": ui.recordStatus.value.trim() || null,
    "Источник / примечание": ui.recordNote.value.trim() || null,
    "Вложения": editingRecordId ? [...(importedRecords.find((item) => recordId(item) === editingRecordId)?.["Вложения"] ?? [])] : [],
  };
  const addedPaths = [];
  try {
    const files = [...(ui.recordFiles.files ?? [])];
    for (const file of files) {
      if (!(file.type === "application/pdf" || file.type.startsWith("image/"))) {
        throw new Error(`Файл «${file.name}» не является PDF или изображением.`);
      }
      const path = `local/${makeId()}`;
      const db = await openDatabase();
      const tx = db.transaction("docs", "readwrite");
      tx.objectStore("docs").put({ path, blob: file });
      await transactionDone(tx);
      addedPaths.push(path);
      record["Вложения"].push({ name: file.name, type: file.type || "application/octet-stream", url: path, source: "Добавлено вручную", page: null });
    }
    const next = [...importedRecords];
    const index = next.findIndex((item) => recordId(item) === record._id);
    if (index >= 0) next[index] = record;
    else next.unshift(record);
    await persistRecords(next);
    importedRecords = next;
    closeDialog("recordDialog");
    closeDialog("detailDialog");
    renderApp(datasetMeta?.importedAt);
    showToast(editingRecordId ? "Запись обновлена." : "Запись добавлена.");
  } catch (error) {
    if (addedPaths.length) await deleteLocalDocuments(addedPaths).catch(() => {});
    ui.recordFormError.textContent = error?.message ?? "Не удалось сохранить запись на устройстве.";
    ui.recordFormError.hidden = false;
  }
}

async function deleteLocalDocuments(paths) {
  if (!paths.length) return;
  const db = await openDatabase();
  const tx = db.transaction("docs", "readwrite");
  const store = tx.objectStore("docs");
  paths.filter((path) => path.startsWith("local/")).forEach((path) => store.delete(path));
  await transactionDone(tx);
}

async function removeSelectedRecord() {
  const record = importedRecords.find((item) => recordId(item) === selectedRecordId);
  if (!record || !window.confirm("Удалить запись из журнала? Это действие нельзя отменить.")) return;
  const next = importedRecords.filter((item) => recordId(item) !== selectedRecordId);
  const localPaths = (record["Вложения"] ?? []).map(attachmentPath).filter((path) => path.startsWith("local/"));
  try {
    const db = await openDatabase();
    const tx = db.transaction(["meta", "docs"], "readwrite");
    const meta = { ...datasetMeta, records: next };
    tx.objectStore("meta").put(meta);
    localPaths.forEach((path) => tx.objectStore("docs").delete(path));
    await transactionDone(tx);
    datasetMeta = meta;
    importedRecords = next;
    selectedRecordId = null;
    closeDialog("detailDialog");
    renderApp(datasetMeta.importedAt);
    showToast("Запись удалена.");
  } catch {
    showToast("Не удалось удалить запись из памяти устройства.", 5000);
  }
}

function openFilters() {
  ui.statusFilter.value = activeFilters.status;
  ui.costFilter.value = activeFilters.cost;
  ui.fromDateFilter.value = activeFilters.from;
  ui.throughDateFilter.value = activeFilters.through;
  ui.filterDialog.showModal();
}

function applyFilters(event) {
  event.preventDefault();
  if (ui.fromDateFilter.value && ui.throughDateFilter.value && ui.fromDateFilter.value > ui.throughDateFilter.value) {
    showToast("Начало периода не может быть позже его окончания.");
    return;
  }
  activeFilters = {
    status: ui.statusFilter.value,
    cost: ui.costFilter.value,
    from: ui.fromDateFilter.value,
    through: ui.throughDateFilter.value,
  };
  closeDialog("filterDialog");
  renderRecords();
}

function resetFilters() {
  activeFilters = { status: "all", cost: "all", from: "", through: "" };
  ui.yearFilter.value = "all";
  ui.search.value = "";
  ui.sortFilter.value = "newest";
  ui.filterForm.reset();
  closeDialog("filterDialog");
  renderRecords();
}

function zip16(value) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function zip32(value) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function getSavedDocument(path) {
  const db = await openDatabase();
  const tx = db.transaction("docs", "readonly");
  const request = tx.objectStore("docs").get(path);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result?.blob ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function crc32Blob(blob) {
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i += 1) crc = crcTable[(crc ^ value[i]) & 0xff] ^ (crc >>> 8);
    }
  } finally {
    reader.releaseLock();
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function buildBackupZip() {
  const packedFiles = new Map();
  const outputRecords = importedRecords.map((record) => ({ ...record, "Вложения": [] }));
  for (let recordIndex = 0; recordIndex < importedRecords.length; recordIndex += 1) {
    const record = importedRecords[recordIndex];
    for (const attachment of record["Вложения"] ?? []) {
      const sourcePath = attachmentPath(attachment);
      let zipPath = sourcePath;
      if (sourcePath.startsWith("local/")) {
        const safeName = String(attachment.name || "file").replace(/[\\/:*?"<>|]/g, "_");
        zipPath = `docs/user-attachments/${sourcePath.slice("local/".length)}-${safeName}`;
      }
      if (!zipPath.startsWith("docs/") || zipPath.includes("../")) throw new Error(`Небезопасная ссылка в записи «${record["Документ"] || record["Дата"]}».`);
      if (!packedFiles.has(zipPath)) {
        const blob = await getSavedDocument(sourcePath);
        if (!blob) throw new Error(`Не найден файл «${attachment.name || sourcePath}». Импортируйте исходный архив Audi Q7 повторно.`);
        packedFiles.set(zipPath, blob);
      }
      const clone = { ...attachment, url: `${zipPath}${pageNumber(attachment) ? `#page=${pageNumber(attachment)}` : ""}` };
      outputRecords[recordIndex]["Вложения"].push(clone);
    }
    setProgress("Готовлю резервную копию", `Запись ${recordIndex + 1} из ${importedRecords.length}`, 10 + Math.round((recordIndex / importedRecords.length) * 25));
  }
  const backup = {
    format: "Audi Q7 history backup", version: 4, exportedAt: new Date().toISOString(),
    vehicle: datasetMeta?.vehicle ?? { model: "Audi Q7" }, records: outputRecords,
  };
  const encoder = new TextEncoder();
  const files = [{ name: "Audi_Q7_backup.json", blob: new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }) },
    ...[...packedFiles].map(([name, blob]) => ({ name, blob }))];
  const parts = [];
  const central = [];
  let offset = 0;
  const stamp = dosDateTime();
  for (let index = 0; index < files.length; index += 1) {
    const { name, blob } = files[index];
    const nameBytes = encoder.encode(name);
    const crc = await crc32Blob(blob);
    const size = blob.size;
    if (size > 0xffffffff || offset > 0xffffffff) throw new Error("Резервная копия превышает допустимый размер ZIP.");
    const localHeader = new Uint8Array(30);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true); localView.setUint16(4, 20, true); localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true); localView.setUint16(10, stamp.time, true); localView.setUint16(12, stamp.date, true);
    localView.setUint32(14, crc, true); localView.setUint32(18, size, true); localView.setUint32(22, size, true);
    localView.setUint16(26, nameBytes.length, true); localView.setUint16(28, 0, true);
    parts.push(localHeader, nameBytes, blob);
    const centralHeader = new Uint8Array(46);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true); centralView.setUint16(10, 0, true); centralView.setUint16(12, stamp.time, true);
    centralView.setUint16(14, stamp.date, true); centralView.setUint32(16, crc, true); centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true); centralView.setUint16(28, nameBytes.length, true); centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true); centralView.setUint16(34, 0, true); centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true); centralView.setUint32(42, offset, true);
    central.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + size;
    setProgress("Собираю резервную копию", `Файл ${index + 1} из ${files.length}`, 40 + Math.round(((index + 1) / files.length) * 55));
  }
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  if (files.length > 0xffff || offset > 0xffffffff || centralSize > 0xffffffff) throw new Error("Размер журнала не помещается в стандартный ZIP.");
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(4, 0, true); endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true); endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true); endView.setUint32(16, offset, true); endView.setUint16(20, 0, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

async function exportBackup() {
  if (!importedRecords.length) return;
  showProgress();
  ui.cancelImport.hidden = true;
  setProgress("Создаю копию журнала", "Записи и прикреплённые документы останутся на устройстве.", 4);
  try {
    const blob = await buildBackupZip();
    hideProgress();
    const file = new File([blob], "Audi_Q7_backup.zip", { type: "application/zip" });
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ title: "Резервная копия Журнала ТО", files: [file] }); return; }
      catch (error) { if (error?.name === "AbortError") return; }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = file.name; link.style.display = "none";
    link.hidden = true;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    showToast("Резервная копия подготовлена. Сохраните ZIP в «Файлы».", 5000);
  } catch (error) {
    hideProgress();
    showToast(error?.message ?? "Не удалось создать резервную копию.", 7000);
  }
}

function bindEvents() {
  [ui.headerImport, ui.welcomeImport, ui.replaceImport].forEach((button) => button.addEventListener("click", openImportPicker));
  [ui.headerAdd, ui.addRecord, ui.emptyAdd].forEach((button) => button.addEventListener("click", () => openRecordEditor()));
  ui.headerExport.addEventListener("click", exportBackup);
  ui.createEmpty.addEventListener("click", createEmptyJournal);
  ui.homeAddRecord.addEventListener("click", () => openRecordEditor());
  ui.homeImport.addEventListener("click", openImportPicker);
  ui.recentRecord.addEventListener("click", () => {
    const record = importedRecords.find((item) => recordId(item) === ui.recentRecord.dataset.recordId);
    if (record) showRecord(record);
  });
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    switchAppView(button.dataset.view);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }));
  ui.archiveInput.addEventListener("change", (event) => handleArchive(event.target.files?.[0]));
  ui.cancelImport.addEventListener("click", () => {
    importCancelled = true;
    ui.cancelImport.disabled = true;
    ui.progressText.textContent = "Завершаю отмену…";
  });
  ui.search.addEventListener("input", renderRecords);
  ui.clearSearch.addEventListener("click", () => { ui.search.value = ""; renderRecords(); ui.search.focus(); });
  ui.yearFilter.addEventListener("change", renderRecords);
  ui.sortFilter.addEventListener("change", renderRecords);
  ui.filterButton.addEventListener("click", openFilters);
  ui.filterForm.addEventListener("submit", applyFilters);
  ui.resetFilters.addEventListener("click", resetFilters);
  ui.recordForm.addEventListener("submit", saveRecord);
  ui.recordList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-record-id]");
    if (!button) return;
    const record = importedRecords.find((item) => recordId(item) === button.dataset.recordId);
    if (record) showRecord(record);
  });
  ui.documentsList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-document-index]");
    if (!button) return;
    const record = importedRecords.find((item) => recordId(item) === button.dataset.documentRecord);
    const attachment = record?.["Вложения"]?.[Number(button.dataset.documentIndex)];
    if (!attachment) return;
    try { await showMedia(attachment); }
    catch { showToast("Не удалось открыть документ. Проверьте, что архив полностью загружен.", 5500); }
  });
  ui.editRecord.addEventListener("click", () => {
    const record = importedRecords.find((item) => recordId(item) === selectedRecordId);
    if (!record) return;
    closeDialog("detailDialog");
    openRecordEditor(record);
  });
  ui.deleteRecord.addEventListener("click", removeSelectedRecord);
  ui.detailContent.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-attachment-index]");
    if (!button) return;
    const record = importedRecords.find((item) => recordId(item) === button.dataset.attachmentRecord);
    const attachment = record?.["Вложения"]?.[Number(button.dataset.attachmentIndex)];
    if (!attachment) return;
    try { await showMedia(attachment); }
    catch { showToast("Не удалось открыть документ. Попробуйте сохранить ZIP и открыть файл через «Файлы».", 5500); }
  });
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closeDialog(button.dataset.close)));
  ui.pdfDialog.addEventListener("close", () => {
    ui.pdfFrame.removeAttribute("src");
    ui.imageFrame.removeAttribute("src");
    ui.pdfFrame.hidden = false;
    ui.imageFrame.hidden = true;
    ui.pdfOpen.removeAttribute("href");
    if (currentPdfObjectURL) URL.revokeObjectURL(currentPdfObjectURL);
    currentPdfObjectURL = null;
  });
}

async function startApp() {
  bindEvents();
  await readSavedDataset();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch(() => {});
  }
}

startApp();
