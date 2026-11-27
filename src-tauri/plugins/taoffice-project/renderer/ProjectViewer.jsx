import { MAX_PROJECT_BYTES, MAX_TASK_NAME, parseProject, projectCopy } from "./projectXml.js";
import { taskBar, timelineExtent } from "./timeline.js";
import { useDocumentDraft } from "../../../crates/taomni-plugin-api/frontend/documentDraft.js";
import styles from "./projectViewer.css?inline";

const { React, i18n } = globalThis.__taomniHost;
const { useEffect, useRef, useState } = React;
const PAGE_SIZE = 100;
const dateLabel = (value) => value?.slice(0, 10) ?? "—";
const extentLabel = (value) => new Date(value).toISOString().slice(0, 10);

export default function ProjectViewer({ document: source, active }) {
  const { locale } = i18n.useLocale();
  const label = (zh, en) => locale === "zh-CN" ? zh : en;
  const [state, setState] = useState(null);
  useEffect(() => {
    let current = true;
    async function load() {
      const file = await source.read();
      if (file.size > MAX_PROJECT_BYTES) throw new Error(label("Project XML 预览上限为 8 MiB。", "Project XML preview is limited to 8 MiB."));
      const project = parseProject(new Uint8Array(await file.arrayBuffer()));
      if (current) setState({ source, project });
    }
    void load().catch((error) => { if (current) setState({ source, error: String(error) }); });
    return () => { current = false; };
  }, [source]);

  return <section className="taoffice-project" aria-label={source.name} data-testid="taoffice-project">
    <style>{styles}</style>
    {state?.source !== source ? <p role="status">{label("正在打开项目…", "Opening project…")}</p>
      : state.error ? <p role="alert" data-testid="taoffice-project-error">{state.error}</p>
        : <ProjectSchedule source={source} project={state.project} active={active} label={label} />}
  </section>;
}

function ProjectSchedule({ source, project, active, label }) {
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const draft = useDocumentDraft(source, (edits) => projectCopy(project, edits));
  const scheduled = project.tasks.filter((task) => (draft.edits.get(task.uid) ?? task.name)
    .toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const visible = scheduled.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const extent = timelineExtent(project.tasks);
  const save = () => { void draft.save().catch(() => {}); };

  return <div className="taoffice-project-schedule" onKeyDown={(event) => {
    if (!active || event.nativeEvent.isComposing || event.altKey || event.shiftKey
      || !(source.platform === "macos" ? event.metaKey : event.ctrlKey)
      || event.key.toLowerCase() !== "s" || !draft.dirty) return;
    event.stopPropagation();
    event.preventDefault();
    save();
  }}>
    <div className="taoffice-project-toolbar">
      <h2>{project.title || source.name}</h2>
      <input type="search" className="taomni-input" data-testid="taoffice-project-filter"
        aria-label={label("筛选任务", "Filter tasks")} placeholder={label("筛选任务", "Filter tasks")} value={filter}
        onChange={(event) => { setFilter(event.target.value); setPage(0); }} />
      {source.saveCopy && <button type="button" className="taomni-btn" data-variant="primary"
        data-testid="taoffice-project-save" disabled={!draft.dirty || draft.saving}
        aria-busy={draft.saving} onClick={save}>{draft.saving ? label("正在保存…", "Saving…") : label("保存副本", "Save a copy")}</button>}
    </div>
    {draft.output && <p role="status" data-testid="taoffice-project-output">{draft.output}</p>}
    {draft.error && <p role="alert">{draft.error}</p>}
    {visible.length ? <div className="taoffice-project-scroll">
      <table className="taoffice-project-table" data-testid="taoffice-project-schedule"
        aria-label={label("项目任务和时间轴", "Project tasks and timeline")}>
        <thead><tr>
          <th scope="col">{label("任务", "Task")}</th>
          <th scope="col">{label("开始", "Start")}</th>
          <th scope="col">{label("完成", "Finish")}</th>
          <th scope="col">{label("进度", "Progress")}</th>
          <th scope="col">{label("前置任务", "Predecessors")}</th>
          <th scope="col">
            {extent ? [extentLabel(extent.first), extentLabel(extent.last)].join(" – ") : label("时间轴", "Timeline")}
          </th>
        </tr></thead>
        <tbody>{visible.map((task) => <ProjectRow key={task.uid} task={task} extent={extent} draft={draft}
          editable={!!source.saveCopy && !!task.range} label={label} />)}</tbody>
      </table>
    </div> : <p role="status">{filter ? label("没有匹配任务", "No matching tasks") : label("没有任务", "No tasks")}</p>}
    {scheduled.length > PAGE_SIZE && <div className="taoffice-project-toolbar">
      <button type="button" className="taomni-btn" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>{label("上一页", "Previous page")}</button>
      <span>{page + 1} / {Math.ceil(scheduled.length / PAGE_SIZE)}</span>
      <button type="button" className="taomni-btn" disabled={(page + 1) * PAGE_SIZE >= scheduled.length}
        onClick={() => setPage((value) => value + 1)}>{label("下一页", "Next page")}</button>
    </div>}
  </div>;
}

function ProjectRow({ task, extent, draft, editable, label }) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const editButton = useRef(null);
  const focusEditButton = useRef(false);
  const nameField = useRef(null);
  const name = draft.edits.get(task.uid) ?? task.name;
  const bar = taskBar(task, extent);
  useEffect(() => {
    if (editing) nameField.current?.focus();
    else if (focusEditButton.current) {
      focusEditButton.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  return <tr data-testid="taoffice-project-task" data-uid={task.uid} data-summary={task.summary}>
    <th scope="row" style={{ paddingInlineStart: Math.max(0, Math.min(task.outline - 1, 8)) * 12 + 8 }}>
      {editing ? <input ref={nameField} type="text" className="taomni-input" data-testid="taoffice-project-task-name"
        aria-label={label("任务名称", "Task name")} aria-invalid={!input.trim()}
        maxLength={MAX_TASK_NAME} value={input} onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || (event.key !== "Enter" && event.key !== "Escape")) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Enter") {
            if (!input.trim()) return;
            draft.edit(task.uid, input, task.name);
          }
          focusEditButton.current = true;
          setEditing(false);
        }} /> : editable ? <button type="button" className="taomni-btn" ref={editButton}
          data-testid="taoffice-project-rename" disabled={draft.saving} title={label("重命名任务", "Rename task")}
          onClick={() => { setInput(name); setEditing(true); }}>{name || label("未命名任务", "Unnamed task")}</button>
        : name || label("未命名任务", "Unnamed task")}
    </th>
    <td>{dateLabel(task.start)}</td>
    <td>{dateLabel(task.finish)}</td>
    <td>{task.progress ? task.progress + "%" : "—"}</td>
    <td>{task.predecessors.join(", ") || "—"}</td>
    <td className="taoffice-project-track">
      {bar && <span className="taoffice-project-bar" data-testid="taoffice-project-bar"
        data-milestone={task.milestone} style={{ left: bar.left + "%", width: task.milestone ? undefined : bar.width + "%" }}
        aria-hidden="true" />}
    </td>
  </tr>;
}
