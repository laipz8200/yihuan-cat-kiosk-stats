// ==UserScript==
// @name         异环午夜猫刊亭统计
// @namespace    https://kf.wanmei.com/
// @version      1.2.1
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
  const END_TIME_GRACE = 5 * 1000;
  const SERVER_OFFSET = 8 * 60 * 60 * 1000;
  const ACTIONS_ID = "yihuan-cat-kiosk-stats-actions";
  const DIALOG_ID = "yihuan-cat-kiosk-stats-dialog";

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
    if (start >= serverNow) start.setUTCDate(start.getUTCDate() - 1);
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
    if (String(payload.code) === "1") throw new Error(payload.message || "查询失败");
    if (Array.isArray(payload?.data?.result) && payload.data.result.length === 0) {
      return { spent: 0, income: 0 };
    }
    return parseInfo(payload?.data?.info);
  }

  function metrics({ spent, income }) {
    return {
      spent,
      income,
      profit: income - spent,
      returnRate: spent ? (income / spent) * 100 : null,
    };
  }

  function formParams(start, end) {
    const form = document.querySelector("#selfItemFlowQueryForm");
    if (!form) throw new Error("请先登录并进入异环物品流向自助查询页面");
    if (!document.querySelector("#prolink")?.checked) {
      throw new Error("请先勾选《完美世界游戏用户自助服务规则》");
    }

    const params = new URLSearchParams(new FormData(form));
    if (!params.get("roleId") || params.get("roleId") === "0") {
      throw new Error("请先在页面选择角色");
    }

    for (const name of ["item1", "item2", "item3", "item4", "item8", "item11"]) {
      params.delete(name);
    }
    params.set("gameId", "191");
    params.set("itemType", "13");
    params.set("item", "");
    params.set("startTime", formatDate(start));
    params.set("endTime", formatDate(end));
    params.set("pageNo", "1");
    params.set("pageSize", "1000");
    return params;
  }

  async function querySlice(start, end) {
    const response = await fetch("/selfItemFlowQuery/search", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: formParams(start, end).toString(),
    });
    if (!response.ok) throw new Error(`查询失败：HTTP ${response.status}`);

    return parsePayload(await response.text());
  }

  async function queryPageRange(start, end) {
    formParams(start, end);
    const $ = globalThis.jQuery;
    if (!$?.fn?.datetimebox || !$?.fn?.combobox || !$?.fn?.ajaxSubmit) {
      throw new Error("页面查询组件尚未加载，请刷新页面后重试");
    }

    if (String($("#itemType").combobox("getValue")) !== "13") {
      $("#itemType").combobox("select", "13");
    }
    $("#startTime").datetimebox("setValue", formatDate(start));
    $("#endTime").datetimebox("setValue", formatDate(end));

    const form = $("#selfItemFlowQueryForm");
    const data = form
      .find(":not('input[name=item1],input[name=item2],input[name=item3],input[name=item4],input[name=item8],input[name=item11]')")
      .serialize();
    return new Promise((resolve, reject) => {
      form.ajaxSubmit({
        type: "post",
        url: "/selfItemFlowQuery/search",
        data,
        timeout: 20000,
        success(raw) {
          try {
            resolve(parsePayload(raw));
          } catch (error) {
            reject(error);
          }
        },
        error(_request, status) {
          reject(new Error(status === "timeout" ? "查询超时，请稍后重试" : "查询失败，请稍后重试"));
        },
      });
    });
  }

  async function runQuery(button, start, end) {
    const slices = splitRange(start, end);
    const total = { spent: 0, income: 0 };
    for (let index = 0; index < slices.length; index += 1) {
      button.textContent = `查询中 ${index + 1}/${slices.length}`;
      const value = await querySlice(slices[index].start, slices[index].end);
      total.spent += value.spent;
      total.income += value.income;
    }
    return metrics(total);
  }

  function addCell(row, text) {
    const cell = document.createElement("td");
    cell.textContent = text;
    row.append(cell);
  }

  function showResult(label, value, generatedAt) {
    const dialog = document.querySelector(`#${DIALOG_ID}`);
    const body = dialog.querySelector("tbody");
    const number = new Intl.NumberFormat("zh-CN");
    body.replaceChildren();

    const row = document.createElement("tr");
    addCell(row, label);
    addCell(row, number.format(value.spent));
    addCell(row, number.format(value.income));
    addCell(row, number.format(value.profit));
    addCell(row, value.profit > 0 ? "盈利" : value.profit < 0 ? "亏损" : "持平");
    addCell(row, value.returnRate === null ? "—" : `${value.returnRate.toFixed(2)}%`);
    body.append(row);
    dialog.querySelector("[data-generated-at]").textContent = `统计时间：${generatedAt}`;
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
        border: 0; border-radius: 12px; padding: 24px; max-width: 760px;
        color: #222; background: #fff; font: 14px/1.5 system-ui, sans-serif;
        box-shadow: 0 16px 48px #0005;
      }
      #${DIALOG_ID}::backdrop { background: #0008; }
      #${DIALOG_ID} h2 { margin: 0 40px 4px 0; font-size: 20px; }
      #${DIALOG_ID} p { margin: 0 0 16px; color: #666; }
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
      <table>
        <thead><tr><th>范围</th><th>消费</th><th>收入</th><th>盈亏</th><th>结果</th><th>回报率</th></tr></thead>
        <tbody></tbody>
      </table>
    `;
    dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());

    const buttons = [activityButton, todayButton];
    let running = false;
    async function execute(button, label, start, key, useNativeQuery = false) {
      if (running) return;
      running = true;
      buttons.forEach((item) => { item.disabled = true; });
      try {
        const periodEnd = new Date(
          Math.floor(Date.now() / 1000) * 1000 - END_TIME_GRACE,
        );
        const periodStart = start(periodEnd);
        button.textContent = "查询中 1/1";
        const value = useNativeQuery
          ? metrics(await queryPageRange(periodStart, periodEnd))
          : await runQuery(button, periodStart, periodEnd);
        const generatedAt = formatDate(periodEnd);
        globalThis.yihuanActivityStats = {
          ...(globalThis.yihuanActivityStats || {}),
          [key]: { generatedAt, ...value },
        };
        showResult(label, value, generatedAt);
      } catch (error) {
        alert(`[异环猫刊亭统计] ${error.message}`);
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
      execute(
        todayButton,
        "今日",
        gameDayStart,
        "today",
        true,
      ));

    document.head.append(style);
    queryButton.insertAdjacentElement("afterend", actions);
    document.body.append(dialog);
  }

  function selfCheck() {
    const slices = splitRange(
      new Date("2026-07-02T00:00:00+08:00"),
      new Date("2026-07-22T00:00:00+08:00"),
    );
    const parsed = parsePayload(
      '<pre>{"code":0,"data":{"info":"共计消耗17420000方斯购买好感度道具，获得奖券奖励15180000方斯"}}</pre>',
    );
    const empty = parsePayload(
      '{"code":0,"data":{"result":[],"info":"暂时没有搜索到对应的信息"}}',
    );
    let rejectedError;
    try {
      parsePayload('{"code":"1","message":"测试错误"}');
    } catch (error) {
      rejectedError = error;
    }
    if (slices.length !== 3) throw new Error("分片自检失败");
    if (slices[0].end.getTime() + 1000 !== slices[1].start.getTime()) {
      throw new Error("分片边界自检失败");
    }
    if (parsed.spent !== 17420000 || metrics(parsed).profit !== -2240000) {
      throw new Error("汇总自检失败");
    }
    if (empty.spent !== 0 || empty.income !== 0) throw new Error("空区间自检失败");
    if (rejectedError?.message !== "测试错误") throw new Error("错误响应自检失败");
    if (
      formatDate(gameDayStart(new Date("2026-07-22T03:59:59+08:00"))) !== "2026-07-21 04:00:00"
      || formatDate(gameDayStart(new Date("2026-07-22T04:00:01+08:00"))) !== "2026-07-22 04:00:00"
    ) {
      throw new Error("今日起点自检失败");
    }
    if (formatDate(new Date("2026-07-21T16:49:00Z")) !== "2026-07-22 00:49:00") {
      throw new Error("时间格式自检失败");
    }
    console.log("Self-check passed");
  }

  if (typeof document === "undefined") selfCheck();
  else installUi();
})();
