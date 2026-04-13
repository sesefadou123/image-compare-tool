const state = {
  left: [],
  right: [],
};

const analysisCache = new Map();
const cosineTableCache = new Map();
const dragDepth = {
  left: 0,
  right: 0,
};

const elements = {
  pairingMode: document.getElementById("pairingMode"),
  similarityThreshold: document.getElementById("similarityThreshold"),
  compareButton: document.getElementById("compareButton"),
  resultBody: document.getElementById("resultBody"),
  statusText: document.getElementById("statusText"),
  pairedCount: document.getElementById("pairedCount"),
  md5MatchCount: document.getElementById("md5MatchCount"),
  similarCount: document.getElementById("similarCount"),
  generalCount: document.getElementById("generalCount"),
  differentCount: document.getElementById("differentCount"),
  leftSummary: document.getElementById("leftSummary"),
  rightSummary: document.getElementById("rightSummary"),
  leftCount: document.getElementById("leftCount"),
  rightCount: document.getElementById("rightCount"),
};

init();

function init() {
  bindSideInputs("left");
  bindSideInputs("right");
  bindDropZones();
  bindClearButtons();
  elements.compareButton.addEventListener("click", handleCompare);
}

function bindSideInputs(side) {
  const folderInput = document.getElementById(`${side}FolderInput`);
  const filesInput = document.getElementById(`${side}FilesInput`);

  folderInput.addEventListener("change", (event) => {
    const descriptors = Array.from(event.target.files || []).map((file) => ({
      file,
      fromDirectory: true,
      rawRelativePath: file.webkitRelativePath || file.name,
      displayPath: file.webkitRelativePath || file.name,
    }));
    appendFileDescriptors(side, descriptors);
    folderInput.value = "";
  });

  filesInput.addEventListener("change", (event) => {
    const descriptors = Array.from(event.target.files || []).map((file) => ({
      file,
      fromDirectory: false,
      rawRelativePath: "",
      displayPath: file.name,
    }));
    appendFileDescriptors(side, descriptors);
    filesInput.value = "";
  });
}

function bindDropZones() {
  document.querySelectorAll("[data-drop-zone]").forEach((zone) => {
    const side = zone.dataset.dropZone;
    zone.addEventListener("dragenter", (event) => {
      event.preventDefault();
      dragDepth[side] += 1;
      zone.classList.add("is-active");
    });

    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      zone.classList.add("is-active");
    });

    zone.addEventListener("dragleave", (event) => {
      event.preventDefault();
      dragDepth[side] = Math.max(0, dragDepth[side] - 1);
      if (dragDepth[side] === 0) {
        zone.classList.remove("is-active");
      }
    });

    zone.addEventListener("drop", async (event) => {
      event.preventDefault();
      dragDepth[side] = 0;
      zone.classList.remove("is-active");
      const descriptors = await extractDroppedItems(event.dataTransfer);
      appendFileDescriptors(side, descriptors);
    });
  });
}

function bindClearButtons() {
  document.querySelectorAll(".clear-button").forEach((button) => {
    button.addEventListener("click", () => {
      const side = button.dataset.side;
      releaseEntries(state[side]);
      state[side] = [];
      updateSelectionUI(side);
      setStatus(`${side === "left" ? "对比组 A" : "对比组 B"} 已清空`);
    });
  });
}

function appendFileDescriptors(side, descriptors) {
  const imageDescriptors = descriptors.filter(({ file }) => file.type.startsWith("image/"));
  const normalized = imageDescriptors.map((descriptor, index) => normalizeFileEntry(descriptor, index));
  state[side] = deduplicateEntries(state[side].concat(normalized));
  updateSelectionUI(side);
  if (!normalized.length) {
    setStatus("未识别到可处理的图片文件，请拖入或选择图片格式文件");
    return;
  }
  setStatus(`${side === "left" ? "对比组 A" : "对比组 B"} 已载入 ${normalized.length} 张图片`);
}

function deduplicateEntries(entries) {
  const map = new Map();
  entries.forEach((entry) => {
    const key = `${entry.relativePath || "__no_path__"}::${entry.name}::${entry.file.size}::${entry.file.lastModified}`;
    const previous = map.get(key);
    if (previous && previous.previewUrl !== entry.previewUrl) {
      URL.revokeObjectURL(previous.previewUrl);
    }
    map.set(key, entry);
  });
  return Array.from(map.values());
}

function normalizeFileEntry(descriptor, index) {
  const { file, fromDirectory, rawRelativePath = "", displayPath = "" } = descriptor;
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${index}-${Math.random().toString(16).slice(2)}`,
    file,
    name: file.name,
    displayPath: displayPath || rawRelativePath || file.name,
    relativePath: sanitizeRelativePath(rawRelativePath),
    previewUrl: URL.createObjectURL(file),
    fromDirectory,
  };
}

function sanitizeRelativePath(path) {
  if (!path) {
    return "";
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return segments[0] || "";
  }
  return segments.slice(1).join("/");
}

async function extractDroppedItems(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  if (items.length && items.some((item) => typeof item.webkitGetAsEntry === "function")) {
    const descriptors = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry();
      if (!entry) {
        continue;
      }
      const nestedDescriptors = await walkFileTree(entry, "");
      descriptors.push(...nestedDescriptors);
    }
    if (descriptors.length) {
      return descriptors;
    }
  }

  return Array.from(dataTransfer?.files || []).map((file) => ({
    file,
    fromDirectory: false,
    rawRelativePath: "",
    displayPath: file.name,
  }));
}

async function walkFileTree(entry, parentPath) {
  const currentPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await fileEntryToFile(entry);
    return [
      {
        file,
        fromDirectory: Boolean(parentPath),
        rawRelativePath: currentPath,
        displayPath: currentPath,
      },
    ];
  }

  if (!entry.isDirectory) {
    return [];
  }

  const reader = entry.createReader();
  const entries = await readAllDirectoryEntries(reader);
  const collected = [];

  for (const child of entries) {
    const nested = await walkFileTree(child, currentPath);
    collected.push(...nested);
  }

  return collected;
}

function fileEntryToFile(entry) {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

async function readAllDirectoryEntries(reader) {
  const entries = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch.length) {
      break;
    }
    entries.push(...batch);
  }
  return entries;
}

function updateSelectionUI(side) {
  const entries = state[side];
  const summary = elements[`${side}Summary`];
  const count = elements[`${side}Count`];

  if (!entries.length) {
    summary.textContent = "未选择任何图片";
    count.textContent = "0 张";
    return;
  }

  const folderCount = entries.filter((entry) => entry.relativePath).length;
  summary.textContent = `共上传 ${entries.length} 张图片，其中 ${folderCount} 张来自目录上传`;
  count.textContent = `${entries.length} 张`;
}

async function handleCompare() {
  if (!state.left.length || !state.right.length) {
    setStatus("请先在左右两侧都上传图片后再开始对比");
    return;
  }

  resetSummary();
  setStatus("正在整理配对关系...");
  elements.resultBody.innerHTML = "";

  const pairingMode = elements.pairingMode.value;
  const resolvedMode = resolvePairingMode(pairingMode, state.left, state.right);
  const pairs = buildPairs(state.left, state.right, resolvedMode);

  if (!pairs.length) {
    renderEmpty("没有找到可对比的图片配对");
    setStatus("未找到可对比的图片配对");
    return;
  }

  setStatus(`已生成 ${pairs.length} 组配对，正在计算哈希...`);

  const results = [];
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    setStatus(`正在计算第 ${index + 1} / ${pairs.length} 组：${pair.key}`);
    let result;
    try {
      result = await comparePair(pair, Number(elements.similarityThreshold.value || 12));
    } catch (error) {
      result = {
        key: pair.key,
        left: pair.left,
        right: pair.right,
        missing: true,
        conclusion: "处理失败",
        conclusionClass: "conclusion-missing",
        errorMessage: error instanceof Error ? error.message : "未知错误",
      };
    }
    results.push(result);
    await nextFrame();
  }

  renderResults(results);
  updateSummary(results);
  setStatus(`对比完成，配对策略：${getPairingLabel(resolvedMode)}`);
}

function resolvePairingMode(mode, leftEntries, rightEntries) {
  if (mode !== "auto") {
    return mode;
  }

  const relativeOverlaps = countOverlaps(buildGroupedMap(leftEntries, "relative"), buildGroupedMap(rightEntries, "relative"));
  if (relativeOverlaps > 0) {
    return "relative";
  }

  const filenameOverlaps = countOverlaps(buildGroupedMap(leftEntries, "filename"), buildGroupedMap(rightEntries, "filename"));
  if (filenameOverlaps > 0) {
    return "filename";
  }

  return "index";
}

function buildPairs(leftEntries, rightEntries, mode) {
  if (mode === "index") {
    return buildIndexPairs(leftEntries, rightEntries);
  }

  return buildKeyPairs(leftEntries, rightEntries, mode);
}

function buildIndexPairs(leftEntries, rightEntries) {
  const maxLength = Math.max(leftEntries.length, rightEntries.length);
  const pairs = [];
  for (let index = 0; index < maxLength; index += 1) {
    pairs.push({
      key: `第 ${index + 1} 组`,
      left: leftEntries[index] || null,
      right: rightEntries[index] || null,
      pairingMode: "index",
    });
  }
  return pairs;
}

function buildKeyPairs(leftEntries, rightEntries, mode) {
  const leftMap = buildGroupedMap(leftEntries, mode);
  const rightMap = buildGroupedMap(rightEntries, mode);
  const keys = Array.from(new Set([...leftMap.keys(), ...rightMap.keys()])).sort((a, b) => a.localeCompare(b, "zh-CN"));
  const pairs = [];

  keys.forEach((key) => {
    const leftQueue = [...(leftMap.get(key) || [])];
    const rightQueue = [...(rightMap.get(key) || [])];
    const maxLength = Math.max(leftQueue.length, rightQueue.length);
    for (let index = 0; index < maxLength; index += 1) {
      const suffix = maxLength > 1 ? ` #${index + 1}` : "";
      pairs.push({
        key: `${key}${suffix}`,
        left: leftQueue[index] || null,
        right: rightQueue[index] || null,
        pairingMode: mode,
      });
    }
  });

  return pairs;
}

function buildGroupedMap(entries, mode) {
  const map = new Map();
  entries.forEach((entry) => {
    const key = mode === "relative" ? entry.relativePath || entry.name : entry.name.toLowerCase();
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(entry);
  });
  return map;
}

function countOverlaps(leftMap, rightMap) {
  let count = 0;
  leftMap.forEach((_, key) => {
    if (rightMap.has(key)) {
      count += 1;
    }
  });
  return count;
}

async function comparePair(pair, threshold) {
  if (!pair.left || !pair.right) {
    return {
      key: pair.key,
      left: pair.left,
      right: pair.right,
      missing: true,
      conclusion: "无法对比",
      conclusionClass: "conclusion-missing",
    };
  }

  const [leftData, rightData] = await Promise.all([analyzeImage(pair.left.file), analyzeImage(pair.right.file)]);
  const md5Equal = leftData.md5 === rightData.md5;
  const ahashDistance = hammingDistance(leftData.aHash, rightData.aHash);
  const dhashDistance = hammingDistance(leftData.dHash, rightData.dHash);
  const phashDistance = hammingDistance(leftData.pHash, rightData.pHash);
  const distances = [ahashDistance, dhashDistance, phashDistance];
  const closeCount = distances.filter((distance) => distance <= 5).length;
  const averageDistance = distances.reduce((sum, distance) => sum + distance, 0) / distances.length;

  let conclusion = "不相似";
  let conclusionClass = "conclusion-different";

  if (md5Equal || closeCount >= 2 || averageDistance <= 5) {
    conclusion = "相似";
    conclusionClass = "conclusion-similar";
  } else if (closeCount >= 1 || averageDistance <= threshold) {
    conclusion = "一般";
    conclusionClass = "conclusion-general";
  }

  return {
    key: pair.key,
    left: pair.left,
    right: pair.right,
    md5Equal,
    ahashDistance,
    dhashDistance,
    phashDistance,
    conclusion,
    conclusionClass,
  };
}

async function analyzeImage(file) {
  if (analysisCache.has(file)) {
    return analysisCache.get(file);
  }

  const [md5, bitmap] = await Promise.all([calculateMd5(file), loadImageBitmap(file)]);
  const { width, height, data } = drawImageToCanvas(bitmap, 32, 32);
  const gray = toGrayScale(data, width, height);
  bitmap.close?.();

  const result = {
    md5,
    aHash: getAverageHash(gray),
    dHash: getDifferenceHash(gray),
    pHash: getPerceptualHash(gray),
  };
  analysisCache.set(file, result);
  return result;
}

async function calculateMd5(file) {
  const buffer = await file.arrayBuffer();
  return md5ArrayBuffer(buffer);
}

async function loadImageBitmap(file) {
  if ("createImageBitmap" in window) {
    return createImageBitmap(file);
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`图片加载失败：${file.name}`));
    image.src = URL.createObjectURL(file);
  });
}

function drawImageToCanvas(image, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

function toGrayScale(data, width, height) {
  const gray = new Float64Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    gray[index] = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
  }
  return gray;
}

function getAverageHash(gray) {
  const size = 8;
  const sample = resizeGrayMatrix(gray, 32, 32, size, size);
  const average = sample.reduce((sum, value) => sum + value, 0) / sample.length;
  return sample.map((value) => (value >= average ? "1" : "0")).join("");
}

function getDifferenceHash(gray) {
  const width = 9;
  const height = 8;
  const sample = resizeGrayMatrix(gray, 32, 32, width, height);
  const hash = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const current = sample[y * width + x];
      const next = sample[y * width + x + 1];
      hash.push(current > next ? "1" : "0");
    }
  }
  return hash.join("");
}

function getPerceptualHash(gray) {
  const size = 32;
  const dct = computeDct(gray, size);
  const values = [];

  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (x === 0 && y === 0) {
        continue;
      }
      values.push(dct[y * size + x]);
    }
  }

  const median = getMedian(values);
  return values.map((value) => (value >= median ? "1" : "0")).join("");
}

function resizeGrayMatrix(gray, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const result = new Float64Array(targetWidth * targetHeight);
  const xRatio = sourceWidth / targetWidth;
  const yRatio = sourceHeight / targetHeight;

  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * xRatio));
      const sourceY = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * yRatio));
      result[y * targetWidth + x] = gray[sourceY * sourceWidth + sourceX];
    }
  }

  return Array.from(result);
}

function computeDct(gray, size) {
  const result = new Float64Array(size * size);
  const cosineX = buildCosineTable(size);
  const cosineY = buildCosineTable(size);

  for (let u = 0; u < size; u += 1) {
    for (let v = 0; v < size; v += 1) {
      let sum = 0;
      for (let x = 0; x < size; x += 1) {
        for (let y = 0; y < size; y += 1) {
          sum += gray[y * size + x] * cosineX[u][x] * cosineY[v][y];
        }
      }
      const alphaU = u === 0 ? Math.sqrt(1 / size) : Math.sqrt(2 / size);
      const alphaV = v === 0 ? Math.sqrt(1 / size) : Math.sqrt(2 / size);
      result[v * size + u] = alphaU * alphaV * sum;
    }
  }

  return result;
}

function buildCosineTable(size) {
  if (cosineTableCache.has(size)) {
    return cosineTableCache.get(size);
  }

  const table = [];
  for (let k = 0; k < size; k += 1) {
    const row = [];
    for (let n = 0; n < size; n += 1) {
      row.push(Math.cos((Math.PI * (2 * n + 1) * k) / (2 * size)));
    }
    table.push(row);
  }
  cosineTableCache.set(size, table);
  return table;
}

function getMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function hammingDistance(left, right) {
  const maxLength = Math.max(left.length, right.length);
  let count = Math.abs(left.length - right.length);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      count += 1;
    }
  }
  return Math.min(count, maxLength);
}

function renderResults(results) {
  if (!results.length) {
    renderEmpty("暂无结果");
    return;
  }

  elements.resultBody.innerHTML = results.map(renderResultCard).join("");
}

function renderResultCard(result) {
  if (result.missing) {
    return `
      <article class="result-card missing-row">
        <div class="result-card-head">
          <span class="result-card-title">对比结果</span>
          <span class="result-card-key">${escapeHtml(result.key)}</span>
        </div>
        <div class="result-primary-grid">
          <div class="result-compare-grid">
            <section class="result-column">
              <span class="result-column-label">A</span>
              ${renderPreviewCell(result.left)}
            </section>
            <section class="result-column">
              <span class="result-column-label">B</span>
              ${renderPreviewCell(result.right)}
            </section>
          </div>
          <section class="result-conclusion-card">
            <span class="result-column-label">结论</span>
            <span class="conclusion-badge ${result.conclusionClass}" title="${escapeHtml(result.errorMessage || result.conclusion)}">
              ${result.conclusion}
            </span>
          </section>
        </div>
        <div class="result-metrics-row">
          ${renderMetricCard("MD5", `<span class="md5-badge md5-different">${result.errorMessage ? "处理失败" : "缺少图片"}</span>`)}
          ${renderMetricCard("pHash", "-")}
          ${renderMetricCard("dHash", "-")}
          ${renderMetricCard("aHash", "-")}
        </div>
      </article>
    `;
  }

  return `
    <article class="result-card">
      <div class="result-card-head">
        <span class="result-card-title">对比结果</span>
        <span class="result-card-key">${escapeHtml(result.key)}</span>
      </div>
      <div class="result-primary-grid">
        <div class="result-compare-grid">
          <section class="result-column">
            <span class="result-column-label">A</span>
            ${renderPreviewCell(result.left)}
          </section>
          <section class="result-column">
            <span class="result-column-label">B</span>
            ${renderPreviewCell(result.right)}
          </section>
        </div>
        <section class="result-conclusion-card">
          <span class="result-column-label">结论</span>
          <span class="conclusion-badge ${result.conclusionClass}">${result.conclusion}</span>
        </section>
      </div>
      <div class="result-metrics-row">
        ${renderMetricCard(
          "MD5",
          `<span class="md5-badge ${result.md5Equal ? "md5-match" : "md5-different"}">${result.md5Equal ? "一致" : "不一致"}</span>`,
        )}
        ${renderMetricCard("pHash", result.phashDistance, result.phashDistance <= 5)}
        ${renderMetricCard("dHash", result.dhashDistance, result.dhashDistance <= 5)}
        ${renderMetricCard("aHash", result.ahashDistance, result.ahashDistance <= 5)}
      </div>
    </article>
  `;
}

function renderMetricCard(label, value, isClose = false) {
  if (typeof value === "number") {
    return `
      <div class="metric-card">
        <span class="metric-label">${label}</span>
        <div class="metric-value is-number">
          <span class="hash-distance ${isClose ? "is-close" : ""}">${value}</span>
        </div>
      </div>
    `;
  }

  return `
    <div class="metric-card">
      <span class="metric-label">${label}</span>
      <div class="metric-value">${value}</div>
    </div>
  `;
}

function renderPreviewCell(entry) {
  if (!entry) {
    return `
      <div class="preview-card">
        <div class="preview-placeholder">缺失</div>
        <div class="preview-meta">
          <strong>未找到对应图片</strong>
          <span>-</span>
        </div>
      </div>
    `;
  }

  return `
    <div class="preview-card">
      <img src="${entry.previewUrl}" alt="${escapeHtml(entry.name)}" />
      <div class="preview-meta">
        <strong title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</strong>
        <span title="${escapeHtml(entry.displayPath)}">${escapeHtml(entry.relativePath || entry.displayPath)}</span>
      </div>
    </div>
  `;
}

function updateSummary(results) {
  const validResults = results.filter((result) => !result.missing);
  const md5MatchCount = validResults.filter((result) => result.md5Equal).length;
  const similarCount = validResults.filter((result) => result.conclusion === "相似").length;
  const generalCount = validResults.filter((result) => result.conclusion === "一般").length;
  const differentCount = validResults.filter((result) => result.conclusion === "不相似").length;

  elements.pairedCount.textContent = String(validResults.length);
  elements.md5MatchCount.textContent = String(md5MatchCount);
  elements.similarCount.textContent = String(similarCount);
  elements.generalCount.textContent = String(generalCount);
  elements.differentCount.textContent = String(differentCount);
}

function resetSummary() {
  elements.pairedCount.textContent = "0";
  elements.md5MatchCount.textContent = "0";
  elements.similarCount.textContent = "0";
  elements.generalCount.textContent = "0";
  elements.differentCount.textContent = "0";
}

function renderEmpty(message) {
  elements.resultBody.innerHTML = `
    <div class="empty-state">${escapeHtml(message)}</div>
  `;
}

function setStatus(text) {
  elements.statusText.textContent = text;
}

function getPairingLabel(mode) {
  if (mode === "relative") {
    return "按目录相对路径";
  }
  if (mode === "filename") {
    return "按文件名";
  }
  if (mode === "index") {
    return "按上传顺序";
  }
  return "自动";
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function releaseEntries(entries) {
  entries.forEach((entry) => {
    analysisCache.delete(entry.file);
    if (entry.previewUrl) {
      URL.revokeObjectURL(entry.previewUrl);
    }
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function md5ArrayBuffer(buffer) {
  const words = bufferToWords(buffer);
  const bitLength = buffer.byteLength * 8;
  words[bitLength >> 5] |= 0x80 << (bitLength % 32);
  words[(((bitLength + 64) >>> 9) << 4) + 14] = bitLength;

  let a = 1732584193;
  let b = -271733879;
  let c = -1732584194;
  let d = 271733878;

  for (let i = 0; i < words.length; i += 16) {
    const previousA = a;
    const previousB = b;
    const previousC = c;
    const previousD = d;

    a = ff(a, b, c, d, words[i], 7, -680876936);
    d = ff(d, a, b, c, words[i + 1], 12, -389564586);
    c = ff(c, d, a, b, words[i + 2], 17, 606105819);
    b = ff(b, c, d, a, words[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, words[i + 4], 7, -176418897);
    d = ff(d, a, b, c, words[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, words[i + 6], 17, -1473231341);
    b = ff(b, c, d, a, words[i + 7], 22, -45705983);
    a = ff(a, b, c, d, words[i + 8], 7, 1770035416);
    d = ff(d, a, b, c, words[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, words[i + 10], 17, -42063);
    b = ff(b, c, d, a, words[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, words[i + 12], 7, 1804603682);
    d = ff(d, a, b, c, words[i + 13], 12, -40341101);
    c = ff(c, d, a, b, words[i + 14], 17, -1502002290);
    b = ff(b, c, d, a, words[i + 15], 22, 1236535329);

    a = gg(a, b, c, d, words[i + 1], 5, -165796510);
    d = gg(d, a, b, c, words[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, words[i + 11], 14, 643717713);
    b = gg(b, c, d, a, words[i], 20, -373897302);
    a = gg(a, b, c, d, words[i + 5], 5, -701558691);
    d = gg(d, a, b, c, words[i + 10], 9, 38016083);
    c = gg(c, d, a, b, words[i + 15], 14, -660478335);
    b = gg(b, c, d, a, words[i + 4], 20, -405537848);
    a = gg(a, b, c, d, words[i + 9], 5, 568446438);
    d = gg(d, a, b, c, words[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, words[i + 3], 14, -187363961);
    b = gg(b, c, d, a, words[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, words[i + 13], 5, -1444681467);
    d = gg(d, a, b, c, words[i + 2], 9, -51403784);
    c = gg(c, d, a, b, words[i + 7], 14, 1735328473);
    b = gg(b, c, d, a, words[i + 12], 20, -1926607734);

    a = hh(a, b, c, d, words[i + 5], 4, -378558);
    d = hh(d, a, b, c, words[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, words[i + 11], 16, 1839030562);
    b = hh(b, c, d, a, words[i + 14], 23, -35309556);
    a = hh(a, b, c, d, words[i + 1], 4, -1530992060);
    d = hh(d, a, b, c, words[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, words[i + 7], 16, -155497632);
    b = hh(b, c, d, a, words[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, words[i + 13], 4, 681279174);
    d = hh(d, a, b, c, words[i], 11, -358537222);
    c = hh(c, d, a, b, words[i + 3], 16, -722521979);
    b = hh(b, c, d, a, words[i + 6], 23, 76029189);
    a = hh(a, b, c, d, words[i + 9], 4, -640364487);
    d = hh(d, a, b, c, words[i + 12], 11, -421815835);
    c = hh(c, d, a, b, words[i + 15], 16, 530742520);
    b = hh(b, c, d, a, words[i + 2], 23, -995338651);

    a = ii(a, b, c, d, words[i], 6, -198630844);
    d = ii(d, a, b, c, words[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, words[i + 14], 15, -1416354905);
    b = ii(b, c, d, a, words[i + 5], 21, -57434055);
    a = ii(a, b, c, d, words[i + 12], 6, 1700485571);
    d = ii(d, a, b, c, words[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, words[i + 10], 15, -1051523);
    b = ii(b, c, d, a, words[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, words[i + 8], 6, 1873313359);
    d = ii(d, a, b, c, words[i + 15], 10, -30611744);
    c = ii(c, d, a, b, words[i + 6], 15, -1560198380);
    b = ii(b, c, d, a, words[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, words[i + 4], 6, -145523070);
    d = ii(d, a, b, c, words[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, words[i + 2], 15, 718787259);
    b = ii(b, c, d, a, words[i + 9], 21, -343485551);

    a = safeAdd(a, previousA);
    b = safeAdd(b, previousB);
    c = safeAdd(c, previousC);
    d = safeAdd(d, previousD);
  }

  return wordsToHex([a, b, c, d]);
}

function bufferToWords(buffer) {
  const bytes = new Uint8Array(buffer);
  const words = [];
  for (let i = 0; i < bytes.length; i += 1) {
    words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  }
  return words;
}

function wordsToHex(words) {
  let result = "";
  for (let i = 0; i < words.length * 4; i += 1) {
    const value = (words[i >> 2] >> ((i % 4) * 8)) & 0xff;
    result += value.toString(16).padStart(2, "0");
  }
  return result;
}

function safeAdd(x, y) {
  const low = (x & 0xffff) + (y & 0xffff);
  const high = (x >> 16) + (y >> 16) + (low >> 16);
  return (high << 16) | (low & 0xffff);
}

function bitRotateLeft(value, shift) {
  return (value << shift) | (value >>> (32 - shift));
}

function cmn(q, a, b, x, s, t) {
  return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
}

function ff(a, b, c, d, x, s, t) {
  return cmn((b & c) | (~b & d), a, b, x, s, t);
}

function gg(a, b, c, d, x, s, t) {
  return cmn((b & d) | (c & ~d), a, b, x, s, t);
}

function hh(a, b, c, d, x, s, t) {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}

function ii(a, b, c, d, x, s, t) {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}
