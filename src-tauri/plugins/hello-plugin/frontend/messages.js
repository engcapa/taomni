const en = { message: "Message", save: "Save", saving: "Saving…", loading: "Loading…", empty: "No saved messages yet" };
const zh = { message: "消息", save: "保存", saving: "正在保存…", loading: "正在加载…", empty: "暂无已保存的消息" };

export function helloLabels(locale) {
  return locale === "zh-CN" ? zh : en;
}
