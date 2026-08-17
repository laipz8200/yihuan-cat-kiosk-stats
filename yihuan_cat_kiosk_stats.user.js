// ==UserScript==
// @name         异环午夜猫刊亭统计
// @namespace    https://kf.wanmei.com/
// @version      1.3.4
// @description  在物品流向查询页分别查询活动累计或今日的消费、收入、盈亏和回报率
// @match        https://kf.wanmei.com/selfItemFlowQuery*
// @license      GPL-3.0-only
// @homepageURL  https://github.com/laipz8200/yihuan-cat-kiosk-stats
// @supportURL   https://github.com/laipz8200/yihuan-cat-kiosk-stats/issues
// @downloadURL  https://raw.githubusercontent.com/laipz8200/yihuan-cat-kiosk-stats/main/yihuan_cat_kiosk_stats.user.js
// @updateURL    https://raw.githubusercontent.com/laipz8200/yihuan-cat-kiosk-stats/main/yihuan_cat_kiosk_stats.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const EVENT_START = new Date("2026-07-02T00:00:00+08:00");
  const DAY = 24 * 60 * 60 * 1000;
  const MAX_SLICE = 7 * DAY;
  const PAGE_SIZE = 1000;
  const END_TIME_GRACE = 5 * 1000;
  const SERVER_OFFSET = 8 * 60 * 60 * 1000;
  const ACTIONS_ID = "yihuan-cat-kiosk-stats-actions";
  const DIALOG_ID = "yihuan-cat-kiosk-stats-dialog";
  const NO_RECORDS_MESSAGE = "暂时没有搜索到对应的记录";
  const NUMBER_FORMAT = new Intl.NumberFormat("zh-CN");
  const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  // 查询明细不含单次消费额，按游戏内当前售价换算；汇总后会与接口总额校验。
  const CARD_PRICES = new Map([
    ["《荧幕之外》", 10000],
    ["《海特洛快讯》", 20000],
    ["《猫会梦见什么》", 50000],
    ["《拉面的艺术》", 50000],
    ["《在书本之外》", 50000],
  ]);

  function formatDate(date) {
    return new Date(date.getTime() + SERVER_OFFSET)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
  }

  function gameDayStart(now) {
    const serverNow = new Date(now.getTime() + SERVER_OFFSET);
    const start = new Date(serverNow);
    start.setUTCHours(4, 0, 0, 0);
    if (start > serverNow) start.setUTCDate(start.getUTCDate() - 1);
    return new Date(start.getTime() - SERVER_OFFSET);
  }

  function splitRange(start, end) {
    if (start > end) throw new Error("开始时间晚于结束时间");

    const slices = [];
    let cursor = new Date(start);
    while (cursor <= end) {
      const sliceEnd = new Date(
        Math.min(end.getTime(), cursor.getTime() + MAX_SLICE - 1000),
      );
      slices.push({ start: cursor, end: sliceEnd });
      cursor = new Date(sliceEnd.getTime() + 1000);
    }
    return slices;
  }

  function parseInfo(info) {
    if (!info) return { spent: 0, income: 0 };
    const match = info.match(/共计消耗(\d+)方斯.*?获得奖券奖励(\d+)方斯/);
    if (!match) throw new Error(`无法识别汇总结果：${info}`);
    return { spent: Number(match[1]), income: Number(match[2]) };
  }

  function emptyPage() {
    return { spent: 0, income: 0, records: [], total: 0 };
  }

  function parsePayload(raw) {
    const text = typeof raw === "string"
      ? raw.replace(/<pre[^>]*>/gi, "").replace(/<\/pre>/gi, "").trim()
      : raw;
    let payload;
    try {
      payload = typeof text === "string" ? JSON.parse(text) : text;
    } catch {
      throw new Error("查询返回异常，登录可能已经失效");
    }
    if (!payload) throw new Error("查询没有返回结果，请稍后重试");
    if (String(payload.code) === "1") {
      if (String(payload.message || "").startsWith(NO_RECORDS_MESSAGE)) return emptyPage();
      throw new Error(payload.message || "查询失败");
    }
    const records = payload?.data?.result;
    if (!Array.isArray(records)) throw new Error("查询返回缺少活动明细");
    const total = Number(payload.data.total ?? (records.length === 0 ? 0 : NaN));
    if (!Number.isInteger(total) || total < records.length) {
      throw new Error("查询返回的记录总数异常");
    }
    if (records.length === 0) {
      if (total !== 0) throw new Error("查询明细分页不完整");
      return emptyPage();
    }
    return { ...parseInfo(payload.data.info), records, total };
  }

  function metrics({ spent, income }) {
    return {
      spent,
      income,
      profit: income - spent,
      returnRate: spent ? (income / spent) * 100 : null,
    };
  }

  function aggregateRecords(records, end) {
    const totals = { spent: 0, income: 0 };
    const byDay = new Map();
    for (const record of records) {
      const date = String(record?.logTime ?? "").slice(0, 10);
      const card = String(record?.scratchCardId ?? "").trim();
      const award = String(record?.award ?? "").trim();
      const incomeMatch = award.match(/^方斯\*(\d+)$/);
      const spent = CARD_PRICES.get(card);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`无法识别记录时间：${record?.logTime ?? ""}`);
      }
      if (spent === undefined) throw new Error(`无法识别好感度道具：${card}`);
      if (award && !incomeMatch) throw new Error(`无法识别奖励：${award}`);

      const income = incomeMatch ? Number(incomeMatch[1]) : 0;
      const day = byDay.get(date) || { spent: 0, income: 0 };
      day.spent += spent;
      day.income += income;
      byDay.set(date, day);
      totals.spent += spent;
      totals.income += income;
    }

    if (byDay.size === 0) return { ...totals, daily: [] };
    const first = [...byDay.keys()].sort()[0];
    const last = formatDate(end).slice(0, 10);
    const lastDate = new Date(`${last}T00:00:00Z`);
    const daily = [];
    let cumulativeProfit = 0;
    for (
      let cursor = new Date(`${first}T00:00:00Z`);
      cursor <= lastDate;
      cursor = new Date(cursor.getTime() + DAY)
    ) {
      const date = cursor.toISOString().slice(0, 10);
      cumulativeProfit += metrics(byDay.get(date) || { spent: 0, income: 0 }).profit;
      daily.push({ date, profit: cumulativeProfit });
    }
    return { ...totals, daily };
  }

  function requireQueryForm() {
    const form = document.querySelector("#selfItemFlowQueryForm");
    if (!form) throw new Error("请先登录并进入异环物品流向自助查询页面");
    if (!document.querySelector("#prolink")?.checked) {
      throw new Error("请先勾选《完美世界游戏用户自助服务规则》");
    }
    const roleId = form.querySelector('[name="roleId"]')?.value;
    if (!roleId || roleId === "0") {
      throw new Error("请先在页面选择角色");
    }
    return form;
  }

  function formParams(start, end, pageNo = 1) {
    const params = new URLSearchParams(new FormData(requireQueryForm()));

    for (const name of ["item1", "item2", "item3", "item4", "item8", "item11"]) {
      params.delete(name);
    }
    params.set("gameId", "191");
    params.set("itemType", "13");
    params.set("item", "");
    params.set("startTime", formatDate(start));
    params.set("endTime", formatDate(end));
    params.set("pageNo", String(pageNo));
    params.set("pageSize", String(PAGE_SIZE));
    return params;
  }

  function prepareRange(start, end) {
    const $ = globalThis.jQuery;
    if (!$?.fn?.datetimebox || !$?.fn?.combobox) {
      throw new Error("页面查询组件尚未加载，请刷新页面后重试");
    }
    if (String($("#itemType").combobox("getValue")) !== "13") {
      $("#itemType").combobox("select", "13");
    }
    $("#startTime").datetimebox("setValue", formatDate(start));
    $("#endTime").datetimebox("setValue", formatDate(end));
  }

  function freshCaptcha(instance, secCode, consumed) {
    return secCode && instance !== consumed ? { instance, secCode } : null;
  }

  function captchaResult(consumed) {
    if (typeof mCaptcha === "undefined" || typeof initCaptcha !== "function") {
      throw new Error("页面滑动验证组件尚未加载，请刷新页面后重试");
    }
    return freshCaptcha(
      mCaptcha,
      String(mCaptcha.getValidateResult() || "").trim(),
      consumed,
    );
  }

  function resetCaptcha() {
    const secCodeInput = document.querySelector("#secCode");
    if (secCodeInput) secCodeInput.value = "";
    try { initCaptcha(); } catch {}
  }

  async function requestPage(start, end, pageNo, secCode) {
    try {
      const params = formParams(start, end, pageNo);
      if (!params.get("capTicket")) throw new Error("滑动验证尚未准备好，请稍后重试");
      params.set("secCode", secCode);
      const response = await fetch("/selfItemFlowQuery/search", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: params.toString(),
      });
      if (!response.ok) throw new Error(`查询失败：HTTP ${response.status}`);
      return parsePayload(await response.text());
    } finally {
      resetCaptcha();
    }
  }

  async function collectPages(request, shouldRetry = () => false) {
    let summary;
    let total = 0;
    const records = [];
    for (let pageNo = 1; ; pageNo += 1) {
      let page;
      for (;;) {
        try {
          page = await request(pageNo);
          const expectedTotal = summary ? total : page.total;
          if (summary && page.total !== total) throw new Error("查询明细分页总数异常");
          if (records.length + page.records.length > expectedTotal) {
            throw new Error("查询明细分页异常");
          }
          if (records.length > 0 && page.records.length === 0) {
            throw new Error("查询明细分页不完整");
          }
          break;
        } catch (error) {
          if (!shouldRetry(error)) throw error;
        }
      }
      if (!summary) {
        summary = { spent: page.spent, income: page.income };
        total = page.total;
      }
      records.push(...page.records);
      if (records.length === total) break;
    }
    return { ...summary, records, total };
  }

  // ponytail: 等待或请求卡住时刷新页面；需要保留页面状态时再加无刷新取消。
  function waitForClick(button, text) {
    button.textContent = text;
    button.disabled = false;
    return new Promise((resolve) => {
      button.addEventListener("click", () => {
        button.disabled = true;
        resolve();
      }, { once: true });
    });
  }

  async function waitForCaptcha(button, text, verification) {
    let result = captchaResult(verification.consumed);
    while (!result) {
      await waitForClick(button, text);
      result = captchaResult(verification.consumed);
      if (!result) {
        alert("[异环猫刊亭统计] 请先完成页面上的滑动验证");
      }
    }
    verification.consumed = result.instance;
    return result.secCode;
  }

  async function querySlice(button, start, end, index, count, verification) {
    prepareRange(start, end);
    requireQueryForm();
    return collectPages(async (pageNo) => {
      const step = `第 ${index}/${count} 段${pageNo > 1 ? ` · 第 ${pageNo} 页` : ""}`;
      const secCode = await waitForCaptcha(
        button,
        `${step}：滑动后继续`,
        verification,
      );
      button.textContent = `${step}：查询中`;
      return requestPage(start, end, pageNo, secCode);
    }, (error) => {
      if (!confirm(
        `[异环猫刊亭统计] ${error.message}\n\n重新完成滑动验证后重试当前请求？`,
      )) throw new Error("查询已取消");
      return true;
    });
  }

  async function runQuery(button, start, end, verification) {
    const slices = splitRange(start, end);
    const total = { spent: 0, income: 0 };
    const records = [];
    for (let index = 0; index < slices.length; index += 1) {
      const value = await querySlice(
        button,
        slices[index].start,
        slices[index].end,
        index + 1,
        slices.length,
        verification,
      );
      if (value.records.length === 0) continue;
      total.spent += value.spent;
      total.income += value.income;
      records.push(...value.records);
    }
    const details = aggregateRecords(records, end);
    if (details.spent !== total.spent || details.income !== total.income) {
      throw new Error("查询明细与汇总不一致，活动售价或返回格式可能已调整");
    }
    return { ...metrics(total), daily: details.daily };
  }

  function addCell(row, text) {
    const cell = document.createElement("td");
    cell.textContent = text;
    row.append(cell);
  }

  function profitChartLayout(days) {
    const viewportWidth = 700;
    const height = 260;
    const left = 72;
    const right = 20;
    const top = 18;
    const bottom = 52;
    const plotWidth = Math.max(viewportWidth - left - right, (days.length - 1) * 60);
    const width = left + plotWidth + right;
    const plotBottom = height - bottom;
    const profits = days.map((day) => day.profit);
    let min = Math.min(0, ...profits);
    let max = Math.max(0, ...profits);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    return {
      width,
      height,
      left,
      right,
      top,
      plotBottom,
      ticks: [max, (max + min) / 2, min],
      x: (index) => left + (days.length === 1
        ? plotWidth / 2
        : (index * plotWidth) / (days.length - 1)),
      y: (value) => top + ((max - value) / (max - min)) * (plotBottom - top),
    };
  }

  function renderProfitChart(days) {
    const container = document.querySelector(`#${DIALOG_ID} [data-profit-chart]`);
    container.classList.toggle("empty", days.length === 0);
    if (days.length === 0) {
      container.textContent = "暂无盈亏记录";
      container.setAttribute("aria-label", "累计盈亏折线图：暂无记录");
      return;
    }

    const { width, height, left, right, top, plotBottom, ticks, x, y } =
      profitChartLayout(days);

    container.setAttribute(
      "aria-label",
      `截至当日累计盈亏折线图，${days[0].date} 至 ${days.at(-1).date}，期末累计盈亏 ${NUMBER_FORMAT.format(days.at(-1).profit)}`,
    );
    container.innerHTML = `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
        ${ticks.map((tick) => `
          <line x1="${left}" y1="${y(tick)}" x2="${width - right}" y2="${y(tick)}" stroke="#e7e7e7" />
          <text x="${left - 10}" y="${y(tick) + 4}" text-anchor="end" fill="#666" font-size="11">${COMPACT_NUMBER_FORMAT.format(tick)}</text>
        `).join("")}
        <line x1="${left}" y1="${top}" x2="${left}" y2="${plotBottom}" stroke="#999" />
        <line x1="${left}" y1="${y(0)}" x2="${width - right}" y2="${y(0)}" stroke="#aaa" stroke-dasharray="4 4" />
        <polyline
          points="${days.map((day, index) => `${x(index)},${y(day.profit)}`).join(" ")}"
          fill="none" stroke="#6f4cff" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"
        />
        ${days.map((day, index) => `
          <circle cx="${x(index)}" cy="${y(day.profit)}" r="3.5" fill="#6f4cff">
            <title>${day.date} 累计盈亏：${NUMBER_FORMAT.format(day.profit)}</title>
          </circle>
          <text x="${x(index)}" y="${plotBottom + 20}" text-anchor="middle" fill="#666" font-size="11">${day.date.slice(5)}</text>
        `).join("")}
        <text x="16" y="${(top + plotBottom) / 2}" text-anchor="middle" fill="#444" font-size="12"
          transform="rotate(-90 16 ${(top + plotBottom) / 2})">累计盈亏</text>
        <text x="${left - 18}" y="${height - 10}" text-anchor="end" fill="#444" font-size="12">日期</text>
      </svg>
    `;
  }

  function showResult(label, value, generatedAt) {
    const dialog = document.querySelector(`#${DIALOG_ID}`);
    const body = dialog.querySelector("tbody");
    body.replaceChildren();

    const row = document.createElement("tr");
    addCell(row, label);
    addCell(row, NUMBER_FORMAT.format(value.spent));
    addCell(row, NUMBER_FORMAT.format(value.income));
    addCell(row, NUMBER_FORMAT.format(value.profit));
    addCell(row, value.profit > 0 ? "盈利" : value.profit < 0 ? "亏损" : "持平");
    addCell(row, value.returnRate === null ? "—" : `${value.returnRate.toFixed(2)}%`);
    body.append(row);
    dialog.querySelector("[data-generated-at]").textContent = `统计时间：${generatedAt}`;
    renderProfitChart(value.daily);
    dialog.showModal();
  }

  function installUi() {
    if (document.querySelector(`#${ACTIONS_ID}`)) return;
    const queryButton = document.querySelector("#btn");
    if (!queryButton) return;

    const style = document.createElement("style");
    style.textContent = `
      #${ACTIONS_ID} { display: inline-flex; gap: 8px; margin-left: 12px; vertical-align: middle; }
      #${ACTIONS_ID} button {
        border: 0; border-radius: 6px; padding: 9px 13px;
        color: #fff; background: #6f4cff; cursor: pointer;
        font: 14px/1.2 system-ui, sans-serif;
      }
      #${ACTIONS_ID} button:disabled { opacity: .65; cursor: wait; }
      #${DIALOG_ID} {
        border: 0; border-radius: 12px; padding: 24px;
        box-sizing: border-box; width: 748px; max-width: calc(100vw - 48px);
        color: #222; background: #fff; font: 14px/1.5 system-ui, sans-serif;
        box-shadow: 0 16px 48px #0005;
      }
      #${DIALOG_ID}::backdrop { background: #0008; }
      #${DIALOG_ID} h2 { margin: 0 40px 4px 0; font-size: 20px; }
      #${DIALOG_ID} h3 { margin: 0 0 8px; font-size: 15px; }
      #${DIALOG_ID} p { margin: 0 0 16px; color: #666; }
      #${DIALOG_ID} [data-profit-chart] {
        width: 100%; min-height: 260px;
        overflow-x: auto; overflow-y: hidden; margin-bottom: 16px;
        border-radius: 8px; box-shadow: inset 0 0 0 1px #eee;
      }
      #${DIALOG_ID} [data-profit-chart].empty {
        display: grid; place-items: center; color: #777;
      }
      #${DIALOG_ID} [data-profit-chart] svg { display: block; }
      #${DIALOG_ID} table { border-collapse: collapse; width: 100%; }
      #${DIALOG_ID} th, #${DIALOG_ID} td {
        border-bottom: 1px solid #ddd; padding: 9px 10px; text-align: right;
      }
      #${DIALOG_ID} th:first-child, #${DIALOG_ID} td:first-child { text-align: left; }
      #${DIALOG_ID} [data-close] {
        position: absolute; top: 14px; right: 14px; border: 0;
        background: transparent; font-size: 24px; cursor: pointer;
      }
    `;

    const actions = document.createElement("span");
    actions.id = ACTIONS_ID;
    const activityButton = document.createElement("button");
    activityButton.type = "button";
    activityButton.textContent = "查询活动累计";
    const todayButton = document.createElement("button");
    todayButton.type = "button";
    todayButton.textContent = "查询今日";
    actions.append(activityButton, todayButton);

    const dialog = document.createElement("dialog");
    dialog.id = DIALOG_ID;
    dialog.setAttribute("aria-labelledby", `${DIALOG_ID}-title`);
    dialog.innerHTML = `
      <button type="button" data-close aria-label="关闭">×</button>
      <h2 id="${DIALOG_ID}-title">午夜猫刊亭统计</h2>
      <p data-generated-at></p>
      <h3>截至当日累计盈亏</h3>
      <div data-profit-chart role="img"></div>
      <table>
        <thead><tr><th>范围</th><th>消费</th><th>收入</th><th>盈亏</th><th>结果</th><th>回报率</th></tr></thead>
        <tbody></tbody>
      </table>
    `;
    dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());

    const buttons = [activityButton, todayButton];
    const verification = { consumed: null };
    let running = false;
    async function execute(button, label, start, key) {
      if (running) return;
      running = true;
      buttons.forEach((item) => { item.disabled = true; });
      try {
        const periodEnd = new Date(
          Math.floor(Date.now() / 1000) * 1000 - END_TIME_GRACE,
        );
        const periodStart = start(periodEnd);
        const generatedAt = formatDate(periodEnd);
        const value = await runQuery(
          button,
          periodStart,
          periodEnd,
          verification,
        );
        globalThis.yihuanActivityStats = {
          ...(globalThis.yihuanActivityStats || {}),
          [key]: { generatedAt, ...value },
        };
        showResult(label, value, generatedAt);
      } catch (error) {
        if (error.message !== "查询已取消") {
          alert(`[异环猫刊亭统计] ${error.message}`);
        }
      } finally {
        running = false;
        buttons.forEach((item) => { item.disabled = false; });
        activityButton.textContent = "查询活动累计";
        todayButton.textContent = "查询今日";
      }
    }
    activityButton.addEventListener("click", () =>
      execute(activityButton, "活动开始至今", () => EVENT_START, "activityToDate"));
    todayButton.addEventListener("click", () =>
      execute(todayButton, "今日", gameDayStart, "today"));

    document.head.append(style);
    queryButton.insertAdjacentElement("afterend", actions);
    document.body.append(dialog);
  }

  async function selfCheck() {
    function check(condition, message) {
      if (!condition) throw new Error(message);
    }

    function errorMessage(callback) {
      try {
        callback();
      } catch (error) {
        return error.message;
      }
      return null;
    }

    const slices = splitRange(
      new Date("2026-07-02T00:00:00+08:00"),
      new Date("2026-07-22T00:00:00+08:00"),
    );
    const parsed = parsePayload(
      '<pre>{"code":0,"data":{"total":5,"result":[{"logTime":"2026-07-03 12:00","scratchCardId":"《荧幕之外》","award":"方斯*40000"},{"logTime":"2026-07-03 12:01","scratchCardId":"《拉面的艺术》","award":"方斯*50000"},{"logTime":"2026-07-03 12:02","scratchCardId":"《在书本之外》","award":"方斯*50000"},{"logTime":"2026-07-04 12:00","scratchCardId":"《猫会梦见什么》","award":"方斯*50000"},{"logTime":"2026-07-05 12:00","scratchCardId":"《海特洛快讯》","award":""}],"info":"共计消耗180000方斯购买好感度道具，获得奖券奖励190000方斯"}}</pre>',
    );
    const empty = parsePayload(
      '{"code":0,"data":{"result":[],"info":"暂时没有搜索到对应的信息"}}',
    );
    const messageEmpty = parsePayload(
      '{"code":1,"message":"暂时没有搜索到对应的记录，请精确您的信息"}',
    );
    const rejectedMessage = errorMessage(() =>
      parsePayload('{"code":"1","message":"测试错误"}'));
    const incompleteMessage = errorMessage(() =>
      parsePayload('{"code":0,"data":{"total":1,"result":[]}}'));
    const missingTotalMessage = errorMessage(() =>
      parsePayload('{"code":0,"data":{"result":[{}],"info":"测试"}}'));
    const details = aggregateRecords(
      parsed.records,
      new Date("2026-07-05T23:59:59+08:00"),
    );
    const requestedPages = [];
    let pageTwoAttempts = 0;
    const paged = await collectPages(async (pageNo) => {
      requestedPages.push(pageNo);
      if (pageNo === 2 && pageTwoAttempts++ === 0) return empty;
      return pageNo === 1
        ? { spent: 180000, income: 190000, total: 2, records: parsed.records.slice(0, 1) }
        : { spent: 180000, income: 190000, total: 2, records: parsed.records.slice(1, 2) };
    }, () => true);
    let emptyRequests = 0;
    await collectPages(async () => {
      emptyRequests += 1;
      return messageEmpty;
    });
    const singlePointChart = profitChartLayout([{ profit: 0 }]);
    const scrollableChart = profitChartLayout(
      Array.from({ length: 12 }, () => ({ profit: 0 })),
    );

    check(
      slices.length === 3
      && formatDate(slices[0].end) === "2026-07-08 23:59:59"
      && formatDate(slices[1].start) === "2026-07-09 00:00:00",
      "分片自检失败",
    );
    check(
      slices[0].end.getTime() + 1000 === slices[1].start.getTime(),
      "分片边界自检失败",
    );
    check(
      parsed.spent === 180000
      && parsed.total === 5
      && metrics(parsed).profit === 10000,
      "汇总自检失败",
    );
    check(
      [empty, messageEmpty].every((value) =>
        value.spent === 0 && value.income === 0 && value.records.length === 0),
      "空区间自检失败",
    );
    check(
      details.spent === parsed.spent
      && details.income === parsed.income
      && details.daily.map((day) => day.date).join(",") === "2026-07-03,2026-07-04,2026-07-05"
      && details.daily.map((day) => day.profit).join(",") === "30000,30000,10000",
      "累计盈亏自检失败",
    );
    check(rejectedMessage === "测试错误", "错误响应自检失败");
    check(incompleteMessage === "查询明细分页不完整", "分页自检失败");
    check(missingTotalMessage === "查询返回的记录总数异常", "分页总数自检失败");
    check(
      requestedPages.join(",") === "1,2,2" && paged.records.length === 2,
      "多页查询自检失败",
    );
    check(emptyRequests === 1, "空分页请求自检失败");
    const captcha = {};
    check(
      freshCaptcha(captcha, "code", null)?.instance === captcha
      && freshCaptcha(captcha, "code", captcha) === null
      && freshCaptcha({}, "", captcha) === null,
      "滑动验证自检失败",
    );
    check(
      formatDate(gameDayStart(new Date("2026-07-22T03:59:59+08:00"))) === "2026-07-21 04:00:00"
      && formatDate(gameDayStart(new Date("2026-07-22T04:00:00+08:00"))) === "2026-07-22 04:00:00",
      "今日起点自检失败",
    );
    check(
      formatDate(new Date("2026-07-21T16:49:00Z")) === "2026-07-22 00:49:00",
      "时间格式自检失败",
    );
    check(
      singlePointChart.width === 700
      && Number.isFinite(singlePointChart.x(0))
      && Number.isFinite(singlePointChart.y(0)),
      "图表布局自检失败",
    );
    check(scrollableChart.width > 700, "图表滚动自检失败");
    console.log("Self-check passed");
  }

  if (typeof document === "undefined") {
    selfCheck().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
  else installUi();
})();
