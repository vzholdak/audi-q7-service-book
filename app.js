"use strict";

const DB_NAME = "service-log-iphone";
const DB_VERSION = 1;
const $ = (selector) => document.querySelector(selector);

const ui = {
  welcome: $("#welcome"),
  welcomeFooter: $("#welcomeFooter"),
  dashboard: $("#dashboard"),
  archiveInput: $("#archiveInput"),
  headerImport: $("#headerImport"),
  welcomeImport: $("#welcomeImport"),
  replaceImport: $("#replaceImport"),
  search: $("#search"),
  clearSearch: $("#clearSearch"),
  yearFilter: $("#yearFilter"),
  sortFilter: $("#sortFilter"),
  attentionFilter: $("#attentionFilter"),
  recordList: $("#recordList"),
  visibleCount: $("#visibleCount"),
  emptyFilter: $("#emptyFilter"),
  vehicleTitle: $("#vehicleTitle"),
  heroSubtitle: $("#heroSubtitle"),
  statRecords: $("#statRecords"),
  statTotal: $("#statTotal"),
  statLatest: $("#statLatest"),
  detailDialog: $("#detailDialog"),
  detailDate: $("#detailDate"),
  detailTitle: $("#detailTitle"),
  detailContent: $("#detailContent"),
  pdfDialog: $("#pdfDialog"),
  pdfTitle: $("#pdfTitle"),
  pdfPage: $("#pdfPage"),
  pdfOpen: $("#pdfOpen"),
  pdfFrame: $("#pdfFrame"),
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
  return /неразбор|неуверенн|аномальн|не подтвержд/.test(text);
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
    if (result?.records?.length) {
      importedRecords = result.records;
      renderApp(result.importedAt);
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
  showProgress();
  setProgress("Открываю архив", "Проверяю список файлов…", 2);
  try {
    const entries = await readZipDirectory(file);
    if (importCancelled) throw new Error("Импорт отменён.");
    const entryMap = new Map(entries.filter((entry) => !entry.name.endsWith("/")).map((entry) => [entry.name, entry]));
    const jsonEntry = entryMap.get("Audi_Q7_backup.json");
    if (!jsonEntry) throw new Error("В архиве не найден файл Audi_Q7_backup.json. Выберите архив Audi Q7 v6.");

    const backupBytes = await extractZipEntry(file, jsonEntry);
    const backup = JSON.parse(new TextDecoder("utf-8").decode(backupBytes));
    if (!Array.isArray(backup.records) || backup.records.length === 0) {
      throw new Error("В резервной копии нет записей обслуживания.");
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

    await commitDataset(db, backup.records, documents.size, file.name);
    importedRecords = backup.records;
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

async function commitDataset(db, records, documentCount, archiveName) {
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

function renderApp(importedAt) {
  ui.welcome.hidden = true;
  ui.welcomeFooter.hidden = true;
  ui.dashboard.hidden = false;
  ui.vehicleTitle.textContent = "Audi Q7";
  ui.heroSubtitle.textContent = "История обслуживания и расходов";
  const sorted = [...importedRecords].sort((a, b) => (recordDate(b)?.getTime() ?? 0) - (recordDate(a)?.getTime() ?? 0));
  const total = importedRecords.reduce((sum, record) => sum + (recordTotal(record) ?? 0), 0);
  ui.statRecords.textContent = importedRecords.length.toLocaleString("ru-RU");
  ui.statTotal.textContent = money(total);
  const latestDate = sorted[0] ? recordDate(sorted[0]) : null;
  ui.statLatest.textContent = latestDate ? dateFormatter.format(latestDate) : "—";

  const years = [...new Set(importedRecords.map((record) => String(record["Дата"] ?? "").slice(-4)).filter((year) => /^\d{4}$/.test(year)))].sort((a, b) => Number(b) - Number(a));
  const selected = ui.yearFilter.value;
  ui.yearFilter.innerHTML = `<option value="all">Все годы</option>${years.map((year) => `<option value="${year}">${year}</option>`).join("")}`;
  if (years.includes(selected)) ui.yearFilter.value = selected;
  renderRecords();
  if (importedAt) document.title = "Журнал ТО — Audi Q7";
}

function renderRecords() {
  const query = ui.search.value.trim().toLocaleLowerCase("ru-RU");
  const year = ui.yearFilter.value;
  const sort = ui.sortFilter.value;
  const attentionOnly = ui.attentionFilter.getAttribute("aria-pressed") === "true";
  const filtered = importedRecords.filter((record) => {
    const haystack = [record["Дата"], record["Документ"], record["Работы / событие"], record["Запчасти / артикулы"], record["Статус сверки"], record["Источник / примечание"]].join(" ").toLocaleLowerCase("ru-RU");
    return (!query || haystack.includes(query)) && (year === "all" || String(record["Дата"] ?? "").endsWith(year)) && (!attentionOnly || needsAttention(record));
  });
  filtered.sort((a, b) => {
    if (sort === "oldest") return (recordDate(a)?.getTime() ?? 0) - (recordDate(b)?.getTime() ?? 0);
    if (sort === "cost") return (recordTotal(b) ?? -1) - (recordTotal(a) ?? -1);
    return (recordDate(b)?.getTime() ?? 0) - (recordDate(a)?.getTime() ?? 0);
  });
  ui.visibleCount.textContent = `(${filtered.length})`;
  ui.clearSearch.hidden = !ui.search.value;
  ui.recordList.hidden = filtered.length === 0;
  ui.emptyFilter.hidden = filtered.length !== 0;
  ui.recordList.innerHTML = filtered.map(recordCard).join("");
}

function recordCard(record) {
  const date = recordDate(record);
  const day = date ? String(date.getDate()).padStart(2, "0") : "—";
  const month = date ? monthFormatter.format(date).replace(".", "").toLocaleUpperCase("ru-RU") : "";
  const mileage = numeric(record["Пробег, км"]);
  const attachments = record["Вложения"] ?? [];
  const warning = needsAttention(record);
  return `<button class="record-card" type="button" data-record-id="${escapeHTML(recordId(record))}">
    <span class="record-date"><b>${day}</b><span>${escapeHTML(month)}</span></span>
    <span class="record-main"><strong>${escapeHTML(record["Работы / событие"] || "Обслуживание")}</strong><small>${escapeHTML(record["Документ"] || "Запись")}</small>
      <span class="record-meta">${mileage !== null ? `<span>${mileage.toLocaleString("ru-RU")} км</span><i class="meta-separator"></i>` : ""}<span class="attachment-count"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 8.7 9.4 4.8a2.1 2.1 0 0 1 3 3l-5.1 5.1a3.3 3.3 0 0 1-4.7-4.7L8 2.8"/></svg>${attachments.length}</span></span>
    </span><span class="record-price">${escapeHTML(money(recordTotal(record)))}</span>${warning ? '<i class="record-warning" aria-label="Есть примечание"></i>' : ""}
  </button>`;
}

function recordId(record) {
  return `${record["Дата"] ?? ""}|${record["Документ"] ?? ""}|${record["Работы / событие"] ?? ""}`;
}

function showRecord(record) {
  ui.detailDate.textContent = record["Дата"] ?? "";
  ui.detailTitle.textContent = record["Документ"] || "Запись об обслуживании";
  const mileage = numeric(record["Пробег, км"]);
  const parts = record["Запчасти / артикулы"];
  const note = record["Источник / примечание"];
  const attachments = record["Вложения"] ?? [];
  const attention = needsAttention(record);
  ui.detailContent.innerHTML = `
    <section class="detail-block"><h3>Что сделано</h3><div class="detail-work">${escapeHTML(record["Работы / событие"] || "Работы не указаны")}</div></section>
    <section class="detail-block detail-facts">
      <div class="fact"><span>Дата</span><strong>${escapeHTML(record["Дата"] || "—")}</strong></div>
      <div class="fact"><span>Пробег</span><strong>${mileage === null ? "—" : `${mileage.toLocaleString("ru-RU")} км`}</strong></div>
      <div class="fact"><span>Документ</span><strong>${escapeHTML(record["Документ"] || "—")}</strong></div>
      <div class="fact"><span>Проверка</span><strong>${escapeHTML(record["Статус сверки"] || "Сопоставлено")}</strong></div>
    </section>
    <section class="detail-block"><h3>Стоимость</h3><div class="cost-list">
      <div class="cost-row"><span>Работы</span><strong>${escapeHTML(money(record["Работы, ₽"]))}</strong></div>
      <div class="cost-row"><span>Запчасти и материалы</span><strong>${escapeHTML(money(record["Запчасти и материалы, ₽"]))}</strong></div>
      <div class="cost-row total"><span>Итого</span><strong>${escapeHTML(money(recordTotal(record)))}</strong></div>
    </div></section>
    ${parts ? `<section class="detail-block"><h3>Запчасти и материалы</h3><div class="detail-parts">${escapeHTML(parts)}</div></section>` : ""}
    ${note ? `<section class="detail-block"><h3>Примечание аудита</h3>${attention ? `<div class="warning-note"><span>!</span><span>${escapeHTML(note)}</span></div>` : `<div class="detail-note">${escapeHTML(note)}</div>`}</section>` : ""}
    <section class="detail-block"><h3>Документы · ${attachments.length}</h3>${attachments.length ? attachments.map((attachment, index) => `<button class="attachment-button" type="button" data-attachment-record="${escapeHTML(recordId(record))}" data-attachment-index="${index}"><span class="pdf-icon">PDF</span><span class="attachment-label"><strong>${escapeHTML(attachment.name || "Скан заказ-наряда")}</strong><small>${pageNumber(attachment) ? `Страница ${pageNumber(attachment)} · оригинал из архива` : "Оригинал из архива"}</small></span><span class="attachment-arrow">›</span></button>`).join("") : '<div class="detail-note">Документы не указаны.</div>'}</section>
  `;
  ui.detailDialog.showModal();
}

async function showPDF(attachment) {
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
    showToast("Файл не найден. Повторно импортируйте архив v6.", 5000);
    return;
  }
  if (currentPdfObjectURL) URL.revokeObjectURL(currentPdfObjectURL);
  currentPdfObjectURL = URL.createObjectURL(saved.blob);
  const url = page ? `${currentPdfObjectURL}#page=${page}` : currentPdfObjectURL;
  ui.pdfTitle.textContent = attachment.name || path.split("/").pop();
  ui.pdfPage.textContent = page ? `Страница ${page}` : "PDF-документ";
  ui.pdfFrame.src = url;
  ui.pdfOpen.href = url;
  ui.pdfDialog.showModal();
}

function closeDialog(dialogId) {
  const dialog = document.getElementById(dialogId);
  if (dialog?.open) dialog.close();
}

function bindEvents() {
  [ui.headerImport, ui.welcomeImport, ui.replaceImport].forEach((button) => button.addEventListener("click", openImportPicker));
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
  ui.attentionFilter.addEventListener("click", () => {
    const active = ui.attentionFilter.getAttribute("aria-pressed") === "true";
    ui.attentionFilter.setAttribute("aria-pressed", String(!active));
    renderRecords();
  });
  ui.recordList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-record-id]");
    if (!button) return;
    const record = importedRecords.find((item) => recordId(item) === button.dataset.recordId);
    if (record) showRecord(record);
  });
  ui.detailContent.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-attachment-index]");
    if (!button) return;
    const record = importedRecords.find((item) => recordId(item) === button.dataset.attachmentRecord);
    const attachment = record?.["Вложения"]?.[Number(button.dataset.attachmentIndex)];
    if (!attachment) return;
    try { await showPDF(attachment); }
    catch { showToast("Не удалось открыть документ.", 4500); }
  });
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closeDialog(button.dataset.close)));
  ui.pdfDialog.addEventListener("close", () => {
    ui.pdfFrame.removeAttribute("src");
    ui.pdfOpen.removeAttribute("href");
    if (currentPdfObjectURL) URL.revokeObjectURL(currentPdfObjectURL);
    currentPdfObjectURL = null;
  });
}

async function startApp() {
  bindEvents();
  await readSavedDataset();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

startApp();
